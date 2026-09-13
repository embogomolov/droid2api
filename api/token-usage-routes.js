import { getLimitState } from '../utils/factory-limits.js';
import express from 'express';
import { adminAuth } from '../middleware/admin-auth.js'; // 🔧 Optimization: use shared authentication middleware
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import keyPoolManager from '../auth.js';
import { logInfo, logError, logDebug } from '../logger.js';
import { batchFetchTokenUsage, fetchTokenUsage } from '../utils/factory-api-client.js';
import { preserveUsageOnFailure } from '../utils/factory-telemetry.js';
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

// Token usage data storage path
const TOKEN_USAGE_FILE = path.join(__dirname, '..', 'data', 'token_usage.json');

// Apply authentication middleware to all token management routes
router.use(adminAuth);

// Cache lifetime in milliseconds: 5 minutes
const CACHE_TTL = 5 * 60 * 1000;

// In-memory cache to avoid frequent file access
let memoryCache = null;
let lastLoadTime = 0;

/**
 * Ensure the data directory exists
 */
function ensureDataDir() {
  const dataDir = path.dirname(TOKEN_USAGE_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    logInfo(`Create the data directory: ${dataDir}`);
  }
}

/**
 * Load token usage data, preferring the in-memory cache
 */
function loadTokenUsageData() {
  const now = Date.now();

  // Check the in-memory cache
  if (memoryCache && (now - lastLoadTime) < 60000) {
    logDebug('Using cached token usage data from memory');
    return memoryCache;
  }

  // Load from a file
  try {
    if (fs.existsSync(TOKEN_USAGE_FILE)) {
      const data = fs.readFileSync(TOKEN_USAGE_FILE, 'utf-8');
      const parsed = JSON.parse(data);

      // Update the in-memory cache
      memoryCache = parsed;
      lastLoadTime = now;

      logDebug(`Loaded token usage data from file for ${Object.keys(parsed.keys || {}).length} keys`);
      return parsed;
    }
  } catch (error) {
    logError('Failed to load token usage data', error);
  }

  // Return an empty structure
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
 * Save token usage data, updating both memory and file caches
 */
function saveTokenUsageData(data) {
  ensureDataDir();

  // Add metadata
  data.meta = {
    cache_ttl: CACHE_TTL,
    last_save: new Date().toISOString()
  };

  // Update the in-memory cache
  memoryCache = data;
  lastLoadTime = Date.now();

  // Write to a file with retries
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 500;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Write to a temporary file, then rename atomically
      const tempPath = TOKEN_USAGE_FILE + '.tmp';
      const jsonData = JSON.stringify(data, null, 2);

      fs.writeFileSync(tempPath, jsonData, 'utf-8');

      // Verify the write
      const written = fs.readFileSync(tempPath, 'utf-8');
      if (written !== jsonData) {
        throw new Error('Write verification failed: file contents do not match');
      }

      // Back up the old file if present
      if (fs.existsSync(TOKEN_USAGE_FILE)) {
        const backupPath = TOKEN_USAGE_FILE + '.bak';
        fs.copyFileSync(TOKEN_USAGE_FILE, backupPath);
      }

      // Rename atomically
      fs.renameSync(tempPath, TOKEN_USAGE_FILE);

      logDebug(`Token usage data saved successfully${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);
      return;

    } catch (error) {
      logError(`Failed to save token usage data (attempt ${attempt + 1}/${MAX_RETRIES})`, error);

      if (attempt < MAX_RETRIES - 1) {
        // Synchronous sleep
        const now = Date.now();
        while (Date.now() - now < RETRY_DELAY) {
          // Busy-wait
        }
      }
    }
  }

  throw new Error(`Token usage data save failed after ${MAX_RETRIES} attempts`);
}

/**
 * Check whether the cache has expired
 */
function isCacheExpired(lastSync) {
  if (!lastSync) return true;
  const age = Date.now() - new Date(lastSync).getTime();
  return age > CACHE_TTL;
}

/**
 * Calculate summary statistics
 */
function calculateSummary(keysData) {
  let total_limit = 0;
  let total_used = 0;
  let total_remaining = 0;
  let successful_keys = 0;

  Object.values(keysData).forEach(keyData => {
    if (keyData.success && keyData.standard) {
      // Use actual field names from the Factory API standard object
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

router.get('/limits', wrapAsync(async (req, res) => {
  const keys = keyPoolManager.keys;
  await Promise.all(keys.map(key => keyPoolManager.refreshBillingLimits(key, req.query.forceRefresh === 'true')));
  sendSuccessResponse(res, { keys: Object.fromEntries(keys.map(key => [key.id, {
    status: key.status, tested: key.last_test_result === 'success',
    standard: getLimitState(key, 'standard'), core: getLimitState(key, 'core'),
    fetchedAt: key.billing_limits?.fetchedAt || null, error: key.limits_error || null
  }])) });
}, 'get Factory usage limits'));

// ========== API routes ==========

/**
 * GET /admin/token/stats
 * Get token usage summary statistics
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
 * Get token usage for all keys with caching
 * Query parameters:
 *   - forceRefresh: boolean - Force cache refresh
 */
router.get('/usage', wrapAsync(async (req, res) => {
  const forceRefresh = req.query.forceRefresh === 'true';
  let data = loadTokenUsageData();

  // Check whether the cache has expired
  const cacheExpired = isCacheExpired(data.summary.last_full_sync);

  if (forceRefresh || cacheExpired) {
    logInfo(`Token usage cache ${cacheExpired ? 'expired' : 'refresh requested'}; starting background synchronization`);

    // Trigger synchronization asynchronously without blocking the current request
    syncTokenUsageInBackground().catch(err => {
      logError('Background token usage synchronization failed', err);
    });

    // If the cache is completely empty, wait for synchronization
    if (Object.keys(data.keys).length === 0) {
      logInfo('Loading token usage for the first time; waiting for synchronization...');
      try {
        await syncTokenUsageInBackground();
        data = loadTokenUsageData();
      } catch (error) {
        logError('Initial token usage synchronization failed', error);
        return sendErrorResponse(res, 500, 'Failed to synchronize token usage: ' + error.message);
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
 * Get token usage for a single key
 * Query parameters:
 *   - forceRefresh: boolean - Force refresh
 */
router.get('/usage/:keyId', wrapAsync(async (req, res) => {
  const { keyId } = req.params;
  const forceRefresh = req.query.forceRefresh === 'true';

  // Get key information
  let keyObj;
  try {
    keyObj = keyPoolManager.getKey(keyId);
  } catch (error) {
    return sendBadRequest(res, `Key does not exist: ${keyId}`);
  }

  // Check the cache
  const data = loadTokenUsageData();
  const cachedData = data.keys[keyId];

  if (!forceRefresh && cachedData && !isCacheExpired(cachedData.last_sync)) {
    logDebug(`Using cached token usage: ${keyId}`);
    return sendSuccessResponse(res, {
      ...cachedData,
      from_cache: true
    });
  }

  // Query live data
  logInfo(`Querying token usage for key ${keyId}...`);

  try {
    const usage = await fetchTokenUsage(keyObj.key);

    if (!usage.success) {
      data.keys[keyId] = preserveUsageOnFailure(cachedData, usage.message);
      saveTokenUsageData(data);
      logError(`Failed to query token usage for key ${keyId}`, usage);
      return sendErrorResponse(res, 500, usage.message || 'Factory API call failed', usage);
    }

    // Update the cache
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
    logError(`Error querying token usage for key ${keyId}`, error);
    sendErrorResponse(res, 500, 'Query failed: ' + error.message);
  }
}, 'get single key token usage'));

/**
 * POST /admin/token/sync
 * Force token usage synchronization for all keys
 * This operation can take time; the client should display progress
 */
router.post('/sync', wrapAsync(async (req, res) => {
  logInfo('Starting forced token usage synchronization for all keys...');

  // Get all keys
  const allKeys = keyPoolManager.keys.map(k => ({
    id: k.id,
    key: k.key,
    status: k.status
  }));

  // Synchronize only active keys
  const activeKeys = allKeys.filter(k => k.status === 'active');

  if (activeKeys.length === 0) {
    return sendBadRequest(res, 'No available keys need synchronization');
  }

  logInfo(`Preparing to synchronize token usage for ${activeKeys.length} active keys`);

  // Query in batches with a progress callback
  let completedCount = 0;
  const results = await batchFetchTokenUsage(activeKeys, {
    concurrency: 10,
    onProgress: (current, total) => {
      completedCount = current;
      logInfo(`Token usage synchronization progress: ${current}/${total}`);
    }
  });

  // Load existing data
  const data = loadTokenUsageData();

  // Update data
  let successCount = 0;
  let failCount = 0;

  results.forEach(result => {
    data.keys[result.id] = result.success ? { ...result, stale: false } : preserveUsageOnFailure(data.keys[result.id], result.message);
    if (result.success) {
      successCount++;
    } else {
      failCount++;
    }
  });

  // Recalculate the summary
  data.summary = calculateSummary(data.keys);

  // Save
  saveTokenUsageData(data);

  logInfo(`Token usage synchronization completed: ${successCount} succeeded, ${failCount} failed`);

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
  }, 'Synchronization completed');
}, 'sync token usage'));

/**
 * GET /admin/token/trend
 * Get token usage trends over 7 days
 * Return usage trends for each key and overall trends
 *
 * Query parameters:
 * - poolGroup: Pool filter (optional)
 * - limit: Result limit (default 10)
 */
router.get('/trend', wrapSync((req, res) => {
  const data = loadTokenUsageData();
  const poolGroupFilter = req.query.poolGroup; // Pool filter
  const limit = parseInt(req.query.limit) || 10; // Return 10 entries by default

  // Get all key information for pool filtering
  const allKeys = keyPoolManager.keys || [];
  const keyIdToPoolMap = {};
  allKeys.forEach(key => {
    keyIdToPoolMap[key.id] = key.pool_group || 'default';
  });

  // Extract usage data for all keys
  let keysData = Object.entries(data.keys || {})
    .filter(([keyId, keyData]) => {
      // Basic data validation
      if (!keyData || !keyData.success || !keyData.standard) {
        return false;
      }
      
      // BaSui: Pool filter
      if (poolGroupFilter) {
        const keyPoolGroup = keyIdToPoolMap[keyId] || 'default';
        if (keyPoolGroup !== poolGroupFilter) {
          return false;
        }
      }
      
      return true;
    })
    .map(([keyId, keyData]) => {
      // Safely get the key string, which may be wrapped in an object
      let keyStr = '';
      if (typeof keyData.key === 'string') {
        keyStr = keyData.key;
      } else if (keyData.key && keyData.key.key) {
        keyStr = keyData.key.key;
      }
      
      // Get pool information
      const poolGroup = keyIdToPoolMap[keyId] || 'default';
      
      return {
        id: keyId,
        key: keyStr.length > 20 ? keyStr.substring(0, 20) + '...' : keyStr,  // Mask sensitive values for display
        pool_group: poolGroup, // BaSui: Add pool information
        used: keyData.standard.orgTotalTokensUsed || 0,
        limit: keyData.standard.totalAllowance || 0,
        remaining: keyData.standard.remaining || 0,
        percentage: keyData.standard.totalAllowance > 0
          ? ((keyData.standard.orgTotalTokensUsed || 0) / keyData.standard.totalAllowance * 100).toFixed(1)
          : 0,
        trialEndDate: keyData.trialEndDate || null
      };
    })
    .sort((a, b) => b.used - a.used);  // Sort by usage in descending order

  // BaSui: Apply the result limit
  const topKeys = keysData.slice(0, limit);

  sendSuccessResponse(res, {
    top_keys: topKeys, // BaSui: Use the limited data
    summary: {
      total_keys: keysData.length, // BaSui: Total keys after filtering
      total_used: (data.summary && data.summary.total_used) || 0,
      total_limit: (data.summary && data.summary.total_limit) || 0,
      total_remaining: (data.summary && data.summary.total_remaining) || 0
    },
    filter: poolGroupFilter ? { poolGroup: poolGroupFilter } : null, // BaSui: Return filter criteria
    last_sync: (data.summary && data.summary.last_full_sync) || null
  });
}, 'get token trend'));

/**
 * GET /admin/token/by-pool
 * Get token usage statistics grouped by pool
 * Return token usage for each pool
 */
router.get('/by-pool', wrapSync((req, res) => {
  const data = loadTokenUsageData();
  
  // Get all key information, including pool grouping
  const allKeys = keyPoolManager.keys || [];
  
  // Aggregate statistics by pool
  const poolStats = {};
  
  allKeys.forEach(key => {
    const poolGroup = key.poolGroup || 'default';
    
    // Initialize pool statistics
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
    
    // Get token usage for this key
    const keyUsageData = data.keys[key.id];
    if (keyUsageData && keyUsageData.success && keyUsageData.standard) {
      poolStats[poolGroup].total_used += keyUsageData.standard.orgTotalTokensUsed || 0;
      poolStats[poolGroup].total_limit += keyUsageData.standard.totalAllowance || 0;
      poolStats[poolGroup].total_remaining += keyUsageData.standard.remaining || 0;
      poolStats[poolGroup].keys_with_data++;
    }
  });
  
  // Calculate usage percentage
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
 * Clear the token usage cache
 */
router.delete('/cache', wrapSync((req, res) => {
  try {
    // Clear the in-memory cache
    memoryCache = null;
    lastLoadTime = 0;

    // Delete the file cache
    if (fs.existsSync(TOKEN_USAGE_FILE)) {
      // Back up before deleting
      const backupPath = TOKEN_USAGE_FILE + '.bak';
      fs.copyFileSync(TOKEN_USAGE_FILE, backupPath);
      fs.unlinkSync(TOKEN_USAGE_FILE);
      logInfo('Token usage cache cleared');
    }

    sendSuccessResponse(res, { message: 'Cache cleared' });
  } catch (error) {
    logError('Failed to clear the token usage cache', error);
    sendErrorResponse(res, 500, 'Failed to clear cache: ' + error.message);
  }
}, 'clear token cache'));

// ========== Background synchronization task ==========

let syncInProgress = false;

/**
 * Synchronize token usage asynchronously in the background
 * Prevent duplicate triggers
 */
async function syncTokenUsageInBackground() {
  if (syncInProgress) {
    logDebug('Token usage synchronization is already running; skipping');
    return;
  }

  syncInProgress = true;

  try {
    logInfo('Starting background token usage synchronization...');

    // Get all active keys
    const activeKeys = keyPoolManager.keys
      .filter(k => k.status === 'active')
      .map(k => ({ id: k.id, key: k.key }));

    if (activeKeys.length === 0) {
      logInfo('No active keys need synchronization');
      return;
    }

    // Query in batches
    const results = await batchFetchTokenUsage(activeKeys, {
      concurrency: 10
    });

    // Load existing data
    const data = loadTokenUsageData();

    // Update data
    results.forEach(result => {
      data.keys[result.id] = result.success ? { ...result, stale: false } : preserveUsageOnFailure(data.keys[result.id], result.message);
    });

    // Recalculate the summary
    data.summary = calculateSummary(data.keys);

    // Save
    saveTokenUsageData(data);

    const successCount = results.filter(r => r.success).length;
    logInfo(`Background token usage synchronization completed: ${successCount}/${results.length} succeeded`);

  } catch (error) {
    logError('Background token usage synchronization failed', error);
    throw error;
  } finally {
    syncInProgress = false;
  }
}

// 🔧 Fix memory leaks by managing timers
let autoSyncInterval = null;

/**
 * Scheduled automatic synchronization every 5 minutes
 * Automatically enabled after server startup
 */
function startAutoSync() {
  const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes

  // Clear any previous timer
  if (autoSyncInterval) {
    clearInterval(autoSyncInterval);
    autoSyncInterval = null;
  }

  logInfo(`Starting automatic token usage synchronization; interval: ${SYNC_INTERVAL / 1000} seconds`);

  autoSyncInterval = setInterval(async () => {
    try {
      const data = loadTokenUsageData();

      // Synchronize only when the cache has expired
      if (isCacheExpired(data.summary.last_full_sync)) {
        logInfo('Token usage cache expired; triggering automatic synchronization');
        await syncTokenUsageInBackground();
      } else {
        logDebug('Token usage cache is still valid; skipping automatic synchronization');
      }
    } catch (error) {
      logError('Token usage automatic synchronization failed', error);
    }
  }, SYNC_INTERVAL);
}

/**
 * Stop automatic synchronization
 */
export function stopAutoSync() {
  if (autoSyncInterval) {
    clearInterval(autoSyncInterval);
    autoSyncInterval = null;
    logInfo('Token usage automatic synchronization stopped');
  }
}

// Clear timers when the process exits
process.on('SIGTERM', stopAutoSync);
process.on('SIGINT', stopAutoSync);
process.on('exit', stopAutoSync);

// Start automatic synchronization at server startup
startAutoSync();

export default router;
