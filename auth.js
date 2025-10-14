import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { logDebug, logError, logInfo, logWarning } from './logger.js';
import { transformToAnthropic, getAnthropicHeaders } from './transformers/request-anthropic.js';
import { getKeyPoolConfig } from './config.js';
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
 * 密钥池管理系统
 * 支持大规模FACTORY_API_KEY轮询使用（无数量限制）
 * 自动封禁402错误的密钥
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
    // BaSui：从config.js加载配置（支持环境变量覆盖）
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

        // 🚀 BaSui：加载多级密钥池配置（poolGroups）
        this.poolGroups = pool.poolGroups || [];

        // BaSui：加载配置，如果没有则使用默认值
    // BaSui：深度合并配置，防止旧版本config覆盖新字段导致undefined！
    if (pool.config) {
      // 合并algorithm
      this.config.algorithm = pool.config.algorithm || this.config.algorithm;

      // 深度合并retry、autoBan、performance（保留默认值）
      this.config.retry = { ...this.config.retry, ...(pool.config.retry || {}) };
      this.config.autoBan = { ...this.config.autoBan, ...(pool.config.autoBan || {}) };
      this.config.performance = { ...this.config.performance, ...(pool.config.performance || {}) };

      // 🚀 BaSui：合并 multiTier 配置（多级密钥池）
      if (pool.config.multiTier) {
        this.config.multiTier = { ...this.config.multiTier, ...pool.config.multiTier };
      }

      // BaSui：保留旧版本的weights字段（向后兼容weighted-score算法）
      if (pool.config.weights) {
        this.config.weights = pool.config.weights;
      }
    }
        logInfo(`Loaded ${this.keys.length} keys from key pool`);
        if (this.poolGroups.length > 0) {
          logInfo(`📊 Multi-tier pool enabled: ${this.poolGroups.length} pool groups`);
        }
        logInfo(`Polling algorithm: ${this.config.algorithm}`);
      } else {
        logInfo('密钥池文件不存在，从空池开始');
        this.saveKeyPool();
      }
    } catch (error) {
      logError('Failed to load key pool', error);
      this.keys = [];
    }
  }

  async saveKeyPool() {
    // 🔧 修复：添加写锁防止并发写入竞态
    if (this.isWriting) {
      // 🔧 修复 BaSui：改用 DEBUG 级别，避免日志污染
      logDebug('[KeyPool] Write in progress, queueing request...');
      await new Promise(resolve => {
        this.writeQueue = this.writeQueue || [];
        this.writeQueue.push(resolve);
      });
    }
    this.isWriting = true;

    // 🔧 修复并发写入竞态条件 - 使用写锁保护
    this.stats.total = this.keys.length;
    this.stats.active = (this.keys || []).filter(k => k.status === 'active').length;
    this.stats.disabled = (this.keys || []).filter(k => k.status === 'disabled').length;
    this.stats.banned = (this.keys || []).filter(k => k.status === 'banned').length;

    const data = {
      keys: this.keys,
      stats: this.stats,
      poolGroups: this.poolGroups,  // 🚀 BaSui：保存多级密钥池配置
      config: this.config
    };

    // 更新待保存数据
    this.pendingSaveData = data;

    // 如果正在写入，加入队列
    if (this.writeLock) {
      return new Promise((resolve, reject) => {
        this.writeQueue.push({ resolve, reject });
      });
    }

    // 执行写入
    return this._performSave();
  
    this.isWriting = false;
    // 处理等待队列
    if (this.writeQueue && this.writeQueue.length > 0) {
      const waiter = this.writeQueue.shift();
      waiter();
    }
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
   * BaSui：同步立即保存（用于关键操作，如测试密钥、删除密钥）
   */
  async saveKeyPoolImmediately() {
    this.stats.total = this.keys.length;
    this.stats.active = (this.keys || []).filter(k => k.status === 'active').length;
    this.stats.disabled = (this.keys || []).filter(k => k.status === 'disabled').length;
    this.stats.banned = (this.keys || []).filter(k => k.status === 'banned').length;

    const data = {
      keys: this.keys,
      stats: this.stats,
      poolGroups: this.poolGroups,  // 🚀 BaSui：保存多级密钥池配置
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
      // 艹，一个测试通过的key都没有，直接报错！
      const totalKeys = this.keys.length;
      const activeButUntestedKeys = (this.keys || []).filter(k => k.status === 'active' && k.last_test_result !== 'success').length;

      throw new Error(
        `密钥池中没有测试通过的可用密钥。` +
        `总密钥数：${totalKeys}，未测试或测试失败的激活密钥：${activeButUntestedKeys}。` +
        `请先在管理面板中测试您的密钥。`
      );
    }

    // 🚀 BaSui：多级密钥池支持！白嫖池用完自动降级到主力池！
    // 如果启用了多级池功能，先按优先级筛选密钥
    if (this.config.multiTier?.enabled) {
      activeKeys = this._filterKeysByPoolPriority(activeKeys);

      if (activeKeys.length === 0) {
        throw new Error('所有密钥池都没有可用密钥了！请检查密钥状态或添加新密钥。');
      }
    }

    let keyObj;

    // BaSui：根据配置的算法选择密钥
    switch (this.config.algorithm) {
      case 'weighted-score':
        // 加权评分算法：基于多个因素的综合评分选择最优密钥
        keyObj = await this.selectKeyByWeight(activeKeys);
        break;

      case 'least-token-used':
        // 🎓 新算法：最少Token使用量算法
        // 优先选择已使用Token最少的密钥，实现Token用量均衡
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
        // 🚀 高级算法：时间窗口
        // 基于最近N小时使用量选择
        keyObj = await selectKeyByTimeWindow(
          activeKeys,
          this.saveKeyPool.bind(this),
          this.keys,
          this.config
        );
        break;

      case 'random':
        // 随机算法：从可用密钥中随机选择
        const randomIndex = Math.floor(Math.random() * activeKeys.length);
        keyObj = activeKeys[randomIndex];
        logDebug(`Using random key: ${keyObj.id} [${randomIndex + 1}/${activeKeys.length}]`);
        break;

      case 'least-used':
        // 最少使用算法：选择使用次数最少的密钥
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

    // BaSui：某些算法已经在内部处理了统计更新，不需要重复处理
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
      logError(`未找到要禁用的密钥：${keyId}`);
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
    logWarning(`🔕 密钥已禁用: ${keyId} - ${reason}`);
    return true;
  }

  banKey(keyId, reason = 'Payment Required - No Credits') {
    const keyIndex = this.keys.findIndex(k => k.id === keyId);
    if (keyIndex === -1) {
      logError(`未找到要封禁的密钥：${keyId}`);
      return false;
    }

    const key = this.keys[keyIndex];
    key.status = 'banned';
    key.banned_at = new Date().toISOString();
    key.banned_reason = reason;
    key.unban_attempts = 0;  // 解封尝试次数

    // 将封禁的密钥移动到banned_keys.json
    this.saveBannedKey(key);
    
    // 从主密钥池中移除
    this.keys.splice(keyIndex, 1);
    this.saveKeyPool();
    
    logInfo(`🚫 密钥已封禁并移动到封禁列表: ${keyId} - ${reason}`);
    return true;
  }

  /**
   * 保存封禁的密钥到banned_keys.json
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
      logError('读取banned_keys.json失败', error);
    }
    
    // 添加封禁的密钥
    bannedData.keys.push(key);
    bannedData.stats.total_banned++;
    
    // 保存到文件
    try {
      fs.writeFileSync(bannedKeysPath, JSON.stringify(bannedData, null, 2), 'utf-8');
    } catch (error) {
      logError('写入banned_keys.json失败', error);
    }
  }
  
  /**
   * 加载封禁的密钥列表
   */
  loadBannedKeys() {
    const bannedKeysPath = path.join(__dirname, 'data', 'banned_keys.json');
    try {
      if (fs.existsSync(bannedKeysPath)) {
        const data = JSON.parse(fs.readFileSync(bannedKeysPath, 'utf-8'));
        return data;
      }
    } catch (error) {
      logError('加载banned_keys.json失败', error);
    }
    return { keys: [], stats: {}, config: {} };
  }
  
  /**
   * 自动解封检查（定时任务调用）
   * 检查被封禁的密钥是否满足解封条件
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
      
      // 检查是否满足解封时间条件
      if (hoursSinceBan >= unbanHours) {
        // 检查解封尝试次数
        if ((key.unban_attempts || 0) < maxAttempts) {
          logInfo(`⏰ 尝试自动解封密钥: ${key.id} (已封禁 ${hoursSinceBan.toFixed(1)} 小时)`);
          
          // 如果配置了重新测试
          if (bannedData.config.retest_on_unban) {
            // 先将密钥加回主池进行测试
            key.status = 'active';
            key.unban_attempts = (key.unban_attempts || 0) + 1;
            this.keys.push(key);
            
            // 测试密钥
            try {
              const testResult = await this.testKey(key.id);
              if (testResult.success) {
                logInfo(`✅ 密钥自动解封成功: ${key.id}`);
                unbannedCount++;
                this.saveKeyPool();
                bannedData.stats.auto_unbanned++;
              } else if (testResult.status === 402) {
                // 还是402错误，继续封禁
                logWarning(`❌ 密钥解封失败(仍然402): ${key.id}`);
                const index = this.keys.findIndex(k => k.id === key.id);
                if (index > -1) {
                  this.keys.splice(index, 1);
                }
                keysToKeep.push(key);
              } else {
                // 其他错误，暂时解封
                logInfo(`⚠️ 密钥解封但状态未知: ${key.id}`);
                unbannedCount++;
                this.saveKeyPool();
                bannedData.stats.auto_unbanned++;
              }
            } catch (error) {
              logError(`密钥测试失败: ${key.id}`, error);
              keysToKeep.push(key);
            }
          } else {
            // 不测试，直接解封
            key.status = 'active';
            delete key.banned_at;
            delete key.banned_reason;
            delete key.unban_attempts;
            this.keys.push(key);
            this.saveKeyPool();
            unbannedCount++;
            bannedData.stats.auto_unbanned++;
            logInfo(`✅ 密钥自动解封(未测试): ${key.id}`);
          }
        } else {
          logDebug(`密钥解封尝试次数已达上限: ${key.id} (${key.unban_attempts}/${maxAttempts})`);
          keysToKeep.push(key);
        }
      } else {
        keysToKeep.push(key);
      }
    }
    
    // 更新封禁列表
    bannedData.keys = keysToKeep;
    bannedData.stats.last_check = now.toISOString();
    
    // 保存更新后的封禁列表
    const bannedKeysPath = path.join(__dirname, 'data', 'banned_keys.json');
    try {
      fs.writeFileSync(bannedKeysPath, JSON.stringify(bannedData, null, 2), 'utf-8');
    } catch (error) {
      logError('更新banned_keys.json失败', error);
    }
    
    if (unbannedCount > 0) {
      logInfo(`🔓 自动解封完成: ${unbannedCount} 个密钥已解封`);
    }
    
    return unbannedCount;
  }
  
  /**
   * 手动解封密钥
   */
  unbanKey(keyId) {
    const bannedData = this.loadBannedKeys();
    const keyIndex = bannedData.keys.findIndex(k => k.id === keyId);
    
    if (keyIndex === -1) {
      throw new Error(`未找到封禁的密钥: ${keyId}`);
    }
    
    const key = bannedData.keys[keyIndex];
    // 恢复密钥到主池
    key.status = 'active';
    delete key.banned_at;
    delete key.banned_reason;
    delete key.unban_attempts;
    
    this.keys.push(key);
    this.saveKeyPool();
    
    // 从封禁列表移除
    bannedData.keys.splice(keyIndex, 1);
    bannedData.stats.manual_unbanned++;
    
    // 保存更新后的封禁列表
    const bannedKeysPath = path.join(__dirname, 'data', 'banned_keys.json');
    try {
      fs.writeFileSync(bannedKeysPath, JSON.stringify(bannedData, null, 2), 'utf-8');
    } catch (error) {
      logError('更新banned_keys.json失败', error);
    }
    
    logInfo(`🔓 密钥已手动解封: ${keyId}`);
    return key;
  }
  
  /**
   * 获取封禁的密钥列表
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

    // 自动识别密钥提供商
    let provider = 'factory';  // 默认为factory（因为当前项目主要使用factory）
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
      provider: provider,  // 添加提供商字段
      poolGroup: poolGroup || 'default',  // 🚀 BaSui：添加密钥池分组字段！
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
      importedKeyIds: [] // BaSui：记录新导入的密钥ID，用于后续自动测试
    };

    keys.forEach((key, index) => {
      const trimmedKey = key.trim();

      if (!trimmedKey) {
        results.invalid++;
        return;
      }

      // 验证密钥格式（支持多种格式）
      const validFormats = ['fk-', 'sk-', 'claude-', 'glm-', 'pk-'];
      const hasValidFormat = validFormats.some(prefix => trimmedKey.startsWith(prefix)) ||
                            trimmedKey.length > 20; // 或者是足够长的密钥

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
        results.importedKeyIds.push(keyObj.id); // BaSui：记录新密钥的ID
      } catch (error) {
        results.errors.push(`Line ${index + 1}: ${error.message}`);
      }
    });

    logInfo(`Batch import completed: ${results.success} success, ${results.duplicate} duplicate, ${results.invalid} invalid (pool: ${poolGroup || 'default'})`);
    return results;
  }

  /**
   * BaSui：自动测试未测试过的密钥（导入时使用）
   * @param {Array<string>} keyIds - 要测试的密钥ID列表（可选，不传则测试所有未测试密钥）
   * @returns {Promise<Object>} 测试结果统计
   */
  async testUntestedKeys(keyIds = null) {
    // BaSui：筛选未测试过的密钥（last_test_at为空的）
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
      logInfo('没有未测试的密钥需要测试');
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

    // BaSui：并发数从配置读取，支持动态调整！默认10个，最大100个（生产环境优化）
    const concurrentLimit = Math.max(1, Math.min(this.config.performance.concurrentLimit || 10, 100));

    logInfo(`Starting auto-test for ${keysToTest.length} untested keys (${concurrentLimit} concurrent)...`);

    for (let i = 0; i < keysToTest.length; i += concurrentLimit) {
      const batch = keysToTest.slice(i, i + concurrentLimit);

      // 并发执行当前批次
      const batchResults = await Promise.allSettled(
        batch.map(key => this.testKey(key.id))
      );

      // 统计结果
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
          // Promise rejected，计为失败
          results.failed++;
          logError('Test key failed with exception', promiseResult.reason);
        }
      });

      // BaSui：批次之间短暂延迟，避免速率限制（1秒）
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
      throw new Error('未找到密钥');
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
      throw new Error('未找到密钥');
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
      throw new Error('未找到密钥');
    }

    key.notes = notes;
    this.saveKeyPool();
    return key;
  }

  async testKey(keyId) {
    const key = (this.keys || []).find(k => k.id === keyId);
    if (!key) {
      throw new Error('未找到密钥');
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
          logInfo(`Retrying key test: ${keyId} (第 ${attempt} 次/最多 ${maxAttempts} 次)`);
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
          // BaSui：🚀 使用 HTTP 连接池（复用 TCP 连接，提升性能）
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
          // BaSui：处理 AbortError - 页面刷新或连接中断时不要崩溃！
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

        // 读取响应体获取详细错误信息
        let responseBody = null;
        let responseText = '';
        try {
          responseText = await response.text();
          responseBody = JSON.parse(responseText);
        } catch (e) {
          // BaSui：处理流错误 - 页面刷新时可能中断读取
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
          // 响应不是JSON格式，使用原始文本
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

        // BaSui：401认证失败，标记为禁用！可能是密钥无效或被撤销了！
        if (response.status === 401) {
          const errorMsg = responseBody?.error?.message || '未授权 - 无效的 API 密钥';
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

        // BaSui：测试成功，不需要重试
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

        // BaSui：其他HTTP错误状态，如果是5xx可能是临时问题，可以重试
        const errorMsg = responseBody?.error?.message || response.statusText || '未知错误';

        // 4xx错误（除了429）是确定性错误，不重试
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

        // 5xx错误可以重试，抛出异常进入重试逻辑
        throw new Error(`Server error ${response.status}: ${errorMsg}`);

      } catch (error) {
        lastError = error;

        if (attempt < maxAttempts) {
          logInfo(`Key test attempt ${attempt} failed: ${error.message}，准备第 ${attempt + 1} 次重试...`);
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

    // BaSui：支持按池过滤测试！如果指定了poolGroup，只测试该池的密钥
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

    // BaSui：并发数优先使用传入参数，否则从配置读取，支持动态调整！默认10个，最大100个（生产环境优化）
    const concurrentLimit = Math.max(1, Math.min(customConcurrency || this.config.performance.concurrentLimit || 10, 100));

    logInfo(`Starting ${sourceLabel} batch test for ${keysToTest.length} keys${poolGroup ? ` in pool '${poolGroup}'` : ''} (${concurrentLimit} concurrent)...`);

    for (let i = 0; i < keysToTest.length; i += concurrentLimit) {
      const batch = keysToTest.slice(i, i + concurrentLimit);

      // 并发执行当前批次
      const batchResults = await Promise.allSettled(
        batch.map(key => this.testKey(key.id))
      );

      // 统计结果
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
          // Promise rejected，计为失败
          results.failed++;
          logError('Test key failed with exception', promiseResult.reason);
        }
      });

      // BaSui：批次之间短暂延迟，避免速率限制（1秒）
      if (i + concurrentLimit < keysToTest.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logInfo(`Batch test completed: ${results.success} success, ${results.failed} failed, ${results.banned} banned`);
    return results;
  }

  /**
   * 获取活动密钥数量（用于重试逻辑）
   */
  getActiveKeyCount() {
    return (this.keys || []).filter(k => 
      k.status === 'active' && k.last_test_result === 'success'
    ).length;
  }
  
  getKeys(page = 1, limit = 10, status = 'all', poolGroup = 'all') {
    let filteredKeys = this.keys;

    // BaSui: 按状态筛选
    if (status !== 'all') {
      filteredKeys = filteredKeys.filter(k => k.status === status);
    }

    // BaSui: 按密钥池筛选
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
      throw new Error('未找到密钥');
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

  // BaSui：配置管理方法
  getConfig() {
    return this.config;
  }

  updateConfig(newConfig) {
    // BaSui：验证配置的合法性
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
    if (newConfig.algorithm && !validAlgorithms.includes(newConfig.algorithm)) {
      throw new Error(`Invalid algorithm. Must be one of: ${validAlgorithms.join(', ')}`);
    }

    if (newConfig.retry) {
      if (typeof newConfig.retry.maxRetries !== 'undefined' && newConfig.retry.maxRetries < 0) {
        throw new Error('maxRetries must be >= 0');
      }
      if (typeof newConfig.retry.retryDelay !== 'undefined' && newConfig.retry.retryDelay < 0) {
        throw new Error('retryDelay must be >= 0');
      }
    }

    // BaSui：合并配置（深度合并）
    if (newConfig.algorithm) {
      this.config.algorithm = newConfig.algorithm;
    }

    if (newConfig.retry) {
      this.config.retry = { ...this.config.retry, ...newConfig.retry };
    }

    if (newConfig.autoBan) {
      this.config.autoBan = { ...this.config.autoBan, ...newConfig.autoBan };
    }

    if (newConfig.performance) {
      this.config.performance = { ...this.config.performance, ...newConfig.performance };
    }

    // 🚀 BaSui：合并多级密钥池配置
    if (newConfig.multiTier) {
      this.config.multiTier = { ...this.config.multiTier, ...newConfig.multiTier };
    }

    this.saveKeyPool();
    logInfo(`Config updated: algorithm=${this.config.algorithm}, multiTier.enabled=${this.config.multiTier?.enabled}`);
    return this.config;
  }

  resetConfig() {
    // BaSui：重置为默认配置
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
      // 🚀 BaSui：多级密钥池默认配置
      multiTier: {
        enabled: false,
        autoFallback: true
      }
    };
    this.saveKeyPool();
    logInfo('Config reset to defaults');
    return this.config;
  }

  // ========== 🚀 BaSui：多级密钥池核心功能（白嫖池 → 主力池自动降级！） ==========

  /**
   * 🎓 BaSui 老师讲解：多级密钥池筛选方法
   *
   * 这个方法是多级密钥池的核心！它会：
   * 1. 从 poolGroups 中按 priority 排序（1 = 最高优先级）
   * 2. 依次筛选每个池子的可用密钥
   * 3. 如果高优先级池子有密钥，直接返回那个池子的密钥
   * 4. 如果高优先级池子没密钥了，自动降级到下一个池子
   * 5. 如果所有池子都没密钥，返回空数组
   *
   * 举例：
   * - 白嫖池（priority 1）有 10 个密钥 → 用白嫖池
   * - 白嫖池用完了 → 自动切换到主力池（priority 2）
   * - 这样你的正经密钥就得到保护了！💰
   *
   * @param {Array} activeKeys - 所有测试通过的可用密钥
   * @returns {Array} - 筛选后的密钥列表（只包含当前应该使用的池子）
   */
  _filterKeysByPoolPriority(activeKeys) {
    // BaSui：如果没有配置 poolGroups，返回所有密钥（降级处理）
    if (!this.poolGroups || this.poolGroups.length === 0) {
      logDebug('未配置密钥池组，使用所有活动密钥');
      return activeKeys;
    }

    // BaSui：按优先级排序（priority 越小优先级越高）
    const sortedGroups = [...this.poolGroups].sort((a, b) => a.priority - b.priority);

    // BaSui：依次尝试每个池子
    for (const group of sortedGroups) {
      // 筛选属于当前池子的密钥
      const poolKeys = activeKeys.filter(k => k.poolGroup === group.id);

      if (poolKeys.length > 0) {
        // 找到有密钥的池子了！
        logInfo(`🎯 多级密钥池：使用 "${group.name}" (优先级 ${group.priority})，可用密钥 ${poolKeys.length} 个`);
        return poolKeys;
      } else {
        // 这个池子没密钥，记录一下并尝试下一个
        logDebug(`Pool "${group.name}" (priority ${group.priority}) has no available keys, trying next...`);
      }
    }

    // BaSui：所有配置的池子都没密钥，检查是否有"未分组"的密钥
    const ungroupedKeys = activeKeys.filter(k => !k.poolGroup || k.poolGroup === 'default');
    if (ungroupedKeys.length > 0) {
      logWarning(`⚠️ 所有配置的池子都没密钥，使用 ${ungroupedKeys.length} 个未分组密钥`);
      return ungroupedKeys;
    }

    // BaSui：真的一个密钥都没了！
    logError('❌ 所有密钥池（包括未分组）都没有可用密钥了！');
    return [];
  }

  /**
   * 🎯 BaSui：获取各池子的统计信息（用于管理面板展示）
   *
   * 返回示例：
   * [
   *   {
   *     id: "freebies",
   *     name: "白嫖池",
   *     priority: 1,
   *     total: 50,
   *     active: 40,
   *     disabled: 5,
   *     banned: 5,
   *     usage_rate: 0.8  // 使用率
   *   },
   *   {
   *     id: "main",
   *     name: "主力池",
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
      // 筛选属于这个池子的密钥
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

  // ========== BaSui：加权轮询和Token统计新功能 ==========

  /**
   * 🎓 老师讲解：加载Token使用量数据（从token-usage-routes.js缓存的数据）
   *
   * 为什么需要这个方法？
   * - token_usage.json 包含每个密钥的真实Token用量
   * - 我们要根据用量来选择密钥，必须先加载这些数据
   *
   * 数据结构：
   * {
   *   "keys": {
   *     "key_xxx": {
   *       "standard": {
   *         "orgTotalTokensUsed": 2051536,  // 已用Token
   *         "remaining": 35948464,           // 剩余Token
   *         "totalAllowance": 38000000       // 总配额
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
        logDebug(`✅ 加载Token使用量数据: ${keysCount} 个密钥`);
        
        // BaSui：详细日志，帮助诊断问题
        if (keysCount === 0) {
          logWarning(`⚠️ token_usage.json 文件存在但 keys 为空！路径: ${tokenUsageFile}`);
        }
        
        return parsed.keys || {};
      } else {
        logWarning(`⚠️ token_usage.json 文件不存在！路径: ${tokenUsageFile}`);
      }
    } catch (error) {
      logError('加载Token使用量数据失败', error);
    }

    // 返回空对象（没有数据时降级处理）
    logDebug('返回空的 Token 使用量数据（降级处理）');
    return {};
  }

  /**
   * 🎓 老师讲解：least-token-used 算法实现
   *
   * 算法目标：选择已使用Token最少的密钥
   *
   * 实现步骤：
   * 1. 加载所有密钥的Token使用量数据
   * 2. 为每个active密钥绑定其Token使用量
   * 3. 按 orgTotalTokensUsed 升序排序
   * 4. 选择第一个（使用量最少的）
   *
   * 边界情况处理：
   * - 如果没有Token使用量数据 → 降级到 round-robin
   * - 如果某个密钥没有统计数据 → 认为它使用量为0（优先选择）
   */
  async selectKeyByTokenUsage(activeKeys) {
    // BaSui：边界检查 - 防止空数组导致 undefined 访问
    if (!activeKeys || activeKeys.length === 0) {
      throw new Error('selectKeyByTokenUsage: activeKeys 为空，无法选择密钥');
    }

    // BaSui：加载Token使用量数据
    const tokenUsageData = this.loadTokenUsageData();
    const dataSize = Object.keys(tokenUsageData).length;

    // BaSui：如果没有统计数据，降级处理（直接选第一个）
    if (dataSize === 0) {
      logWarning(`⚠️ 没有Token使用量数据，降级使用 round-robin 算法（可用密钥数: ${activeKeys.length}）`);
      logInfo('💡 提示：Token 自动同步可能尚未完成，请等待几秒后重试，或在管理面板手动同步');
      const keyObj = activeKeys[0];
      keyObj.usage_count = (keyObj.usage_count || 0) + 1;
      keyObj.last_used_at = new Date().toISOString();
      this.saveKeyPool();
      return keyObj;
    }

    logDebug(`📊 Token使用量数据可用: ${dataSize} 个密钥，当前可选: ${activeKeys.length} 个`);

    // BaSui：为每个密钥绑定Token使用量（如果没有数据则认为是0）
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

    // BaSui：按已使用Token数量升序排序（使用量最少的排在前面）
    keysWithUsage.sort((a, b) => a.token_used - b.token_used);

    // BaSui：选择使用量最少的密钥
    const selectedKey = keysWithUsage[0];

    // BaSui：更新使用统计
    selectedKey.usage_count = (selectedKey.usage_count || 0) + 1;
    selectedKey.last_used_at = new Date().toISOString();

    // BaSui：保存到密钥池
    const originalKey = (this.keys || []).find(k => k.id === selectedKey.id);
    if (originalKey) {
      originalKey.usage_count = selectedKey.usage_count;
      originalKey.last_used_at = selectedKey.last_used_at;
      this.saveKeyPool();
    }

    logInfo(`🎯 least-token-used: 选中密钥 ${selectedKey.id.substring(0, 20)}... (已用Token: ${selectedKey.token_used.toLocaleString()}, 剩余: ${selectedKey.token_remaining.toLocaleString()})`);

    return selectedKey;
  }

  /**
   * 🎓 老师讲解：max-remaining 算法实现
   *
   * 算法目标：选择剩余Token配额最多的密钥
   *
   * 实现步骤：
   * 1. 加载所有密钥的Token使用量数据
   * 2. 为每个active密钥绑定其剩余Token配额
   * 3. 按 remaining 降序排序（剩余最多的排前面）
   * 4. 选择第一个（剩余配额最多的）
   *
   * 适用场景：
   * - 避免密钥耗尽：优先用"富裕"的密钥
   * - 延长密钥生命周期：让接近上限的密钥休息
   */
  async selectKeyByRemaining(activeKeys) {
    // BaSui：边界检查 - 防止空数组导致 undefined 访问
    if (!activeKeys || activeKeys.length === 0) {
      throw new Error('selectKeyByRemaining: activeKeys 为空，无法选择密钥');
    }

    // BaSui：复用数据加载逻辑
    const tokenUsageData = this.loadTokenUsageData();

    // BaSui：降级处理
    if (Object.keys(tokenUsageData).length === 0) {
      logInfo('⚠️ 没有Token使用量数据，降级使用 round-robin 算法');
      const keyObj = activeKeys[0];
      keyObj.usage_count = (keyObj.usage_count || 0) + 1;
      keyObj.last_used_at = new Date().toISOString();
      this.saveKeyPool();
      return keyObj;
    }

    // BaSui：绑定剩余Token数据
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

    // BaSui：按剩余Token降序排序（剩余最多的排前面）
    keysWithUsage.sort((a, b) => b.token_remaining - a.token_remaining);

    // BaSui：选择剩余配额最多的密钥
    const selectedKey = keysWithUsage[0];

    // BaSui：更新使用统计
    selectedKey.usage_count = (selectedKey.usage_count || 0) + 1;
    selectedKey.last_used_at = new Date().toISOString();

    // BaSui：保存到密钥池
    const originalKey = (this.keys || []).find(k => k.id === selectedKey.id);
    if (originalKey) {
      originalKey.usage_count = selectedKey.usage_count;
      originalKey.last_used_at = selectedKey.last_used_at;
      this.saveKeyPool();
    }

    logInfo(`🎯 max-remaining: 选中密钥 ${selectedKey.id.substring(0, 20)}... (剩余Token: ${selectedKey.token_remaining.toLocaleString()}, 使用率: ${(selectedKey.token_used_ratio * 100).toFixed(1)}%)`);

    return selectedKey;
  }

  calculateKeyScore(keyInfo, useCache = true) {
    // BaSui：评分缓存优化 - 5分钟内不重复计算，大幅提升性能！
    const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存
    const now = Date.now();

    // 检查缓存是否有效
    if (useCache && keyInfo.score_cache !== undefined && keyInfo.score_cache_time) {
      const cacheAge = now - keyInfo.score_cache_time;
      if (cacheAge < CACHE_TTL) {
        // 缓存仍然有效，直接返回
        return keyInfo.score_cache;
      }
    }

    // 缓存失效或不存在，重新计算
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

    // BaSui：更新缓存
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

      // BaSui：初始化缓存字段（如果不存在）
      if (typeof key.score_cache === 'undefined') {
        key.score_cache = undefined;
        key.score_cache_time = undefined;
        migrated = true;
      }

      // BaSui：迁移时强制重新计算评分（不使用缓存）
      key.weight_score = this.calculateKeyScore(key, false);
    });

    if (migrated) {
      this.saveKeyPool();
      logInfo('密钥池数据结构升级完成，共 ' + this.keys.length + ' 个密钥');
    }

    return migrated;
  }

  async selectKeyByWeight(activeKeys = null) {
    // BaSui：优先使用传入的activeKeys，如果没有则内部过滤
    const availableKeys = activeKeys || (this.keys || []).filter(k => k.status === 'active' && k.last_test_result === 'success');

    if (availableKeys.length === 0) {
      throw new Error('密钥池中没有可用的密钥。总密钥数：' + this.keys.length + '。请先在管理面板中测试您的密钥。');
    }

    if (availableKeys.length === 1) {
      const key = availableKeys[0];
      // BaSui：单个密钥也使用缓存计算评分
      key.weight_score = this.calculateKeyScore(key, true);
      logInfo('唯一可用密钥 ' + key.id.substring(0, 15) + '...（评分：' + key.weight_score + '）');
      return key;
    }

    // BaSui：使用缓存计算评分，大幅提升性能！
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

    // BaSui：使用后状态变化，清除缓存（下次会重新计算）
    selectedKey.score_cache = undefined;
    selectedKey.score_cache_time = undefined;

    this.saveKeyPool();

    logInfo('选中密钥 ' + selectedKey.id.substring(0, 15) + '...（评分：' + selectedKey.weight_score + '，成功率：' + (selectedKey.success_rate * 100).toFixed(2) + '%）');

    return selectedKey;
  }

  async updateKeyStats(keyId, success) {
    const key = (this.keys || []).find(k => k.id === keyId);
    if (!key) {
      logError('密钥 ' + keyId + ' 未找到，无法更新统计');
      return;
    }

    if (success) {
      key.success_requests = (key.success_requests || 0) + 1;
    } else {
      key.error_count = (key.error_count || 0) + 1;
    }

    key.success_rate = key.total_requests > 0 ? key.success_requests / key.total_requests : 0;

    // BaSui：状态变化了，强制重新计算评分（不使用缓存）
    key.weight_score = this.calculateKeyScore(key, false);

    this.saveKeyPool();

    logDebug('密钥 ' + keyId.substring(0, 15) + '... 统计更新：成功率 ' + (key.success_rate * 100).toFixed(2) + '%，评分 ' + key.weight_score);
  }

  /**
   * 增加密钥的错误计数（用于403等非致命错误）
   * @param {string} keyId - 密钥ID
   */
  incrementErrorCount(keyId) {
    const key = (this.keys || []).find(k => k.id === keyId);
    if (!key) {
      logError(`无法增加错误计数：未找到密钥 ${keyId}`);
      return;
    }
    
    // 增加错误计数
    key.error_count = (key.error_count || 0) + 1;
    key.last_error_at = new Date().toISOString();
    key.total_requests = (key.total_requests || 0) + 1;
    
    // 更新成功率
    key.success_rate = key.total_requests > 0 
      ? (key.success_requests || 0) / key.total_requests 
      : 0;
    
    // BaSui：错误发生后重新计算评分（不使用缓存）
    key.weight_score = this.calculateKeyScore(key, false);
    
    logDebug(`Incremented error count for key ${keyId}: error_count=${key.error_count}, total_requests=${key.total_requests}`);
    this.saveKeyPool();
  }
}

const keyPoolManager = new KeyPoolManager();

export { KeyPoolManager };
export default keyPoolManager;

/**
 * 🚀 BaSui：初始化认证系统（五级优先级架构）
 *
 * 认证优先级（从高到低）：
 * 1️⃣ FACTORY_API_KEY 环境变量（单用户模式）
 * 2️⃣ 密钥池管理（多用户模式，轮询算法）
 * 3️⃣ DROID_REFRESH_KEY 环境变量（OAuth 自动刷新）
 * 4️⃣ data/auth.json / ~/.factory/auth.json（文件认证）
 * 5️⃣ 客户端 Authorization Header（透传模式）
 */
export async function initializeAuth() {
  logInfo('🚀 Initializing authentication system...');

  // BaSui：1️⃣ 检查 FACTORY_API_KEY 环境变量
  const factoryKey = process.env.FACTORY_API_KEY;
  if (factoryKey && factoryKey.trim() !== '') {
    logInfo('✅ FACTORY_API_KEY detected (single-user mode) - Highest priority');
  }

  // BaSui：2️⃣ 初始化密钥池
  keyPoolManager.migrateKeyPoolData();
  const stats = keyPoolManager.getStats();
  logInfo(`✅ Key pool initialized: ${stats.active} active, ${stats.disabled} disabled, ${stats.banned} banned`);

  // BaSui：3️⃣ 初始化 OAuth 认证（DROID_REFRESH_KEY / auth.json）
  await oauthAuthenticator.initialize();

  logInfo('🎉 Authentication system initialized successfully!');
}

/**
 * 🚀 BaSui：获取 API Key（五级认证优先级实现）
 *
 * 这是核心认证函数，按优先级依次尝试：
 * 1️⃣ FACTORY_API_KEY → 2️⃣ 密钥池 → 3️⃣ OAuth → 4️⃣ 文件认证 → 5️⃣ 客户端 Header
 */
export async function getApiKey() {
  // 1️⃣ 最高优先级：FACTORY_API_KEY 环境变量
  const factoryKey = process.env.FACTORY_API_KEY;
  if (factoryKey && factoryKey.trim() !== '') {
    logDebug('Using FACTORY_API_KEY from environment (single-user mode)');
    return `Bearer ${factoryKey.trim()}`;
  }

  // 2️⃣ 次优先级：密钥池管理（如果有可用密钥）
  try {
    const stats = keyPoolManager.getStats();
    if (stats.active > 0) {
      const result = await keyPoolManager.getNextKey();
      logDebug(`Using key from key pool: ${result.keyId}`);
      return `Bearer ${result.key}`;
    }
  } catch (error) {
    // BaSui：密钥池没有可用密钥，继续尝试 OAuth
    logDebug('Key pool not available or empty, trying OAuth authentication...');
  }

  // 3️⃣ 第三优先级：DROID_REFRESH_KEY 或 data/auth.json
  try {
    const oauthKey = await oauthAuthenticator.getOAuthApiKey();
    if (oauthKey) {
      logDebug('Using OAuth authentication (DROID_REFRESH_KEY or auth.json)');
      return `Bearer ${oauthKey}`;
    }
  } catch (error) {
    logError('OAuth authentication failed', error);
  }

  // 4️⃣ 最后兜底：抛出错误（客户端 Authorization 由 middleware 处理）
  throw new Error(
    'No API key available. Please configure one of the following:\n' +
    '  1. FACTORY_API_KEY environment variable (single-user mode)\n' +
    '  2. Add keys to key pool via admin API (/admin/keys/add)\n' +
    '  3. DROID_REFRESH_KEY environment variable (OAuth auto-refresh)\n' +
    '  4. Create data/auth.json or ~/.factory/auth.json (file-based auth)\n' +
    '  5. Provide Authorization header in client request (pass-through mode)'
  );
}
