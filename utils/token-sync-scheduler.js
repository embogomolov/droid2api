/**
 * Automatic token usage synchronization scheduler
 * BaSui: Periodically query the Factory API to synchronize actual token usage.
 * Identify discrepancies between local and provider usage statistics.
 */

import { logInfo, logDebug, logError, logWarn } from '../logger.js';
import { fetchTokenUsage } from './factory-api-client.js';
import { preserveUsageOnFailure } from './factory-telemetry.js';
import keyPoolManager from '../auth.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SYNC_DATA_FILE = path.join(__dirname, '..', 'data', 'token_usage.json');
const DEFAULT_SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MIN_SYNC_INTERVAL = 1 * 60 * 1000; // Minimum: 1 minute
const MAX_SYNC_INTERVAL = 60 * 60 * 1000; // Maximum: 1 hour

let syncIntervalId = null;
let syncInProgress = false;
let lastSyncTime = null;
let syncStats = {
  totalSyncs: 0,
  successfulSyncs: 0,
  failedSyncs: 0,
  lastError: null
};

/**
 * Load cached token usage data.
 * @returns {Object}
 */
function loadSyncData() {
  try {
    if (!fs.existsSync(SYNC_DATA_FILE)) {
      return { keys: {} };
    }
    const data = fs.readFileSync(SYNC_DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    logError('Failed to load the token usage cache', error);
    return { keys: {} };
  }
}

/**
 * Save token usage data to the cache.
 * @param {Object} data
 */
function saveSyncData(data) {
  try {
    const dataDir = path.dirname(SYNC_DATA_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(SYNC_DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    logDebug('Token usage cache saved');
  } catch (error) {
    logError('Failed to save the token usage cache', error);
  }
}

/**
 * Synchronize token usage once by querying the Factory API.
 * @returns {Promise<Object>} Synchronization result
 */
async function performSync() {
  if (syncInProgress) {
    logDebug('Token synchronization is already in progress; skipping this run');
    return { skipped: true };
  }

  syncInProgress = true;
  syncStats.totalSyncs++;

  try {
    logInfo('🔄 Synchronizing token usage from the Factory API...');

    // Get all active keys.
    const allKeys = keyPoolManager.keys;
    const activeKeys = allKeys.filter(k => k.status === 'active');

    if (activeKeys.length === 0) {
      lastSyncTime = new Date();
      logWarn('⚠️ No active keys; skipping synchronization');
      return { skipped: true, reason: 'no_active_keys' };
    }

    logDebug(`Querying token usage for ${activeKeys.length} active keys`);

    // Load the existing cache.
    const syncData = loadSyncData();

    // Query active keys sequentially to limit concurrency.
    let successCount = 0;
    let failCount = 0;

    for (const keyObj of activeKeys) {
      try {
        await keyPoolManager.refreshBillingLimits(keyObj);
        const usage = await fetchTokenUsage(keyObj.key, { timeout: 10000 });

        if (usage.success) {
          syncData.keys[keyObj.id] = { ...usage, stale: false, last_sync: new Date().toISOString() };
          successCount++;
          logDebug(`✅ Key ${keyObj.id.substring(0, 20)}... synchronized successfully`);
        } else {
          failCount++;
          logWarn(`⚠️ Usage query failed for key ${keyObj.id.substring(0, 20)}...: ${usage.message}`);

          // Retain failure information.
          syncData.keys[keyObj.id] = preserveUsageOnFailure(syncData.keys[keyObj.id], usage.message);
        }
      } catch (error) {
        failCount++;
        logError(`❌ Usage query raised an error for key ${keyObj.id.substring(0, 20)}...`, error);

        // Record the error.
        syncData.keys[keyObj.id] = preserveUsageOnFailure(syncData.keys[keyObj.id], error.message);
      }

      // Wait 200 ms between keys to avoid rate limits.
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Save to the cache.
    saveSyncData(syncData);

    lastSyncTime = new Date();
    syncStats.successfulSyncs++;

    logInfo(`✅ Token synchronization complete: ${successCount} succeeded, ${failCount} failed`);

    return {
      success: true,
      successCount,
      failCount,
      totalKeys: activeKeys.length,
      syncTime: lastSyncTime.toISOString()
    };

  } catch (error) {
    syncStats.failedSyncs++;
    syncStats.lastError = error.message;
    logError('❌ Token synchronization failed', error);

    return {
      success: false,
      error: error.message
    };
  } finally {
    syncInProgress = false;
  }
}

/**
 * Start the automatic token synchronization scheduler.
 * @param {Object} options
 * @param {number} options.intervalMs - Synchronization interval in milliseconds
 * @param {boolean} options.immediate - Whether to synchronize immediately
 * @returns {boolean} Whether the scheduler started successfully
 */
export function startTokenSyncScheduler(options = {}) {
  const {
    intervalMs = DEFAULT_SYNC_INTERVAL,
    immediate = true
  } = options;

  // Validate the interval.
  if (intervalMs < MIN_SYNC_INTERVAL || intervalMs > MAX_SYNC_INTERVAL) {
    logWarn(`⚠️ Token synchronization interval must be between ${MIN_SYNC_INTERVAL / 1000}s and ${MAX_SYNC_INTERVAL / 1000}s; using the default of ${DEFAULT_SYNC_INTERVAL / 1000}s`);
    return startTokenSyncScheduler({ ...options, intervalMs: DEFAULT_SYNC_INTERVAL });
  }

  // Stop the existing scheduler before restarting.
  if (syncIntervalId) {
    logWarn('Token synchronization scheduler is already running; stopping the existing scheduler first');
    stopTokenSyncScheduler();
  }

  logInfo(`🚀 Starting automatic token synchronization; interval: ${intervalMs / 1000}s (${Math.floor(intervalMs / 60000)} minutes)`);

  // Synchronize immediately.
  if (immediate) {
    performSync().catch(error => {
      logError('Initial token synchronization failed', error);
    });
  }

  // Set up the timer.
  syncIntervalId = setInterval(() => {
    performSync().catch(error => {
      logError('Scheduled token synchronization failed', error);
    });
  }, intervalMs);

  return true;
}

/**
 * Stop the automatic token synchronization scheduler.
 */
export function stopTokenSyncScheduler() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
    logInfo('🛑 Automatic token synchronization scheduler stopped');
    return true;
  }
  return false;
}

/**
 * Synchronize manually, whether or not the scheduler is running.
 * @returns {Promise<Object>} Synchronization result
 */
export async function triggerManualSync() {
  logInfo('🔄 Starting manual token synchronization...');
  return await performSync();
}

/**
 * Get synchronization status.
 * @returns {Object}
 */
export function getSyncStatus() {
  return {
    isRunning: syncIntervalId !== null,
    inProgress: syncInProgress,
    lastSyncTime: lastSyncTime ? lastSyncTime.toISOString() : null,
    stats: { ...syncStats }
  };
}

/**
 * Get cached token usage data.
 * @param {string} keyId - Key ID (optional)
 * @returns {Object}
 */
export function getCachedTokenUsage(keyId = null) {
  const syncData = loadSyncData();

  if (keyId) {
    return syncData.keys[keyId] || null;
  }

  return syncData;
}

export default {
  startTokenSyncScheduler,
  stopTokenSyncScheduler,
  triggerManualSync,
  getSyncStatus,
  getCachedTokenUsage
};
