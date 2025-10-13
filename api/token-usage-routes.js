import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import keyPoolManager from '../auth.js';
import { logInfo, logError, logDebug } from '../logger.js';
import { batchFetchTokenUsage, fetchTokenUsage } from '../utils/factory-api-client.js';
import {
  sendSuccessResponse,
  sendErrorResponse,
  sendBadRequest,
  wrapAsync,
  wrapSync
} from './admin-error-handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Token使用量数据存储路径
const TOKEN_USAGE_FILE = path.join(__dirname, '..', 'data', 'token_usage.json');

/**
 * 管理后台鉴权中间件
 */
function adminAuth(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  const expectedKey = process.env.ADMIN_ACCESS_KEY;

  if (!expectedKey || expectedKey === 'your-admin-key-here') {
    return res.status(500).json({
      error: 'Admin key not configured',
      message: 'Please set ADMIN_ACCESS_KEY in .env file'
    });
  }

  if (!adminKey || adminKey !== expectedKey) {
    logError('Unauthorized admin access attempt', {
      ip: req.ip,
      headers: req.headers
    });
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid admin access key'
    });
  }

  next();
}

// 应用鉴权中间件到所有Token管理路由
router.use(adminAuth);

// 缓存有效期(毫秒) - 5分钟
const CACHE_TTL = 5 * 60 * 1000;

// 内存缓存(避免频繁读写文件)
let memoryCache = null;
let lastLoadTime = 0;

/**
 * 确保data目录存在
 */
function ensureDataDir() {
  const dataDir = path.dirname(TOKEN_USAGE_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    logInfo(`创建data目录: ${dataDir}`);
  }
}

/**
 * 加载Token使用量数据(优先从内存缓存)
 */
function loadTokenUsageData() {
  const now = Date.now();

  // 检查内存缓存
  if (memoryCache && (now - lastLoadTime) < 60000) {
    logDebug('使用内存缓存的Token使用量数据');
    return memoryCache;
  }

  // 从文件加载
  try {
    if (fs.existsSync(TOKEN_USAGE_FILE)) {
      const data = fs.readFileSync(TOKEN_USAGE_FILE, 'utf-8');
      const parsed = JSON.parse(data);

      // 更新内存缓存
      memoryCache = parsed;
      lastLoadTime = now;

      logDebug(`从文件加载Token使用量数据: ${Object.keys(parsed.keys || {}).length} 个密钥`);
      return parsed;
    }
  } catch (error) {
    logError('加载Token使用量数据失败', error);
  }

  // 返回空结构
  const emptyData = {
    keys: {},
    summary: {
      total_remaining: 0,
      total_used: 0,
      total_limit: 0,
      last_full_sync: null
    },
    meta: {
      cache_ttl: CACHE_TTL,
      last_save: new Date().toISOString()
    }
  };

  memoryCache = emptyData;
  lastLoadTime = now;

  return emptyData;
}

/**
 * 保存Token使用量数据(同时更新内存缓存和文件)
 */
function saveTokenUsageData(data) {
  ensureDataDir();

  // 添加元数据
  data.meta = {
    cache_ttl: CACHE_TTL,
    last_save: new Date().toISOString()
  };

  // 更新内存缓存
  memoryCache = data;
  lastLoadTime = Date.now();

  // 写入文件(带重试机制)
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 500;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // 先写临时文件,再原子重命名
      const tempPath = TOKEN_USAGE_FILE + '.tmp';
      const jsonData = JSON.stringify(data, null, 2);

      fs.writeFileSync(tempPath, jsonData, 'utf-8');

      // 验证写入
      const written = fs.readFileSync(tempPath, 'utf-8');
      if (written !== jsonData) {
        throw new Error('写入验证失败:文件内容不匹配');
      }

      // 备份旧文件(如果存在)
      if (fs.existsSync(TOKEN_USAGE_FILE)) {
        const backupPath = TOKEN_USAGE_FILE + '.bak';
        fs.copyFileSync(TOKEN_USAGE_FILE, backupPath);
      }

      // 原子重命名
      fs.renameSync(tempPath, TOKEN_USAGE_FILE);

      logDebug(`Token使用量数据保存成功${attempt > 0 ? ` (尝试 ${attempt + 1}次)` : ''}`);
      return;

    } catch (error) {
      logError(`保存Token使用量数据失败 (尝试 ${attempt + 1}/${MAX_RETRIES})`, error);

      if (attempt < MAX_RETRIES - 1) {
        // 同步睡眠
        const now = Date.now();
        while (Date.now() - now < RETRY_DELAY) {
          // 忙等待
        }
      }
    }
  }

  throw new Error(`Token使用量数据保存失败(尝试${MAX_RETRIES}次)`);
}

/**
 * 检查缓存是否过期
 */
function isCacheExpired(lastSync) {
  if (!lastSync) return true;
  const age = Date.now() - new Date(lastSync).getTime();
  return age > CACHE_TTL;
}

/**
 * 计算汇总统计
 */
function calculateSummary(keysData) {
  let total_limit = 0;
  let total_used = 0;
  let total_remaining = 0;
  let successful_keys = 0;

  Object.values(keysData).forEach(keyData => {
    if (keyData.success && keyData.standard) {
      // 使用实际的字段名称（来自Factory API的standard对象）
      total_limit += keyData.standard.totalAllowance || 0;
      total_used += keyData.standard.orgTotalTokensUsed || 0;
      total_remaining += keyData.standard.remaining || 0;
      successful_keys++;
    }
  });

  return {
    total_limit,
    total_used,
    total_remaining,
    successful_keys,
    total_keys: Object.keys(keysData).length,
    last_full_sync: new Date().toISOString()
  };
}

// ========== API 路由 ==========

/**
 * GET /admin/token/stats
 * 获取Token使用量汇总统计
 */
router.get('/stats', wrapSync((req, res) => {
  const data = loadTokenUsageData();

  sendSuccessResponse(res, {
    ...data.summary,
    cache_info: {
      cache_ttl: CACHE_TTL,
      last_save: data.meta?.last_save,
      is_expired: isCacheExpired(data.summary.last_full_sync)
    }
  });
}, 'get token stats'));

/**
 * GET /admin/token/usage
 * 获取所有密钥的Token使用量(带缓存)
 * Query参数:
 *   - forceRefresh: boolean - 是否强制刷新缓存
 */
router.get('/usage', wrapAsync(async (req, res) => {
  const forceRefresh = req.query.forceRefresh === 'true';
  let data = loadTokenUsageData();

  // 检查缓存是否过期
  const cacheExpired = isCacheExpired(data.summary.last_full_sync);

  if (forceRefresh || cacheExpired) {
    logInfo(`Token使用量缓存${cacheExpired ? '已过期' : '强制刷新'},触发后台同步`);

    // 异步触发同步(不阻塞当前请求)
    syncTokenUsageInBackground().catch(err => {
      logError('后台同步Token使用量失败', err);
    });

    // 如果缓存完全为空,等待同步完成
    if (Object.keys(data.keys).length === 0) {
      logInfo('首次加载Token使用量,等待同步完成...');
      try {
        await syncTokenUsageInBackground();
        data = loadTokenUsageData();
      } catch (error) {
        logError('首次同步Token使用量失败', error);
        return sendErrorResponse(res, 500, '同步Token使用量失败: ' + error.message);
      }
    }
  }

  sendSuccessResponse(res, {
    keys: data.keys,
    summary: data.summary,
    from_cache: !forceRefresh && !cacheExpired,
    cache_info: {
      cache_ttl: CACHE_TTL,
      last_full_sync: data.summary.last_full_sync,
      is_expired: cacheExpired,
      last_save: data.meta?.last_save
    }
  });
}, 'get token usage'));

/**
 * GET /admin/token/usage/:keyId
 * 获取单个密钥的Token使用量
 * Query参数:
 *   - forceRefresh: boolean - 是否强制刷新
 */
router.get('/usage/:keyId', wrapAsync(async (req, res) => {
  const { keyId } = req.params;
  const forceRefresh = req.query.forceRefresh === 'true';

  // 获取密钥信息
  let keyObj;
  try {
    keyObj = keyPoolManager.getKey(keyId);
  } catch (error) {
    return sendBadRequest(res, `密钥不存在: ${keyId}`);
  }

  // 检查缓存
  const data = loadTokenUsageData();
  const cachedData = data.keys[keyId];

  if (!forceRefresh && cachedData && !isCacheExpired(cachedData.last_sync)) {
    logDebug(`使用缓存的Token使用量: ${keyId}`);
    return sendSuccessResponse(res, {
      ...cachedData,
      from_cache: true
    });
  }

  // 实时查询
  logInfo(`查询密钥 ${keyId} 的Token使用量...`);

  try {
    const usage = await fetchTokenUsage(keyObj.key);

    if (!usage.success) {
      logError(`查询密钥 ${keyId} Token使用量失败`, usage);
      return sendErrorResponse(res, 500, usage.message || 'Factory API调用失败', usage);
    }

    // 更新缓存
    const result = {
      id: keyId,
      key: keyObj.key,
      ...usage,
      last_sync: new Date().toISOString()
    };

    data.keys[keyId] = result;
    data.summary = calculateSummary(data.keys);
    saveTokenUsageData(data);

    sendSuccessResponse(res, {
      ...result,
      from_cache: false
    });

  } catch (error) {
    logError(`查询密钥 ${keyId} Token使用量异常`, error);
    sendErrorResponse(res, 500, '查询失败: ' + error.message);
  }
}, 'get single key token usage'));

/**
 * POST /admin/token/sync
 * 强制同步所有密钥的Token使用量
 * 这是一个长时间运行的操作,建议客户端显示进度
 */
router.post('/sync', wrapAsync(async (req, res) => {
  logInfo('开始强制同步所有密钥的Token使用量...');

  // 获取所有密钥
  const allKeys = keyPoolManager.keys.map(k => ({
    id: k.id,
    key: k.key,
    status: k.status
  }));

  // 只同步active状态的密钥
  const activeKeys = allKeys.filter(k => k.status === 'active');

  if (activeKeys.length === 0) {
    return sendBadRequest(res, '没有可用的密钥需要同步');
  }

  logInfo(`准备同步 ${activeKeys.length} 个active密钥的Token使用量`);

  // 批量查询(带进度回调)
  let completedCount = 0;
  const results = await batchFetchTokenUsage(activeKeys, {
    concurrency: 10,
    onProgress: (current, total) => {
      completedCount = current;
      logInfo(`Token使用量同步进度: ${current}/${total}`);
    }
  });

  // 加载现有数据
  const data = loadTokenUsageData();

  // 更新数据
  let successCount = 0;
  let failCount = 0;

  results.forEach(result => {
    data.keys[result.id] = result;
    if (result.success) {
      successCount++;
    } else {
      failCount++;
    }
  });

  // 重新计算汇总
  data.summary = calculateSummary(data.keys);

  // 保存
  saveTokenUsageData(data);

  logInfo(`Token使用量同步完成: ${successCount} 成功, ${failCount} 失败`);

  sendSuccessResponse(res, {
    total: results.length,
    success: successCount,
    failed: failCount,
    summary: data.summary,
    failed_keys: results.filter(r => !r.success).map(r => ({
      id: r.id,
      error: r.error,
      message: r.message
    }))
  }, '同步完成');
}, 'sync token usage'));

/**
 * GET /admin/token/trend
 * 获取Token使用趋势数据（7天）
 * 返回每个密钥的使用趋势和总体趋势
 * 
 * Query参数:
 * - poolGroup: 密钥池筛选（可选）
 * - limit: 返回数量限制（默认10）
 */
router.get('/trend', wrapSync((req, res) => {
  const data = loadTokenUsageData();
  const poolGroupFilter = req.query.poolGroup; // 密钥池筛选
  const limit = parseInt(req.query.limit) || 10; // 默认返回10条

  // 获取所有密钥信息（用于密钥池筛选）
  const allKeys = keyPoolManager.keys || [];
  const keyIdToPoolMap = {};
  allKeys.forEach(key => {
    keyIdToPoolMap[key.id] = key.pool_group || 'default';
  });

  // 提取所有密钥的使用数据
  let keysData = Object.entries(data.keys || {})
    .filter(([keyId, keyData]) => {
      // 基础数据验证
      if (!keyData || !keyData.success || !keyData.standard) {
        return false;
      }
      
      // BaSui: 密钥池筛选
      if (poolGroupFilter) {
        const keyPoolGroup = keyIdToPoolMap[keyId] || 'default';
        if (keyPoolGroup !== poolGroupFilter) {
          return false;
        }
      }
      
      return true;
    })
    .map(([keyId, keyData]) => {
      // 安全获取密钥字符串（可能是对象）
      let keyStr = '';
      if (typeof keyData.key === 'string') {
        keyStr = keyData.key;
      } else if (keyData.key && keyData.key.key) {
        keyStr = keyData.key.key;
      }
      
      // 获取密钥池信息
      const poolGroup = keyIdToPoolMap[keyId] || 'default';
      
      return {
        id: keyId,
        key: keyStr.length > 20 ? keyStr.substring(0, 20) + '...' : keyStr,  // 脱敏显示
        pool_group: poolGroup, // BaSui: 添加密钥池信息
        used: keyData.standard.orgTotalTokensUsed || 0,
        limit: keyData.standard.totalAllowance || 0,
        remaining: keyData.standard.remaining || 0,
        percentage: keyData.standard.totalAllowance > 0
          ? ((keyData.standard.orgTotalTokensUsed || 0) / keyData.standard.totalAllowance * 100).toFixed(1)
          : 0,
        trialEndDate: keyData.trialEndDate || null
      };
    })
    .sort((a, b) => b.used - a.used);  // 按使用量降序

  // BaSui: 应用数量限制
  const topKeys = keysData.slice(0, limit);

  sendSuccessResponse(res, {
    top_keys: topKeys, // BaSui: 使用限制后的数据
    summary: {
      total_keys: keysData.length, // BaSui: 筛选后的密钥总数
      total_used: (data.summary && data.summary.total_used) || 0,
      total_limit: (data.summary && data.summary.total_limit) || 0,
      total_remaining: (data.summary && data.summary.total_remaining) || 0
    },
    filter: poolGroupFilter ? { poolGroup: poolGroupFilter } : null, // BaSui: 返回筛选条件
    last_sync: (data.summary && data.summary.last_full_sync) || null
  });
}, 'get token trend'));

/**
 * GET /admin/token/by-pool
 * 获取按密钥池分组的Token使用量统计
 * 返回每个密钥池的Token使用情况
 */
router.get('/by-pool', wrapSync((req, res) => {
  const data = loadTokenUsageData();
  
  // 获取所有密钥信息（包括密钥池分组）
  const allKeys = keyPoolManager.keys || [];
  
  // 按密钥池分组统计
  const poolStats = {};
  
  allKeys.forEach(key => {
    const poolGroup = key.poolGroup || 'default';
    
    // 初始化池子统计
    if (!poolStats[poolGroup]) {
      poolStats[poolGroup] = {
        id: poolGroup,
        total_used: 0,
        total_limit: 0,
        total_remaining: 0,
        keys_with_data: 0,
        total_keys: 0
      };
    }
    
    poolStats[poolGroup].total_keys++;
    
    // 获取该密钥的Token使用数据
    const keyUsageData = data.keys[key.id];
    if (keyUsageData && keyUsageData.success && keyUsageData.standard) {
      poolStats[poolGroup].total_used += keyUsageData.standard.orgTotalTokensUsed || 0;
      poolStats[poolGroup].total_limit += keyUsageData.standard.totalAllowance || 0;
      poolStats[poolGroup].total_remaining += keyUsageData.standard.remaining || 0;
      poolStats[poolGroup].keys_with_data++;
    }
  });
  
  // 计算使用百分比
  Object.values(poolStats).forEach(pool => {
    if (pool.total_limit > 0) {
      pool.percentage = ((pool.total_used / pool.total_limit) * 100).toFixed(1);
    } else {
      pool.percentage = '0.0';
    }
  });
  
  sendSuccessResponse(res, {
    pools: poolStats,
    total_pools: Object.keys(poolStats).length,
    cache_info: {
      last_sync: data.summary.last_full_sync,
      is_expired: isCacheExpired(data.summary.last_full_sync)
    }
  });
}, 'get token usage by pool'));

/**
 * DELETE /admin/token/cache
 * 清除Token使用量缓存
 */
router.delete('/cache', wrapSync((req, res) => {
  try {
    // 清除内存缓存
    memoryCache = null;
    lastLoadTime = 0;

    // 删除文件缓存
    if (fs.existsSync(TOKEN_USAGE_FILE)) {
      // 备份后删除
      const backupPath = TOKEN_USAGE_FILE + '.bak';
      fs.copyFileSync(TOKEN_USAGE_FILE, backupPath);
      fs.unlinkSync(TOKEN_USAGE_FILE);
      logInfo('Token使用量缓存已清除');
    }

    sendSuccessResponse(res, { message: '缓存已清除' });
  } catch (error) {
    logError('清除Token使用量缓存失败', error);
    sendErrorResponse(res, 500, '清除缓存失败: ' + error.message);
  }
}, 'clear token cache'));

// ========== 后台同步任务 ==========

let syncInProgress = false;

/**
 * 后台异步同步Token使用量
 * 避免重复触发
 */
async function syncTokenUsageInBackground() {
  if (syncInProgress) {
    logDebug('Token使用量同步任务已在进行中,跳过');
    return;
  }

  syncInProgress = true;

  try {
    logInfo('后台同步Token使用量开始...');

    // 获取所有active密钥
    const activeKeys = keyPoolManager.keys
      .filter(k => k.status === 'active')
      .map(k => ({ id: k.id, key: k.key }));

    if (activeKeys.length === 0) {
      logInfo('没有active密钥需要同步');
      return;
    }

    // 批量查询
    const results = await batchFetchTokenUsage(activeKeys, {
      concurrency: 10
    });

    // 加载现有数据
    const data = loadTokenUsageData();

    // 更新数据
    results.forEach(result => {
      data.keys[result.id] = result;
    });

    // 重新计算汇总
    data.summary = calculateSummary(data.keys);

    // 保存
    saveTokenUsageData(data);

    const successCount = results.filter(r => r.success).length;
    logInfo(`后台同步Token使用量完成: ${successCount}/${results.length} 成功`);

  } catch (error) {
    logError('后台同步Token使用量失败', error);
    throw error;
  } finally {
    syncInProgress = false;
  }
}

/**
 * 定时自动同步(每5分钟)
 * 服务器启动后自动开启
 */
function startAutoSync() {
  const SYNC_INTERVAL = 5 * 60 * 1000; // 5分钟

  logInfo(`启动Token使用量自动同步,间隔: ${SYNC_INTERVAL / 1000} 秒`);

  setInterval(async () => {
    try {
      const data = loadTokenUsageData();

      // 只有缓存过期时才同步
      if (isCacheExpired(data.summary.last_full_sync)) {
        logInfo('Token使用量缓存已过期,触发自动同步');
        await syncTokenUsageInBackground();
      } else {
        logDebug('Token使用量缓存仍有效,跳过自动同步');
      }
    } catch (error) {
      logError('Token使用量自动同步失败', error);
    }
  }, SYNC_INTERVAL);
}

// 服务器启动时立即启动自动同步
startAutoSync();

export default router;
