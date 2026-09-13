import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { logDebug, logError, logInfo, logWarning } from './logger.js';
import { transformToAnthropic, getAnthropicHeaders } from './transformers/request-anthropic.js';
import { getKeyPoolConfig, updateConfig as updateFullConfig } from './config.js';
import fetchWithPool from './utils/http-client.js';
import fileWriterManager from './utils/async-file-writer.js';
import redisCache from './utils/redis-cache.js';
import {
  selectKeyByWeightedUsage,
  selectKeyByQuotaAware,
  selectKeyByTimeWindow
} from './utils/advanced-algorithms.js';
import { oauthAuthenticator } from './auth-oauth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Key pool management system
 * Supports round-robin use of large FACTORY_API_KEY pools (no key count limit)
 * Automatically bans keys that return HTTP 402
 */
class KeyPoolManager {
  constructor() {
    this.keyPoolPath = path.join(__dirname, 'data', 'key_pool.json');
    this.keys = [];
    this.poolGroups = [];  // 🚀 BaSui：多级密钥池配置
    // 🔧 修复并发写入竞态条件 - 添加写锁机制
    this.writeLock = false;
    this.writeQueue = [];
    this.pendingSaveData = null;
    this.stats = {
      total: 0,
      active: 0,
      disabled: 0,
      banned: 0,
      last_rotation_index: 0
    };
    // BaSui: Load settings from config.js (supports environment variable overrides)
    this.config = getKeyPoolConfig();
    this.currentKeyId = null;
    this.loadKeyPool();
  }

  generateId() {
    return 'key_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  loadKeyPool() {
    try {
      if (fs.existsSync(this.keyPoolPath)) {
        const data = fs.readFileSync(this.keyPoolPath, 'utf-8');
        const pool = JSON.parse(data);
        this.keys = pool.keys || [];
        this.stats = pool.stats || this.stats;

        // 🚀 BaSui: Load multi-tier key pool configuration (poolGroups)
        this.poolGroups = pool.poolGroups || [];

        // config.json owns settings; key_pool.json owns keys and statistics.
        // Its legacy config snapshot must never override a newer UI save at startup.
        this.config = getKeyPoolConfig();
        logInfo(`Loaded ${this.keys.length} keys from key pool`);
        if (this.poolGroups.length > 0) {
          logInfo(`📊 Multi-tier pool enabled: ${this.poolGroups.length} pool groups`);
        }
        logInfo(`Polling algorithm: ${this.config.algorithm}`);
      } else {
        logInfo('Key pool file does not exist; starting with an empty pool');
        this.saveKeyPool();
      }
    } catch (error) {
      logError('Failed to load key pool', error);
      this.keys = [];
    }
  }

  async saveKeyPool() {
    this.stats.total = this.keys.length;
    this.stats.active = this.keys.filter(k => k.status === 'active').length;
    this.stats.disabled = this.keys.filter(k => k.status === 'disabled').length;
    this.stats.banned = this.keys.filter(k => k.status === 'banned').length;

    // The shared writer owns debouncing and serialization; no second lock/queue.
    return fileWriterManager.getWriter(this.keyPoolPath).write({
      keys: this.keys,
      stats: this.stats,
      poolGroups: this.poolGroups,
      config: this.config
    }).catch(error => logError('Failed to save the key pool', error));
  }

  async _performSave() {
    if (!this.pendingSaveData) return;

    this.writeLock = true;
    const dataToSave = this.pendingSaveData;
    this.pendingSaveData = null;

    try {
      // BaSui：获取全局异步写入器（单例模式）
      const writer = fileWriterManager.getWriter(this.keyPoolPath, {
        debounceTime: 1000,  // 1秒内的多次写入合并为一次
        maxRetries: 3,       // 失败重试3次
        retryDelay: 500      // 重试延迟500ms
      });

      // 异步写入
      await writer.write(dataToSave);
      logDebug('Key pool saved successfully');

      // 处理队列中的请求
      const queue = this.writeQueue;
      this.writeQueue = [];
      queue.forEach(({ resolve }) => resolve());
    } catch (error) {
      logError('密钥池保存失败', error);
      
      // 处理队列中的请求（通知失败）
      const queue = this.writeQueue;
      this.writeQueue = [];
      queue.forEach(({ reject }) => reject(error));
    } finally {
      this.writeLock = false;

      // 如果还有新的待保存数据，继续保存
      if (this.pendingSaveData) {
        this._performSave();
      }
    }
  }

  /**
   * BaSui: Save immediately without debouncing (for critical operations such as testing or deleting keys)
   */
  async saveKeyPoolImmediately() {
    this.stats.total = this.keys.length;
    this.stats.active = (this.keys || []).filter(k => k.status === 'active').length;
    this.stats.disabled = (this.keys || []).filter(k => k.status === 'disabled').length;
    this.stats.banned = (this.keys || []).filter(k => k.status === 'banned').length;

    const data = {
      keys: this.keys,
      stats: this.stats,
      poolGroups: this.poolGroups,  // 🚀 BaSui: Save multi-tier key pool configuration
      config: this.config
    };

    const writer = fileWriterManager.getWriter(this.keyPoolPath);
    await writer.writeImmediately(data);
    logDebug('Key pool saved immediately');
  }

  async getNextKey() {
    // BaSui：只选用测试通过成功的key，没有就直接报错，简单粗暴！
    let activeKeys = (this.keys || []).filter(k =>
      k.status === 'active' && k.last_test_result === 'success'
    );

    if (activeKeys.length === 0) {
      // No successfully tested keys are available; fail immediately!
      const totalKeys = this.keys.length;
      const activeButUntestedKeys = (this.keys || []).filter(k => k.status === 'active' && k.last_test_result !== 'success').length;

      throw new Error(
        `No available keys in the pool have passed testing. ` +
        `Total keys: ${totalKeys}; active keys that are untested or failed testing: ${activeButUntestedKeys}. ` +
        `Test your keys in the admin panel first.`
      );
    }

    // 🚀 BaSui：多级密钥池支持！白嫖池用完自动降级到主力池！
    // 如果启用了多级池功能，先按优先级筛选密钥
    if (this.config.multiTier?.enabled) {
      activeKeys = this._filterKeysByPoolPriority(activeKeys);

      if (activeKeys.length === 0) {
        throw new Error('No keys are available in any pool. Check key status or add new keys.');
      }
    }

    let keyObj;

    // BaSui: Select a key using the configured algorithm
    switch (this.config.algorithm) {
      case 'weighted-score':
        // Weighted-score algorithm: select a key using a score based on multiple factors
        keyObj = await this.selectKeyByWeight(activeKeys);
        break;

      case 'least-token-used':
        // 🎓 New algorithm: least tokens used
        // Prefer the key with the lowest token usage to distribute token consumption evenly
        keyObj = await this.selectKeyByTokenUsage(activeKeys);
        break;

      case 'max-remaining':
        // 🎓 新算法：最大剩余配额算法
        // 优先选择剩余Token最多的密钥，避免密钥耗尽
        keyObj = await this.selectKeyByRemaining(activeKeys);
        break;

      case 'weighted-usage':
        // 🚀 高级算法：加权综合评分
        // 综合考虑剩余Token(40%)、使用率(30%)、成功率(30%)
        keyObj = await selectKeyByWeightedUsage(
          activeKeys,
          this.loadTokenUsageData.bind(this),
          this.saveKeyPool.bind(this),
          this.keys
        );
        break;

      case 'quota-aware':
        // 🚀 高级算法：配额感知
        // 自动跳过达到配额上限的密钥
        keyObj = await selectKeyByQuotaAware(
          activeKeys,
          this.loadTokenUsageData.bind(this),
          this.saveKeyPool.bind(this),
          this.keys,
          this.config
        );
        break;

      case 'time-window':
        // 🚀 Advanced algorithm: time window
        // Select based on usage over the last N hours
        keyObj = await selectKeyByTimeWindow(
          activeKeys,
          this.saveKeyPool.bind(this),
          this.keys,
          this.config
        );
        break;

      case 'random':
        // Random algorithm: randomly select an available key
        const randomIndex = Math.floor(Math.random() * activeKeys.length);
        keyObj = activeKeys[randomIndex];
        logDebug(`Using random key: ${keyObj.id} [${randomIndex + 1}/${activeKeys.length}]`);
        break;

      case 'least-used':
        // Least-used algorithm: select the key with the fewest uses
        keyObj = activeKeys.reduce((min, key) =>
          (key.usage_count || 0) < (min.usage_count || 0) ? key : min
        );
        logDebug(`Using least-used key: ${keyObj.id} (usage: ${keyObj.usage_count || 0})`);
        break;

      case 'round-robin':
      default:
        // 轮询算法（默认）：按顺序轮流使用
        const index = this.stats.last_rotation_index % activeKeys.length;
        keyObj = activeKeys[index];
        this.stats.last_rotation_index = (this.stats.last_rotation_index + 1) % activeKeys.length;
        logDebug(`Using round-robin key: ${keyObj.id} [${index + 1}/${activeKeys.length}]`);
        break;
    }

    // BaSui: Some algorithms update statistics internally; avoid updating them twice
    const algorithmsWithInternalStats = [
      'weighted-score',
      'least-token-used',
      'max-remaining',
      'weighted-usage',
      'quota-aware',
      'time-window'
    ];
    if (!algorithmsWithInternalStats.includes(this.config.algorithm)) {
      keyObj.usage_count = (keyObj.usage_count || 0) + 1;
      keyObj.last_used_at = new Date().toISOString();
      this.saveKeyPool();
    }

    this.currentKeyId = keyObj.id;

    return {
      keyId: keyObj.id,
      key: keyObj.key
    };
  }

  disableKey(keyId, reason = 'Key disabled') {
    const key = (this.keys || []).find(k => k.id === keyId);
    if (!key) {
      logError(`Key to disable was not found: ${keyId}`);
      return false;
    }

    const now = new Date().toISOString();
    key.status = 'disabled';
    key.disabled_at = now;
    key.disabled_reason = reason;
    key.last_test_result = 'failed';
    key.error_count = (key.error_count || 0) + 1;
    key.last_error = reason;
    key.disabled_402_count = reason.includes('402')
      ? (key.disabled_402_count || 0) + 1
      : key.disabled_402_count || 0;

    this.saveKeyPool();
    logWarning(`🔕 Key disabled: ${keyId} - ${reason}`);
    return true;
  }

  banKey(keyId, reason = 'Payment Required - No Credits') {
    const keyIndex = this.keys.findIndex(k => k.id === keyId);
    if (keyIndex === -1) {
      logError(`Key to ban was not found: ${keyId}`);
      return false;
    }

    const key = this.keys[keyIndex];
    key.status = 'banned';
    key.banned_at = new Date().toISOString();
    key.banned_reason = reason;
    key.unban_attempts = 0;  // Unban attempt count

    // Move the banned key to banned_keys.json
    this.saveBannedKey(key);
    
    // Remove from the main key pool
    this.keys.splice(keyIndex, 1);
    this.saveKeyPool();
    
    logInfo(`🚫 Key banned and moved to the banned list: ${keyId} - ${reason}`);
    return true;
  }

  /**
   * Save banned keys to banned_keys.json
   */
  saveBannedKey(key) {
    const bannedKeysPath = path.join(__dirname, 'data', 'banned_keys.json');
    let bannedData = {
      keys: [],
      stats: {
        total_banned: 0,
        auto_unbanned: 0, 
        manual_unbanned: 0,
        last_check: null
      },
      config: {
        auto_unban_enabled: true,
        auto_unban_hours: 24,
        retest_on_unban: true,
        max_unban_attempts: 3
      }
    };
    
    try {
      if (fs.existsSync(bannedKeysPath)) {
        bannedData = JSON.parse(fs.readFileSync(bannedKeysPath, 'utf-8'));
      }
    } catch (error) {
      logError('Failed to read banned_keys.json', error);
    }
    
    // Add the banned key
    bannedData.keys.push(key);
    bannedData.stats.total_banned++;
    
    // Save to a file
    try {
      fs.writeFileSync(bannedKeysPath, JSON.stringify(bannedData, null, 2), 'utf-8');
    } catch (error) {
      logError('Failed to write banned_keys.json', error);
    }
  }
  
  /**
   * Load the banned key list
   */
  loadBannedKeys() {
    const bannedKeysPath = path.join(__dirname, 'data', 'banned_keys.json');
    try {
      if (fs.existsSync(bannedKeysPath)) {
        const data = JSON.parse(fs.readFileSync(bannedKeysPath, 'utf-8'));
        return data;
      }
    } catch (error) {
      logError('Failed to load banned_keys.json', error);
    }
    return { keys: [], stats: {}, config: {} };
  }
  
  /**
   * Check for automatic unbanning (called by the scheduled task)
   * Check whether banned keys meet the unban criteria
   */
  async checkAutoUnban() {
    const bannedData = this.loadBannedKeys();
    if (!bannedData.config.auto_unban_enabled) {
      return;
    }
    
    const now = new Date();
    const unbanHours = bannedData.config.auto_unban_hours || 24;
    const maxAttempts = bannedData.config.max_unban_attempts || 3;
    
    let unbannedCount = 0;
    const keysToKeep = [];
    
    for (const key of bannedData.keys) {
      const bannedTime = new Date(key.banned_at);
      const hoursSinceBan = (now - bannedTime) / (1000 * 60 * 60);
      
      // Check whether the required ban duration has elapsed
      if (hoursSinceBan >= unbanHours) {
        // Check the number of unban attempts
        if ((key.unban_attempts || 0) < maxAttempts) {
          logInfo(`⏰ Attempting to unban key automatically: ${key.id} (banned for ${hoursSinceBan.toFixed(1)} hours)`);
          
          // If retesting is configured
          if (bannedData.config.retest_on_unban) {
            // Add the key back to the main pool for testing
            key.status = 'active';
            key.unban_attempts = (key.unban_attempts || 0) + 1;
            this.keys.push(key);
            
            // Test the key
            try {
              const testResult = await this.testKey(key.id);
              if (testResult.success) {
                logInfo(`✅ Key automatically unbanned successfully: ${key.id}`);
                unbannedCount++;
                this.saveKeyPool();
                bannedData.stats.auto_unbanned++;
              } else if (testResult.status === 402) {
                // Still returning HTTP 402; keep the key banned
                logWarning(`❌ Failed to unban key (still HTTP 402): ${key.id}`);
                const index = this.keys.findIndex(k => k.id === key.id);
                if (index > -1) {
                  this.keys.splice(index, 1);
                }
                keysToKeep.push(key);
              } else {
                // Other errors: unban provisionally
                logInfo(`⚠️ Key unbanned, but its status is unknown: ${key.id}`);
                unbannedCount++;
                this.saveKeyPool();
                bannedData.stats.auto_unbanned++;
              }
            } catch (error) {
              logError(`Key test failed: ${key.id}`, error);
              keysToKeep.push(key);
            }
          } else {
            // Unban immediately without testing
            key.status = 'active';
            delete key.banned_at;
            delete key.banned_reason;
            delete key.unban_attempts;
            this.keys.push(key);
            this.saveKeyPool();
            unbannedCount++;
            bannedData.stats.auto_unbanned++;
            logInfo(`✅ Key automatically unbanned (not tested): ${key.id}`);
          }
        } else {
          logDebug(`Maximum number of key unban attempts reached: ${key.id} (${key.unban_attempts}/${maxAttempts})`);
          keysToKeep.push(key);
        }
      } else {
        keysToKeep.push(key);
      }
    }
    
    // Update the banned key list
    bannedData.keys = keysToKeep;
    bannedData.stats.last_check = now.toISOString();
    
    // Save the updated banned key list
    const bannedKeysPath = path.join(__dirname, 'data', 'banned_keys.json');
    try {
      fs.writeFileSync(bannedKeysPath, JSON.stringify(bannedData, null, 2), 'utf-8');
    } catch (error) {
      logError('Failed to update banned_keys.json', error);
    }
    
    if (unbannedCount > 0) {
      logInfo(`🔓 Automatic unban completed: ${unbannedCount} keys unbanned`);
    }
    
    return unbannedCount;
  }
  
  /**
   * Manually unban a key
   */
  unbanKey(keyId) {
    const bannedData = this.loadBannedKeys();
    const keyIndex = bannedData.keys.findIndex(k => k.id === keyId);
    
    if (keyIndex === -1) {
      throw new Error(`Banned key not found: ${keyId}`);
    }
    
    const key = bannedData.keys[keyIndex];
    // Restore the key to the main pool
    key.status = 'active';
    delete key.banned_at;
    delete key.banned_reason;
    delete key.unban_attempts;
    
    this.keys.push(key);
    this.saveKeyPool();
    
    // Remove from the banned key list
    bannedData.keys.splice(keyIndex, 1);
    bannedData.stats.manual_unbanned++;
    
    // Save the updated banned key list
    const bannedKeysPath = path.join(__dirname, 'data', 'banned_keys.json');
    try {
      fs.writeFileSync(bannedKeysPath, JSON.stringify(bannedData, null, 2), 'utf-8');
    } catch (error) {
      logError('Failed to update banned_keys.json', error);
    }
    
    logInfo(`🔓 Key manually unbanned: ${keyId}`);
    return key;
  }
  
  /**
   * Get the banned key list
   */
  getBannedKeys() {
    const bannedData = this.loadBannedKeys();
    return bannedData.keys || [];
  }
  
  getCurrentKeyId() {
    return this.currentKeyId;
  }

  addKey(key, notes = '', poolGroup = null) {
    if ((this.keys || []).find(k => k.key === key)) {
      throw new Error('Key already exists');
    }

    const trimmedKey = key.trim();

    // Automatically identify the key provider
    let provider = 'factory';  // Default to factory (the main provider used by this project is factory)
    if (trimmedKey.startsWith('fk-')) {
      provider = 'factory';
    } else if (trimmedKey.startsWith('sk-')) {
      provider = 'openai';
    } else if (trimmedKey.startsWith('claude-') || trimmedKey.includes('anthropic')) {
      provider = 'anthropic';
    } else if (trimmedKey.startsWith('glm-')) {
      provider = 'glm';
    }

    const keyObj = {
      id: this.generateId(),
      key: trimmedKey,
      provider: provider,  // Add the provider field
      poolGroup: poolGroup || 'default',  // 🚀 BaSui: Add the pool group field!
      status: 'active',
      created_at: new Date().toISOString(),
      last_used_at: null,
      usage_count: 0,
      error_count: 0,
      last_error: null,
      last_test_at: null,
      last_test_result: 'untested',
      banned_at: null,
      banned_reason: null,
      notes: notes || ''
    };

    this.keys.push(keyObj);
    this.saveKeyPool();
    logInfo(`Added new ${provider} key: ${keyObj.id} (pool: ${keyObj.poolGroup})`);
    return keyObj;
  }

  importKeys(keys, poolGroup = null) {
    const results = {
      success: 0,
      duplicate: 0,
      invalid: 0,
      errors: [],
      importedKeyIds: [] // BaSui: Record newly imported key IDs for subsequent automatic testing
    };

    keys.forEach((key, index) => {
      const trimmedKey = key.trim();

      if (!trimmedKey) {
        results.invalid++;
        return;
      }

      // Validate the key format (supports multiple formats)
      const validFormats = ['fk-', 'sk-', 'claude-', 'glm-', 'pk-'];
      const hasValidFormat = validFormats.some(prefix => trimmedKey.startsWith(prefix)) ||
                            trimmedKey.length > 20; // Or any sufficiently long key

      if (!hasValidFormat) {
        results.invalid++;
        results.errors.push(`Line ${index + 1}: Invalid key format`);
        return;
      }

      if ((this.keys || []).find(k => k.key === trimmedKey)) {
        results.duplicate++;
        return;
      }

      try {
        const keyObj = this.addKey(trimmedKey, `Imported at ${new Date().toISOString()}`, poolGroup);
        results.success++;
        results.importedKeyIds.push(keyObj.id); // BaSui: Record the new key ID
      } catch (error) {
        results.errors.push(`Line ${index + 1}: ${error.message}`);
      }
    });

    logInfo(`Batch import completed: ${results.success} success, ${results.duplicate} duplicate, ${results.invalid} invalid (pool: ${poolGroup || 'default'})`);
    return results;
  }

  /**
   * BaSui: Automatically test untested keys (used during import)
   * @param {Array<string>} keyIds - Optional list of key IDs to test; when omitted, test all untested keys
   * @returns {Promise<Object>} Test result statistics
   */
  async testUntestedKeys(keyIds = null) {
    // BaSui: Filter untested keys (those with an empty last_test_at)
    let keysToTest;
    if (keyIds && keyIds.length > 0) {
      keysToTest = (this.keys || []).filter(k => 
        keyIds.includes(k.id) && 
        !k.last_test_at && 
        k.status !== 'banned'
      );
    } else {
      keysToTest = (this.keys || []).filter(k => 
        !k.last_test_at && 
        k.status !== 'banned'
      );
    }

    if (keysToTest.length === 0) {
      logInfo('No untested keys need testing');
      return {
        tested: 0,
        success: 0,
        failed: 0,
        banned: 0
      };
    }

    const results = {
      tested: 0,
      success: 0,
      failed: 0,
      banned: 0
    };

    // BaSui: Read concurrency from settings for dynamic adjustment: default 10, maximum 100 (production optimization)
    const concurrentLimit = Math.max(1, Math.min(this.config.performance.concurrentLimit || 10, 100));

    logInfo(`Starting auto-test for ${keysToTest.length} untested keys (${concurrentLimit} concurrent)...`);

    for (let i = 0; i < keysToTest.length; i += concurrentLimit) {
      const batch = keysToTest.slice(i, i + concurrentLimit);

      // Execute the current batch concurrently
      const batchResults = await Promise.allSettled(
        batch.map(key => this.testKey(key.id))
      );

      // Aggregate results
      batchResults.forEach(promiseResult => {
        results.tested++;

        if (promiseResult.status === 'fulfilled') {
          const result = promiseResult.value;
          if (result.success) {
            results.success++;
          } else {
            results.failed++;
            if (result.key_status === 'banned') {
              results.banned++;
            }
          }
        } else {
          // Promise rejected, Count as a failure
          results.failed++;
          logError('Test key failed with exception', promiseResult.reason);
        }
      });

      // BaSui: Brief delay between batches to avoid rate limits (1 second)
      if (i + concurrentLimit < keysToTest.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logInfo(`Auto-test completed: ${results.success} success, ${results.failed} failed, ${results.banned} banned (402 auto-banned)`);
    return results;
  }

  deleteKey(keyId) {
    const index = this.keys.findIndex(k => k.id === keyId);
    if (index === -1) {
      throw new Error('Key not found');
    }

    const key = this.keys[index];
    this.keys.splice(index, 1);
    this.saveKeyPool();
    logInfo(`Deleted key: ${keyId}`);
    return key;
  }

  toggleKeyStatus(keyId, newStatus) {
    const key = (this.keys || []).find(k => k.id === keyId);
    if (!key) {
      throw new Error('Key not found');
    }

    if (key.status === 'banned' && newStatus === 'active') {
      key.status = 'active';
      key.banned_at = null;
      key.banned_reason = null;
      logInfo(`Key unbanned and activated: ${keyId}`);
    } else {
      key.status = newStatus;
      logInfo(`Key status changed: ${keyId} -> ${newStatus}`);
    }

    this.saveKeyPool();
    return key;
  }

  updateNotes(keyId, notes) {
    const key = (this.keys || []).find(k => k.id === keyId);
    if (!key) {
      throw new Error('Key not found');
    }

    key.notes = notes;
    this.saveKeyPool();
    return key;
  }

  async testKey(keyId) {
    const key = (this.keys || []).find(k => k.id === keyId);
    if (!key) {
      throw new Error('Key not found');
    }

    logInfo(`Testing key: ${keyId}`);

    // BaSui：实现重试机制，网络问题别一次就放弃！
    const retryConfig = this.config.retry;
    const configuredRetries = retryConfig.enabled ? (retryConfig.maxRetries || 0) : 0;
    const maxAttempts = Math.max(1, Math.min(configuredRetries + 1, 3));
    const retryDelay = retryConfig.retryDelay || 1000;

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          logInfo(`Retrying key test: ${keyId} (Attempt ${attempt} of ${maxAttempts})`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }

        const testUrl = 'https://app.factory.ai/api/llm/a/v1/messages';

        // BaSui：复用转换层，别tm重复造轮子！这才是DRY原则
        // 构建OpenAI格式的测试请求
        const openaiRequest = {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 10,
          messages: [
            { role: 'user', content: 'test' }
          ],
          stream: false
        };

        // 使用转换层转换请求格式
        const transformedRequest = transformToAnthropic(openaiRequest);

        // 使用转换层生成完整的headers（包含所有必需的x-*字段）
        const headers = getAnthropicHeaders(
          `Bearer ${key.key}`,  // authHeader
          {},                    // clientHeaders (空对象)
          false,                 // isStreaming
          'claude-sonnet-4-5-20250929'  // modelId
        );

        // BaSui：使用AbortController实现超时控制，node-fetch v3不支持timeout选项！
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        let response;
        try {
          // BaSui: 🚀 Use the HTTP connection pool (reuse TCP connections for better performance)
          response = await fetchWithPool(testUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(transformedRequest),
            signal: controller.signal,
            maxRetries: 1
          });
          clearTimeout(timeoutId);
        } catch (fetchError) {
          clearTimeout(timeoutId);
          // BaSui: Handle AbortError so page reloads or disconnected clients do not crash the process!
          if (fetchError.name === 'AbortError' || fetchError.type === 'aborted') {
            key.last_test_result = 'aborted';
            key.last_error = 'Test aborted (connection reset or timeout)';
            this.saveKeyPool();
            
            return {
              success: false,
              status: 0,
              message: 'Test aborted (connection reset or timeout)',
              key_status: key.status,
              aborted: true
            };
          }
          throw fetchError;
        }

          key.last_test_at = new Date().toISOString();

        // Read the response body for detailed error information
        let responseBody = null;
        let responseText = '';
        try {
          responseText = await response.text();
          responseBody = JSON.parse(responseText);
        } catch (e) {
          // BaSui: Handle stream errors: a page reload may interrupt reading
          if (e.name === 'AbortError' || e.type === 'aborted') {
            key.last_test_result = 'aborted';
            key.last_error = 'Response reading aborted';
            this.saveKeyPool();
            
            return {
              success: false,
              status: 0,
              message: 'Test aborted while reading response',
              key_status: key.status,
              aborted: true
            };
          }
          // Response is not JSON; use the raw text
          responseBody = { raw: responseText };
        }

        // BaSui：402错误是确定性错误，不需要重试，直接封禁并返回
        if (response.status === 402) {
          const errorMsg = responseBody?.error?.message || '余额不足 - 没有额度';
          key.status = 'banned';
          key.banned_at = new Date().toISOString();
          key.banned_reason = errorMsg;
          key.last_test_result = 'failed';
          key.error_count = (key.error_count || 0) + 1;
          key.last_error = `402: ${errorMsg}`;
          this.saveKeyPool();

          logError(`Key test failed (402): ${keyId}`, {
            message: errorMsg,
            fullResponse: responseBody,
            statusCode: response.status,
            statusText: response.statusText
          });

          return {
            success: false,
            status: 402,
            message: `Key banned: ${errorMsg}`,
            key_status: 'banned',
            details: responseBody
          };
        }

        // BaSui: 401 authentication failed; disable the key, which may be invalid or revoked!
        if (response.status === 401) {
          const errorMsg = responseBody?.error?.message || 'Unauthorized - invalid API key';
          key.status = 'disabled';
          key.last_test_result = 'failed';
          key.error_count = (key.error_count || 0) + 1;
          key.last_error = `401: ${errorMsg}`;
          this.saveKeyPool();

          logError(`Key test failed (401): ${keyId}`, {
            message: errorMsg,
            fullResponse: responseBody,
            statusCode: response.status,
            statusText: response.statusText
          });

          return {
            success: false,
            status: 401,
            message: `Key disabled: ${errorMsg}`,
            key_status: 'disabled',
            details: responseBody
          };
        }

        // BaSui: Test succeeded; no retry needed
        if (response.status === 200) {
          key.last_test_result = 'success';
          this.saveKeyPool();

          logInfo(`Key test success: ${keyId} - Status ${response.status}`);
          return {
            success: true,
            status: response.status,
            message: 'Key is valid',
            key_status: key.status
          };
        }

        // BaSui: Other HTTP errors: 5xx errors may be temporary and can be retried
        const errorMsg = responseBody?.error?.message || response.statusText || 'Unknown error';

        // 4xx errors (except 429) are deterministic; do not retry
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          key.status = 'disabled';  // BaSui：非200状态自动禁用密钥！
          key.last_test_result = 'failed';
          key.error_count = (key.error_count || 0) + 1;
          key.last_error = `${response.status}: ${errorMsg}`;
          this.saveKeyPool();

          logError(`Key test failed (${response.status}): ${keyId}`, {
            message: errorMsg,
            fullResponse: responseBody,
            statusCode: response.status,
            statusText: response.statusText
          });

          return {
            success: false,
            status: response.status,
            message: `Test failed: ${errorMsg}`,
            key_status: key.status,
            details: responseBody
          };
        }

        // 5xx errors can be retried; throw to enter retry handling
        throw new Error(`Server error ${response.status}: ${errorMsg}`);

      } catch (error) {
        lastError = error;

        if (attempt < maxAttempts) {
          logInfo(`Key test attempt ${attempt} failed: ${error.message}, Preparing attempt ${attempt + 1}...`);
          continue;
        }

        break;
      }
    }

    const finalErrorMessage = lastError?.message || 'Key test failed';

    // BaSui：测试疯狂撞墙 3 次还不醒，直接BAN！
    key.status = 'banned';
    key.banned_at = new Date().toISOString();
    key.banned_reason = `Auto test failed after ${maxAttempts} attempts`;
    key.last_test_result = 'failed';
    key.error_count = (key.error_count || 0) + 1;
    key.last_error = finalErrorMessage;
    this.saveKeyPool();

    logError(`Key test error after ${maxAttempts} attempts: ${keyId}`, lastError);
    return {
      success: false,
      status: 0,
      message: `Key banned after ${maxAttempts} failed test attempts: ${finalErrorMessage}`,
      key_status: key.status
    };
  }

  async testAllKeys(poolGroup = null, customConcurrency = null, options = {}) {
    const {
      includeDisabled = true,
      sourceLabel = 'manual'
    } = options;

    // BaSui: Support testing by pool: if poolGroup is specified, test only keys in that pool
    let keysToTest = (this.keys || []).filter(k => k.status !== 'banned');

    if (!includeDisabled) {
      keysToTest = keysToTest.filter(k => k.status !== 'disabled');
    }
    
    if (poolGroup) {
      keysToTest = keysToTest.filter(k => k.pool_group === poolGroup);
      logInfo(`Filtering keys for pool group: ${poolGroup}, found ${keysToTest.length} keys`);
    }
    
    const results = {
      total: keysToTest.length,
      tested: 0,
      success: 0,
      failed: 0,
      banned: 0
    };

    // BaSui: Prefer the supplied concurrency, otherwise read settings; adjustable dynamically, default 10, maximum 100 (production optimization)
    const concurrentLimit = Math.max(1, Math.min(customConcurrency || this.config.performance.concurrentLimit || 10, 100));

    logInfo(`Starting ${sourceLabel} batch test for ${keysToTest.length} keys${poolGroup ? ` in pool '${poolGroup}'` : ''} (${concurrentLimit} concurrent)...`);

    for (let i = 0; i < keysToTest.length; i += concurrentLimit) {
      const batch = keysToTest.slice(i, i + concurrentLimit);

      // Execute the current batch concurrently
      const batchResults = await Promise.allSettled(
        batch.map(key => this.testKey(key.id))
      );

      // Aggregate results
      batchResults.forEach(promiseResult => {
        results.tested++;

        if (promiseResult.status === 'fulfilled') {
          const result = promiseResult.value;
          if (result.success) {
            results.success++;
          } else {
            results.failed++;
            if (result.key_status === 'banned') {
              results.banned++;
            }
          }
        } else {
          // Promise rejected, Count as a failure
          results.failed++;
          logError('Test key failed with exception', promiseResult.reason);
        }
      });

      // BaSui: Brief delay between batches to avoid rate limits (1 second)
      if (i + concurrentLimit < keysToTest.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logInfo(`Batch test completed: ${results.success} success, ${results.failed} failed, ${results.banned} banned`);
    return results;
  }

  /**
   * Get the active key count (for retry handling)
   */
  getActiveKeyCount() {
    return (this.keys || []).filter(k => 
      k.status === 'active' && k.last_test_result === 'success'
    ).length;
  }
  
  getKeys(page = 1, limit = 10, status = 'all', poolGroup = 'all') {
    let filteredKeys = this.keys;

    // BaSui: Filter by status
    if (status !== 'all') {
      filteredKeys = filteredKeys.filter(k => k.status === status);
    }

    // BaSui: Filter by pool
    if (poolGroup !== 'all') {
      filteredKeys = filteredKeys.filter(k => (k.poolGroup || 'default') === poolGroup);
    }

    const total = filteredKeys.length;
    const totalPages = Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const end = start + limit;
    const paginatedKeys = filteredKeys.slice(start, end);

    return {
      keys: paginatedKeys,
      pagination: {
        page,
        limit,
        total,
        total_pages: totalPages
      }
    };
  }

  getKey(keyId) {
    const key = (this.keys || []).find(k => k.id === keyId);
    if (!key) {
      throw new Error('Key not found');
    }
    return key;
  }

  getStats() {
    this.stats.total = this.keys.length;
    this.stats.active = (this.keys || []).filter(k => k.status === 'active').length;
    this.stats.disabled = (this.keys || []).filter(k => k.status === 'disabled').length;
    this.stats.banned = (this.keys || []).filter(k => k.status === 'banned').length;

    return this.stats;
  }

  deleteDisabledKeys() {
    const disabledKeys = (this.keys || []).filter(k => k.status === 'disabled');
    const count = disabledKeys.length;

    this.keys = (this.keys || []).filter(k => k.status !== 'disabled');
    this.saveKeyPool();

    logInfo(`Deleted ${count} disabled keys`);
    return count;
  }

  deleteBannedKeys() {
    const bannedKeys = (this.keys || []).filter(k => k.status === 'banned');
    const count = bannedKeys.length;

    this.keys = (this.keys || []).filter(k => k.status !== 'banned');
    this.saveKeyPool();

    logInfo(`Deleted ${count} banned keys`);
    return count;
  }

  // BaSui: Configuration management methods
  getConfig() {
    return this.config;
  }

  updateConfig(newConfig, fullUpdates = {}) {
    if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
      throw new Error('Key pool settings must be an object');
    }
    // BaSui: Validate the configuration
    const validAlgorithms = [
      'round-robin',
      'random',
      'least-used',
      'weighted-score',
      'least-token-used',
      'max-remaining',
      'weighted-usage',
      'quota-aware',
      'time-window'
    ];
    if (newConfig.algorithm !== undefined && !validAlgorithms.includes(newConfig.algorithm)) {
      throw new Error(`Invalid algorithm. Must be one of: ${validAlgorithms.join(', ')}`);
    }

    for (const field of ['retry', 'autoBan', 'performance', 'multiTier', 'weights']) {
      if (newConfig[field] !== undefined && (!newConfig[field] || typeof newConfig[field] !== 'object' || Array.isArray(newConfig[field]))) {
        throw new Error(`${field} must be an object`);
      }
    }

    if (newConfig.retry) {
      if (newConfig.retry.maxRetries !== undefined && (!Number.isInteger(newConfig.retry.maxRetries) || newConfig.retry.maxRetries < 0)) {
        throw new Error('maxRetries must be >= 0');
      }
      if (newConfig.retry.retryDelay !== undefined && (!Number.isFinite(newConfig.retry.retryDelay) || newConfig.retry.retryDelay < 0)) {
        throw new Error('retryDelay must be >= 0');
      }
    }

    // Persist first: failed saves must not change the running selector.
    updateFullConfig({ ...fullUpdates, key_pool: newConfig });
    this.config = getKeyPoolConfig();
    logInfo(`Config updated: algorithm=${this.config.algorithm}, multiTier.enabled=${this.config.multiTier?.enabled}`);
    return this.config;
  }

  resetConfig() {
    // BaSui: Reset to defaults
    this.config = {
      algorithm: 'round-robin',
      retry: {
        enabled: true,
        maxRetries: 3,
        retryDelay: 1000
      },
      autoBan: {
        enabled: true,
        errorThreshold: 5,
        ban402: true,
        ban401: false
      },
      performance: {
        concurrentLimit: 100,
        requestTimeout: 10000
      },
      // 🚀 BaSui: Default multi-tier key pool settings
      multiTier: {
        enabled: false,
        autoFallback: true
      }
    };
    this.saveKeyPool();
    logInfo('Config reset to defaults');
    return this.config;
  }

  // ========== 🚀 BaSui: Core multi-tier pool functionality (automatic fallback from the free-tier pool to the primary pool!) ==========

  /**
   * 🎓 BaSui Explanation: Multi-tier key pool filtering
   *
   * This method is the core of multi-tier key pools. It:
   * 1. Sorts poolGroups by priority (1 = highest priority)
   * 2. Checks available keys in each pool in order
   * 3. Returns keys from the highest-priority pool with available keys
   * 4. Falls back to the next pool when the higher-priority pool has no keys
   * 5. Returns an empty array when no pools have keys
   *
   * Example:
   * - The free-tier pool (priority 1) has 10 keys: use the free-tier pool
   * - The free-tier pool is exhausted: automatically switch to the primary pool (priority 2)
   * - This preserves the quota of your primary keys!💰
   *
   * @param {Array} activeKeys - All available keys that have passed testing
   * @returns {Array} - Filtered key list (only keys from the pool that should currently be used)
   */
  _filterKeysByPoolPriority(activeKeys) {
    // BaSui: If poolGroups is not configured, fall back to all keys
    if (!this.poolGroups || this.poolGroups.length === 0) {
      logDebug('No pool groups configured; using all active keys');
      return activeKeys;
    }

    // BaSui: Sort by priority (lower numbers mean higher priority)
    const sortedGroups = [...this.poolGroups].sort((a, b) => a.priority - b.priority);

    // BaSui: Try each pool in order
    for (const group of sortedGroups) {
      // Filter keys belonging to the current pool
      const poolKeys = activeKeys.filter(k => k.poolGroup === group.id);

      if (poolKeys.length > 0) {
        // Found a pool with keys!
        logInfo(`🎯 Multi-tier pool: using "${group.name}" (priority ${group.priority}), ${poolKeys.length} available keys`);
        return poolKeys;
      } else {
        // This pool has no keys; log it and try the next pool
        logDebug(`Pool "${group.name}" (priority ${group.priority}) has no available keys, trying next...`);
      }
    }

    // BaSui: No configured pools have keys; check for ungrouped keys
    const ungroupedKeys = activeKeys.filter(k => !k.poolGroup || k.poolGroup === 'default');
    if (ungroupedKeys.length > 0) {
      logWarning(`⚠️ No configured pools have keys; using ${ungroupedKeys.length} ungrouped keys`);
      return ungroupedKeys;
    }

    // BaSui: No keys remain anywhere!
    logError('❌ No keys are available in any pool, including ungrouped keys!');
    return [];
  }

  /**
   * 🎯 BaSui: Get statistics for each pool (for the admin panel)
   *
   * Example return value:
   * [
   *   {
   *     id: "freebies",
   *     name: "Free-tier pool",
   *     priority: 1,
   *     total: 50,
   *     active: 40,
   *     disabled: 5,
   *     banned: 5,
   *     usage_rate: 0.8  // Active key ratio
   *   },
   *   {
   *     id: "main",
   *     name: "Primary pool",
   *     priority: 2,
   *     total: 100,
   *     active: 95,
   *     disabled: 3,
   *     banned: 2,
   *     usage_rate: 0.95
   *   }
   * ]
   */
  getPoolGroupStats() {
    if (!this.poolGroups || this.poolGroups.length === 0) {
      return [];
    }

    return this.poolGroups.map(group => {
      // Filter keys belonging to this pool
      const poolKeys = (this.keys || []).filter(k => k.poolGroup === group.id);
      const total = poolKeys.length;
      const active = poolKeys.filter(k => k.status === 'active').length;
      const disabled = poolKeys.filter(k => k.status === 'disabled').length;
      const banned = poolKeys.filter(k => k.status === 'banned').length;

      return {
        ...group,
        total,
        active,
        disabled,
        banned,
        usage_rate: total > 0 ? active / total : 0
      };
    });
  }

  // ========== BaSui: New weighted selection and token statistics features ==========

  /**
   * 🎓 Explanation: Load token usage data (cached by token-usage-routes.js)
   *
   * Why is this method needed?
   * - token_usage.json contains actual token usage for each key
   * - Usage-based key selection requires loading this data first
   *
   * Data structure:
   * {
   *   "keys": {
   *     "key_xxx": {
   *       "standard": {
   *         "orgTotalTokens Used": 2051536,  // UsedToken
   *         "remaining": 35948464,           // Tokens remaining
   *         "totalAllowance": 38000000       // Total allowance
   *       }
   *     }
   *   }
   * }
   */
  loadTokenUsageData() {
    const tokenUsageFile = path.join(__dirname, 'data', 'token_usage.json');

    try {
      if (fs.existsSync(tokenUsageFile)) {
        const data = fs.readFileSync(tokenUsageFile, 'utf-8');
        const parsed = JSON.parse(data);

        const keysCount = Object.keys(parsed.keys || {}).length;
        logDebug(`✅ Loaded token usage data for ${keysCount} keys`);
        
        // BaSui: Detailed logs for diagnostics
        if (keysCount === 0) {
          logWarning(`⚠️ token_usage.json exists but keys is empty. Path: ${tokenUsageFile}`);
        }
        
        return parsed.keys || {};
      } else {
        logWarning(`⚠️ token_usage.json does not exist. Path: ${tokenUsageFile}`);
      }
    } catch (error) {
      logError('Failed to load token usage data', error);
    }

    // Return an empty object (fallback when data is unavailable)
    logDebug('Returning empty token usage data (fallback)');
    return {};
  }

  /**
   * 🎓 Explanation: least-token-used implementation
   *
   * Goal: select the key with the lowest token usage
   *
   * Implementation steps:
   * 1. Load token usage for all keys
   * 2. Associate each active key with its token usage
   * 3. Sort by orgTotalTokensUsed in ascending order
   * 4. Select the first key (lowest usage)
   *
   * Edge cases:
   * - No token usage data: fall back to the first available key
   * - A key has no statistics: treat usage as zero (prefer this key)
   */
  async selectKeyByTokenUsage(activeKeys) {
    // BaSui: Boundary check: prevent undefined access from an empty array
    if (!activeKeys || activeKeys.length === 0) {
      throw new Error('selectKeyByTokenUsage: activeKeys is empty; cannot select a key');
    }

    // BaSui: Load token usage data
    const tokenUsageData = this.loadTokenUsageData();
    const dataSize = Object.keys(tokenUsageData).length;

    // BaSui: If no statistics are available, fall back to selecting the first key
    if (dataSize === 0) {
      logWarning(`⚠️ No token usage data; falling back to the first available key (available keys: ${activeKeys.length})`);
      logInfo('💡 Tip: Automatic token synchronization may still be running. Wait a few seconds and retry, or sync manually in the admin panel');
      const keyObj = activeKeys[0];
      keyObj.usage_count = (keyObj.usage_count || 0) + 1;
      keyObj.last_used_at = new Date().toISOString();
      this.saveKeyPool();
      return keyObj;
    }

    logDebug(`📊 Token usage data available for ${dataSize} keys; currently selectable: ${activeKeys.length}`);

    // BaSui: Associate each key with token usage (assume missing usage is 0)
    const keysWithUsage = activeKeys.map(key => {
      const usageInfo = tokenUsageData[key.id];
      const tokenUsed = usageInfo?.standard?.orgTotalTokensUsed || 0;
      const remaining = usageInfo?.standard?.remaining || 0;

      return {
        ...key,
        token_used: tokenUsed,
        token_remaining: remaining
      };
    });

    // BaSui: Sort by tokens used in ascending order (lowest usage first)
    keysWithUsage.sort((a, b) => a.token_used - b.token_used);

    // BaSui: Select the key with the lowest usage
    const selectedKey = keysWithUsage[0];

    // BaSui: Update usage statistics
    selectedKey.usage_count = (selectedKey.usage_count || 0) + 1;
    selectedKey.last_used_at = new Date().toISOString();

    // BaSui: Save to the key pool
    const originalKey = (this.keys || []).find(k => k.id === selectedKey.id);
    if (originalKey) {
      originalKey.usage_count = selectedKey.usage_count;
      originalKey.last_used_at = selectedKey.last_used_at;
      this.saveKeyPool();
    }

    logInfo(`🎯 least-token-used: selected key ${selectedKey.id.substring(0, 20)}... (tokens used: ${selectedKey.token_used.toLocaleString()}, remaining: ${selectedKey.token_remaining.toLocaleString()})`);

    return selectedKey;
  }

  /**
   * 🎓 Explanation: max-remaining implementation
   *
   * Goal: select the key with the most remaining token quota
   *
   * Implementation steps:
   * 1. Load token usage for all keys
   * 2. Associate each active key with its remaining token quota
   * 3. Sort by remaining in descending order (most remaining first)
   * 4. Select the first key (most remaining quota)
   *
   * Use cases:
   * - Avoid exhausting keys: prefer keys with ample quota
   * - Extend key availability: give keys near their limit a break
   */
  async selectKeyByRemaining(activeKeys) {
    // BaSui: Boundary check: prevent undefined access from an empty array
    if (!activeKeys || activeKeys.length === 0) {
      throw new Error('selectKeyByRemaining: activeKeys is empty; cannot select a key');
    }

    // BaSui: Reuse the data-loading logic
    const tokenUsageData = this.loadTokenUsageData();

    // BaSui: Fallback handling
    if (Object.keys(tokenUsageData).length === 0) {
      logInfo('⚠️ No token usage data; falling back to the first available key');
      const keyObj = activeKeys[0];
      keyObj.usage_count = (keyObj.usage_count || 0) + 1;
      keyObj.last_used_at = new Date().toISOString();
      this.saveKeyPool();
      return keyObj;
    }

    // BaSui: Associate remaining token data
    const keysWithUsage = activeKeys.map(key => {
      const usageInfo = tokenUsageData[key.id];
      const remaining = usageInfo?.standard?.remaining || 0;
      const totalAllowance = usageInfo?.standard?.totalAllowance || 0;
      const usedRatio = usageInfo?.standard?.usedRatio || 0;

      return {
        ...key,
        token_remaining: remaining,
        token_allowance: totalAllowance,
        token_used_ratio: usedRatio
      };
    });

    // BaSui: Sort by remaining tokens in descending order (most remaining first)
    keysWithUsage.sort((a, b) => b.token_remaining - a.token_remaining);

    // BaSui: Select the key with the most remaining quota
    const selectedKey = keysWithUsage[0];

    // BaSui: Update usage statistics
    selectedKey.usage_count = (selectedKey.usage_count || 0) + 1;
    selectedKey.last_used_at = new Date().toISOString();

    // BaSui: Save to the key pool
    const originalKey = (this.keys || []).find(k => k.id === selectedKey.id);
    if (originalKey) {
      originalKey.usage_count = selectedKey.usage_count;
      originalKey.last_used_at = selectedKey.last_used_at;
      this.saveKeyPool();
    }

    logInfo(`🎯 max-remaining: selected key ${selectedKey.id.substring(0, 20)}... (remaining tokens: ${selectedKey.token_remaining.toLocaleString()}, usage rate: ${(selectedKey.token_used_ratio * 100).toFixed(1)}%)`);

    return selectedKey;
  }

  calculateKeyScore(keyInfo, useCache = true) {
    // BaSui: Cache scores for 5 minutes to avoid repeated calculations and improve performance!
    const CACHE_TTL = 5 * 60 * 1000; // 5-minute cache
    const now = Date.now();

    // Check whether the cache is valid
    if (useCache && keyInfo.score_cache !== undefined && keyInfo.score_cache_time) {
      const cacheAge = now - keyInfo.score_cache_time;
      if (cacheAge < CACHE_TTL) {
        // Cache is still valid; return it directly
        return keyInfo.score_cache;
      }
    }

    // Cache is missing or expired; recalculate
    const lastUsed = keyInfo.last_used_at ? new Date(keyInfo.last_used_at).getTime() : now - (24 * 60 * 60 * 1000);
    const hoursSinceLastUse = (now - lastUsed) / (1000 * 60 * 60);

    const weights = { success_rate: 0.6, freshness: 0.3, experience: 0.1 };

    const totalRequests = keyInfo.total_requests || keyInfo.usage_count || 0;
    const successRequests = keyInfo.success_requests || (totalRequests - (keyInfo.error_count || 0));
    const successRate = totalRequests > 0 ? successRequests / totalRequests : 0;
    const successScore = successRate * 100;

    const freshnessScore = Math.max(0, 100 - hoursSinceLastUse * 4);
    const experienceScore = Math.min(100, totalRequests / 10);

    const totalScore = successScore * weights.success_rate + freshnessScore * weights.freshness + experienceScore * weights.experience;
    const roundedScore = Math.round(totalScore * 100) / 100;

    // BaSui: Update the cache
    keyInfo.score_cache = roundedScore;
    keyInfo.score_cache_time = now;

    return roundedScore;
  }

  migrateKeyPoolData() {
    let migrated = false;

    this.keys.forEach(key => {
      if (typeof key.total_requests === 'undefined') {
        key.total_requests = key.usage_count || 0;
        migrated = true;
      }

      if (typeof key.success_requests === 'undefined') {
        key.success_requests = key.total_requests - (key.error_count || 0);
        migrated = true;
      }

      if (typeof key.success_rate === 'undefined' || migrated) {
        key.success_rate = key.total_requests > 0 ? key.success_requests / key.total_requests : 0;
      }

      // BaSui: Initialize cache fields if missing
      if (typeof key.score_cache === 'undefined') {
        key.score_cache = undefined;
        key.score_cache_time = undefined;
        migrated = true;
      }

      // BaSui: Force score recalculation during migration (bypass the cache)
      key.weight_score = this.calculateKeyScore(key, false);
    });

    if (migrated) {
      this.saveKeyPool();
      logInfo('Key pool data structure upgraded: ' + this.keys.length + ' keys');
    }

    return migrated;
  }

  async selectKeyByWeight(activeKeys = null) {
    // BaSui: Prefer supplied activeKeys; otherwise filter internally
    const availableKeys = activeKeys || (this.keys || []).filter(k => k.status === 'active' && k.last_test_result === 'success');

    if (availableKeys.length === 0) {
      throw new Error('No keys are available in the pool. Total keys: ' + this.keys.length + '. Test your keys in the admin panel first.');
    }

    if (availableKeys.length === 1) {
      const key = availableKeys[0];
      // BaSui: Use score caching even for a single key
      key.weight_score = this.calculateKeyScore(key, true);
      logInfo('唯一可用密钥 ' + key.id.substring(0, 15) + '...（评分：' + key.weight_score + '）');
      return key;
    }

    // BaSui: Use cached scores to improve performance!
    availableKeys.forEach(key => { key.weight_score = this.calculateKeyScore(key, true); });

    const totalScore = availableKeys.reduce((sum, k) => sum + (k.weight_score || 1), 0);
    const probabilities = availableKeys.map(k => (k.weight_score || 1) / totalScore);

    const random = Math.random();
    let cumulativeProbability = 0;
    let selectedKey = null;

    for (let i = 0; i < availableKeys.length; i++) {
      cumulativeProbability += probabilities[i];
      if (random <= cumulativeProbability) {
        selectedKey = availableKeys[i];
        break;
      }
    }

    if (!selectedKey) {
      selectedKey = availableKeys[availableKeys.length - 1];
    }

    selectedKey.last_used_at = new Date().toISOString();
    selectedKey.total_requests = (selectedKey.total_requests || 0) + 1;
    selectedKey.usage_count = (selectedKey.usage_count || 0) + 1;

    // BaSui: Usage changes the state; clear the cache for recalculation next time
    selectedKey.score_cache = undefined;
    selectedKey.score_cache_time = undefined;

    this.saveKeyPool();

    logInfo('选中密钥 ' + selectedKey.id.substring(0, 15) + '...（评分：' + selectedKey.weight_score + '，成功率：' + (selectedKey.success_rate * 100).toFixed(2) + '%）');

    return selectedKey;
  }

  async updateKeyStats(keyId, success) {
    const key = (this.keys || []).find(k => k.id === keyId);
    if (!key) {
      logError('Key ' + keyId + ' not found; cannot update statistics');
      return;
    }

    if (success) {
      key.success_requests = (key.success_requests || 0) + 1;
    } else {
      key.error_count = (key.error_count || 0) + 1;
    }

    key.success_rate = key.total_requests > 0 ? key.success_requests / key.total_requests : 0;

    // BaSui: State changed; force score recalculation without the cache
    key.weight_score = this.calculateKeyScore(key, false);

    this.saveKeyPool();

    logDebug('Key ' + keyId.substring(0, 15) + '... statistics updated: success rate ' + (key.success_rate * 100).toFixed(2) + '%, score ' + key.weight_score);
  }

  /**
   * Increment a key error count (for nonfatal errors such as HTTP 403)
   * @param {string} keyId - Key ID
   */
  incrementErrorCount(keyId) {
    const key = (this.keys || []).find(k => k.id === keyId);
    if (!key) {
      logError(`Cannot increment error count: key not found ${keyId}`);
      return;
    }
    
    // Increment the error count
    key.error_count = (key.error_count || 0) + 1;
    key.last_error_at = new Date().toISOString();
    key.total_requests = (key.total_requests || 0) + 1;
    
    // Update the success rate
    key.success_rate = key.total_requests > 0 
      ? (key.success_requests || 0) / key.total_requests 
      : 0;
    
    // BaSui: Recalculate the score after an error (bypass the cache)
    key.weight_score = this.calculateKeyScore(key, false);
    
    logDebug(`Incremented error count for key ${keyId}: error_count=${key.error_count}, total_requests=${key.total_requests}`);
    this.saveKeyPool();
  }
}

const keyPoolManager = new KeyPoolManager();

export { KeyPoolManager };
export default keyPoolManager;

/**
 * 🚀 BaSui: Initialize authentication (five-level priority hierarchy)
 *
 * Authentication priority (highest to lowest):
 * 1️⃣ FACTORY_API_KEY environment variable (single-user mode)
 * 2️⃣ Key pool management (multi-user mode, round-robin selection)
 * 3️⃣ DROID_REFRESH_KEY environment variable (automatic OAuth refresh)
 * 4️⃣ data/auth.json / ~/.factory/auth.json (file-based authentication)
 * 5️⃣ Client Authorization header (pass-through mode)
 */
export async function initializeAuth() {
  logInfo('🚀 Initializing authentication system...');

  // BaSui: 1️⃣ Check the FACTORY_API_KEY environment variable
  const factoryKey = process.env.FACTORY_API_KEY;
  if (factoryKey && factoryKey.trim() !== '') {
    logInfo('✅ FACTORY_API_KEY detected (single-user mode) - Highest priority');
  }

  // BaSui: 2️⃣ Initialize the key pool
  keyPoolManager.migrateKeyPoolData();
  const stats = keyPoolManager.getStats();
  logInfo(`✅ Key pool initialized: ${stats.active} active, ${stats.disabled} disabled, ${stats.banned} banned`);

  // BaSui: 3️⃣ Initialize OAuth authentication (DROID_REFRESH_KEY / auth.json)
  await oauthAuthenticator.initialize();

  logInfo('🎉 Authentication system initialized successfully!');
}

/**
 * 🚀 BaSui: Get an API key (five-level authentication priority implementation)
 *
 * Core authentication function; tries each source in priority order:
 * 1️⃣ FACTORY_API_KEY → 2️⃣ Key pool → 3️⃣ OAuth → 4️⃣ File-based authentication → 5️⃣ Client Header
 */
export async function getApiKey() {
  // 1️⃣ Highest priority: FACTORY_API_KEY environment variable
  const factoryKey = process.env.FACTORY_API_KEY;
  if (factoryKey && factoryKey.trim() !== '') {
    logDebug('Using FACTORY_API_KEY from environment (single-user mode)');
    return `Bearer ${factoryKey.trim()}`;
  }

  // 2️⃣ Second priority: key pool management (when keys are available)
  try {
    const stats = keyPoolManager.getStats();
    if (stats.active > 0) {
      const result = await keyPoolManager.getNextKey();
      logDebug(`Using key from key pool: ${result.keyId}`);
      return `Bearer ${result.key}`;
    }
  } catch (error) {
    // BaSui: No keys are available in the pool; continue with OAuth
    logDebug('Key pool not available or empty, trying OAuth authentication...');
  }

  // 3️⃣ Third priority: DROID_REFRESH_KEY or data/auth.json
  try {
    const oauthKey = await oauthAuthenticator.getOAuthApiKey();
    if (oauthKey) {
      logDebug('Using OAuth authentication (DROID_REFRESH_KEY or auth.json)');
      return `Bearer ${oauthKey}`;
    }
  } catch (error) {
    logError('OAuth authentication failed', error);
  }

  // 4️⃣ Final fallback: throw an error (client Authorization is handled by middleware)
  throw new Error(
    'No API key available. Please configure one of the following:\n' +
    '  1. FACTORY_API_KEY environment variable (single-user mode)\n' +
    '  2. Add keys to key pool via admin API (/admin/keys/add)\n' +
    '  3. DROID_REFRESH_KEY environment variable (OAuth auto-refresh)\n' +
    '  4. Create data/auth.json or ~/.factory/auth.json (file-based auth)\n' +
    '  5. Provide Authorization header in client request (pass-through mode)'
  );
}
