/**
 * 🚀 Advanced key selection algorithms
 *
 * Author: BaSui
 * Version: v1.0.0
 * Last updated: 2025-10-12
 *
 * Includes three advanced selection algorithms:
 * 1. weighted-usage - weighted composite score
 * 2. quota-aware - quota-based selection
 * 3. time-window - usage within a rolling window
 */

import { logInfo, logWarn, logError, logDebug } from '../logger.js';

/**
 * 🎯 Algorithm 1: weighted-usage (weighted composite score)
 *
 * Combines remaining tokens (40%), quota utilization (30%), and request success rate (30%).
 *
 * @param {Array} activeKeys - Available keys
 * @param {Function} loadTokenUsageData - Function that loads token usage data
 * @param {Function} saveKeyPool - Function that saves the key pool
 * @param {Array} allKeys - All keys, used to find the original key object
 * @returns {Object} Selected key object
 */
export async function selectKeyByWeightedUsage(activeKeys, loadTokenUsageData, saveKeyPool, allKeys) {
  // 🔧 Fix: Fall back gracefully instead of throwing an error.
  if (!activeKeys || activeKeys.length === 0) {
    logWarn('selectKeyByWeightedUsage: No available keys; returning null');
    return null;  // Return null for the caller to handle.
  }

  const tokenUsageData = loadTokenUsageData();

  if (Object.keys(tokenUsageData).length === 0) {
    logInfo('⚠️ No token usage data; falling back to the first key');
    const keyObj = activeKeys[0];
    keyObj.usage_count = (keyObj.usage_count || 0) + 1;
    keyObj.last_used_at = new Date().toISOString();
    saveKeyPool();
    return keyObj;
  }

  // Calculate a composite score for each key.
  const keysWithScore = activeKeys.map(key => {
    const usageInfo = tokenUsageData[key.id];

    // Get token usage data.
    const remaining = usageInfo?.standard?.remaining || 0;
    const totalAllowance = usageInfo?.standard?.totalAllowance || 1;
    const usedRatio = usageInfo?.standard?.usedRatio || 0;

    // Get request success data.
    const totalRequests = key.total_requests || key.usage_count || 0;
    const successRequests = key.success_requests || (totalRequests - (key.error_count || 0));
    const successRate = totalRequests > 0 ? successRequests / totalRequests : 1;

    // Calculate component scores on a 0-100 scale.
    const remainingScore = (remaining / totalAllowance) * 100;  // Higher remaining-quota ratios are better.
    const usageScore = (1 - usedRatio) * 100;                   // Lower quota utilization is better.
    const successScore = successRate * 100;                      // Higher success rates are better.

    // Weighted composite score
    const weights = {
      remaining: 0.4,
      usage: 0.3,
      success: 0.3
    };

    const totalScore =
      remainingScore * weights.remaining +
      usageScore * weights.usage +
      successScore * weights.success;

    return {
      ...key,
      token_remaining: remaining,
      token_used_ratio: usedRatio,
      success_rate: successRate,
      weighted_usage_score: Math.round(totalScore * 100) / 100
    };
  });

  // Sort by composite score, highest first.
  keysWithScore.sort((a, b) => b.weighted_usage_score - a.weighted_usage_score);

  // Select the highest-scoring key.
  const selectedKey = keysWithScore[0];

  // Update usage statistics.
  selectedKey.usage_count = (selectedKey.usage_count || 0) + 1;
  selectedKey.last_used_at = new Date().toISOString();

  const originalKey = allKeys.find(k => k.id === selectedKey.id);
  if (originalKey) {
    originalKey.usage_count = selectedKey.usage_count;
    originalKey.last_used_at = selectedKey.last_used_at;
    saveKeyPool();
  }

  logInfo(`🎯 weighted-usage: Selected key ${selectedKey.id.substring(0, 20)}... (score: ${selectedKey.weighted_usage_score}, remaining: ${selectedKey.token_remaining.toLocaleString()}, success rate: ${(selectedKey.success_rate * 100).toFixed(1)}%)`);

  return selectedKey;
}

/**
 * 📊 Algorithm 2: quota-aware (quota-based selection)
 *
 * Apply per-key quota limits and automatically skip keys that reach them.
 *
 * @param {Array} activeKeys - Available keys
 * @param {Function} loadTokenUsageData - Function that loads token usage data
 * @param {Function} saveKeyPool - Function that saves the key pool
 * @param {Array} allKeys - All keys
 * @param {Object} config - Configuration object
 * @returns {Object} Selected key object
 */
export async function selectKeyByQuotaAware(activeKeys, loadTokenUsageData, saveKeyPool, allKeys, config) {
  // 🔧 Fix: Fall back gracefully instead of throwing an error.
  if (!activeKeys || activeKeys.length === 0) {
    logWarn('selectKeyByQuotaAware: No available keys; returning null');
    return null;
  }

  const tokenUsageData = loadTokenUsageData();

  if (Object.keys(tokenUsageData).length === 0) {
    logInfo('⚠️ No token usage data; falling back to the first key');
    const keyObj = activeKeys[0];
    keyObj.usage_count = (keyObj.usage_count || 0) + 1;
    keyObj.last_used_at = new Date().toISOString();
    saveKeyPool();
    return keyObj;
  }

  // Read quota limits from the configuration, or use defaults.
  const quotaLimits = config.quotaLimits || {
    per_key_daily_limit: 1000000,    // 1 million tokens per key per day
    per_key_monthly_limit: 30000000,  // 30 million tokens per key per month
    warning_threshold: 0.8            // Warning threshold: 80%
  };

  // Calculate the date key for daily usage tracking.
  const today = new Date().toISOString().split('T')[0];

  // Keep keys that have not reached a quota limit.
  const availableKeys = activeKeys.filter(key => {
    const usageInfo = tokenUsageData[key.id];
    if (!usageInfo) return true;  // Keys without usage data remain eligible.

    const used = usageInfo.standard?.orgTotalTokensUsed || 0;
    const remaining = usageInfo.standard?.remaining || 0;
    const totalAllowance = usageInfo.standard?.totalAllowance || 0;

    // Check whether a quota limit has been reached.
    const dailyUsage = key.daily_usage?.[today] || 0;
    const monthlyUsage = used;  // Use total reported usage as monthly usage.

    // Check whether any quota limit has been reached.
    const isDailyQuotaExceeded = dailyUsage >= quotaLimits.per_key_daily_limit;
    const isMonthlyQuotaExceeded = monthlyUsage >= quotaLimits.per_key_monthly_limit;
    const isTotalQuotaExceeded = remaining <= 0;

    // Warn when the remaining-quota ratio is below the configured threshold.
    if (totalAllowance > 0 && remaining / totalAllowance < quotaLimits.warning_threshold) {
      logWarn(`Key ${key.id.substring(0, 20)} is running low on quota. Remaining: ${remaining.toLocaleString()} / ${totalAllowance.toLocaleString()}`);
    }

    return !isDailyQuotaExceeded && !isMonthlyQuotaExceeded && !isTotalQuotaExceeded;
  });

  if (availableKeys.length === 0) {
    throw new Error('All keys have reached a quota limit. Add keys or increase the quota.');
  }

  logInfo(`📊 quota-aware: ${availableKeys.length} of ${activeKeys.length} keys are available`);

  // Select the available key with the most remaining quota.
  const keysWithQuota = availableKeys.map(key => {
    const usageInfo = tokenUsageData[key.id];
    return {
      ...key,
      token_remaining: usageInfo?.standard?.remaining || 0
    };
  });

  keysWithQuota.sort((a, b) => b.token_remaining - a.token_remaining);
  const selectedKey = keysWithQuota[0];

  // Update daily usage statistics.
  if (!selectedKey.daily_usage) {
    selectedKey.daily_usage = {};
  }
  selectedKey.daily_usage[today] = (selectedKey.daily_usage[today] || 0) + 1;

  // Update usage statistics.
  selectedKey.usage_count = (selectedKey.usage_count || 0) + 1;
  selectedKey.last_used_at = new Date().toISOString();

  const originalKey = allKeys.find(k => k.id === selectedKey.id);
  if (originalKey) {
    originalKey.usage_count = selectedKey.usage_count;
    originalKey.last_used_at = selectedKey.last_used_at;
    originalKey.daily_usage = selectedKey.daily_usage;
    saveKeyPool();
  }

  logInfo(`🎯 quota-aware: Selected key ${selectedKey.id.substring(0, 20)}... (remaining quota: ${selectedKey.token_remaining.toLocaleString()})`);

  return selectedKey;
}

/**
 * ⏰ Algorithm 3: time-window (usage within a rolling window)
 *
 * Select a key based on usage over the last N hours.
 *
 * @param {Array} activeKeys - Available keys
 * @param {Function} saveKeyPool - Function that saves the key pool
 * @param {Array} allKeys - All keys
 * @param {Object} config - Configuration object
 * @returns {Object} Selected key object
 */
export async function selectKeyByTimeWindow(activeKeys, saveKeyPool, allKeys, config) {
  // BaSui: Guard against an empty array to avoid accessing undefined.
  if (!activeKeys || activeKeys.length === 0) {
    throw new Error('selectKeyByTimeWindow: activeKeys is empty; cannot select a key');
  }

  // Default time window: 24 hours
  const timeWindowHours = config.timeWindowHours || 24;
  const now = Date.now();
  const windowStart = now - (timeWindowHours * 60 * 60 * 1000);

  // Calculate usage within the time window for each key.
  const keysWithWindowUsage = activeKeys.map(key => {
    // Use the key usage history to calculate usage within the window.
    const usageHistory = key.usage_history || [];

    // Keep usage records within the time window.
    const windowUsage = usageHistory.filter(record => {
      const timestamp = new Date(record.timestamp).getTime();
      return timestamp >= windowStart;
    });

    // Sum token usage within the time window.
    const windowTokenUsage = windowUsage.reduce((sum, record) => {
      return sum + (record.tokens_used || 0);
    }, 0);

    // Count requests.
    const windowRequestCount = windowUsage.length;

    return {
      ...key,
      window_token_usage: windowTokenUsage,
      window_request_count: windowRequestCount,
      window_hours: timeWindowHours
    };
  });

  // Sort by token usage within the window, lowest first.
  keysWithWindowUsage.sort((a, b) => a.window_token_usage - b.window_token_usage);

  // Select the key with the lowest usage within the time window.
  const selectedKey = keysWithWindowUsage[0];

  // Add this request to the usage history.
  if (!selectedKey.usage_history) {
    selectedKey.usage_history = [];
  }

  selectedKey.usage_history.push({
    timestamp: new Date().toISOString(),
    tokens_used: 0  // Actual usage is updated when the request completes.
  });

  // Remove records outside the window to prevent unbounded history growth.
  selectedKey.usage_history = selectedKey.usage_history.filter(record => {
    const timestamp = new Date(record.timestamp).getTime();
    return timestamp >= windowStart;
  });

  // Update usage statistics.
  selectedKey.usage_count = (selectedKey.usage_count || 0) + 1;
  selectedKey.last_used_at = new Date().toISOString();

  const originalKey = allKeys.find(k => k.id === selectedKey.id);
  if (originalKey) {
    originalKey.usage_count = selectedKey.usage_count;
    originalKey.last_used_at = selectedKey.last_used_at;
    originalKey.usage_history = selectedKey.usage_history;
    saveKeyPool();
  }

  logInfo(`🎯 time-window: Selected key ${selectedKey.id.substring(0, 20)}... (usage over ${timeWindowHours}h: ${selectedKey.window_token_usage.toLocaleString()} tokens, ${selectedKey.window_request_count} requests)`);

  return selectedKey;
}

/**
 * 🔧 Helper: Update token usage within the time window.
 * Call after the request completes.
 *
 * @param {String} keyId - Key ID
 * @param {Number} tokensUsed - Tokens used by this request
 * @param {Array} allKeys - All keys
 * @param {Function} saveKeyPool - Function that saves the key pool
 */
export function updateTimeWindowUsage(keyId, tokensUsed, allKeys, saveKeyPool) {
  const key = allKeys.find(k => k.id === keyId);
  if (!key || !key.usage_history) return;

  // Update the token count in the most recent record.
  const lastRecord = key.usage_history[key.usage_history.length - 1];
  if (lastRecord) {
    lastRecord.tokens_used = tokensUsed;
    saveKeyPool();
  }
}

export default {
  selectKeyByWeightedUsage,
  selectKeyByQuotaAware,
  selectKeyByTimeWindow,
  updateTimeWindowUsage
};
