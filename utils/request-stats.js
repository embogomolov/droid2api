/**
 * Request statistics module
 * Record and query token usage and request counts for API calls.
 * Supports overall, daily, and per-model statistics.
 *
 * Data structure:
 * {
 *   total: { tokens, requests, last_updated },
 *   daily: { "YYYY-MM-DD": { tokens, requests, last_updated } },
 *   by_model: { "model-name": { total_tokens, total_requests } }
 * }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logError, logDebug } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATS_FILE = path.join(__dirname, '..', 'data', 'request_stats.json');
const DAILY_RETENTION_DAYS = 30; // Retain 30 days of daily statistics.

/**
 * Ensure the data directory exists.
 */
function ensureDataDir() {
  const dataDir = path.dirname(STATS_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    logInfo(`Created data directory: ${dataDir}`);
  }
}

/**
 * Load statistics.
 */
function loadStats() {
  ensureDataDir();

  if (!fs.existsSync(STATS_FILE)) {
    // Initialize empty statistics.
    const emptyStats = {
      total: {
        tokens: 0,
        requests: 0,
        last_updated: new Date().toISOString()
      },
      daily: {},
      by_model: {}
    };
    saveStats(emptyStats);
    return emptyStats;
  }

  try {
    const data = fs.readFileSync(STATS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    logError('Failed to load statistics', error);
    return {
      total: { tokens: 0, requests: 0, last_updated: new Date().toISOString() },
      daily: {},
      by_model: {}
    };
  }
}

/**
 * Save statistics.
 */
function saveStats(stats) {
  try {
    ensureDataDir();
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
  } catch (error) {
    logError('Failed to save statistics', error);
  }
}

/**
 * Get the current date as YYYY-MM-DD.
 * BaSui: Use local time rather than UTC so the date changes at local midnight.
 */
function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Remove expired daily statistics.
 */
function cleanupOldDailyStats(stats) {
  const today = new Date();
  const cutoffDate = new Date(today);
  cutoffDate.setDate(cutoffDate.getDate() - DAILY_RETENTION_DAYS);
  // BaSui: Format the date in local time.
  const year = cutoffDate.getFullYear();
  const month = String(cutoffDate.getMonth() + 1).padStart(2, '0');
  const day = String(cutoffDate.getDate()).padStart(2, '0');
  const cutoffKey = `${year}-${month}-${day}`;

  let cleaned = false;
  Object.keys(stats.daily).forEach(dateKey => {
    if (dateKey < cutoffKey) {
      delete stats.daily[dateKey];
      cleaned = true;
    }
  });

  if (cleaned) {
    logDebug(`Removed statistics older than ${DAILY_RETENTION_DAYS} days`);
  }
}

/**
 * Record statistics for one request.
 * @param {Object} options - Statistics options
 * @param {number} options.inputTokens - Input token count
 * @param {number} options.outputTokens - Output token count
 * @param {number} options.thinkingTokens - Thinking token count (Anthropic Extended Thinking)
 * @param {number} options.cacheCreationTokens - Cache creation token count
 * @param {number} options.cacheReadTokens - Cache read token count
 * @param {string} options.model - Model name
 * @param {boolean} options.success - Whether the request succeeded
 */
export function recordRequest({
  inputTokens = 0,
  outputTokens = 0,
  thinkingTokens = 0,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
  model = 'unknown',
  success = true
}) {
  try {
    const stats = loadStats();
    const today = getTodayKey();
    const totalTokens = inputTokens + outputTokens + thinkingTokens;

    // Update overall statistics.
    stats.total.tokens += totalTokens;
    stats.total.requests += 1;
    stats.total.last_updated = new Date().toISOString();

    // Update daily statistics.
    if (!stats.daily[today]) {
      stats.daily[today] = {
        tokens: 0,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        success_requests: 0,
        failed_requests: 0,
        last_updated: new Date().toISOString()
      };
    }

    stats.daily[today].tokens += totalTokens;
    stats.daily[today].requests += 1;
    stats.daily[today].input_tokens += inputTokens;
    stats.daily[today].output_tokens += outputTokens;
    stats.daily[today].thinking_tokens = (stats.daily[today].thinking_tokens || 0) + thinkingTokens;
    stats.daily[today].cache_creation_tokens = (stats.daily[today].cache_creation_tokens || 0) + cacheCreationTokens;
    stats.daily[today].cache_read_tokens = (stats.daily[today].cache_read_tokens || 0) + cacheReadTokens;

    if (success) {
      stats.daily[today].success_requests += 1;
    } else {
      stats.daily[today].failed_requests += 1;
    }

    stats.daily[today].last_updated = new Date().toISOString();

    // Update per-model statistics.
    if (!stats.by_model[model]) {
      stats.by_model[model] = {
        total_tokens: 0,
        total_requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0
      };
    }

    stats.by_model[model].total_tokens += totalTokens;
    stats.by_model[model].total_requests += 1;
    stats.by_model[model].input_tokens += inputTokens;
    stats.by_model[model].output_tokens += outputTokens;
    stats.by_model[model].thinking_tokens = (stats.by_model[model].thinking_tokens || 0) + thinkingTokens;
    stats.by_model[model].cache_creation_tokens = (stats.by_model[model].cache_creation_tokens || 0) + cacheCreationTokens;
    stats.by_model[model].cache_read_tokens = (stats.by_model[model].cache_read_tokens || 0) + cacheReadTokens;

    // Remove expired statistics.
    cleanupOldDailyStats(stats);

    // Save statistics.
    saveStats(stats);

    logDebug(`Recorded request statistics: model=${model}, tokens=${totalTokens} (input=${inputTokens}, output=${outputTokens}, thinking=${thinkingTokens}, cache_creation=${cacheCreationTokens}, cache_read=${cacheReadTokens}), success=${success}`);
  } catch (error) {
    logError('Failed to record request statistics', error);
  }
}

/**
 * Get statistics.
 * @returns {Object} Statistics
 */
export function getStats() {
  return loadStats();
}

/**
 * Get statistics for today.
 * @returns {Object} Statistics for today
 */
export function getTodayStats() {
  const stats = loadStats();
  const today = getTodayKey();
  return stats.daily[today] || {
    tokens: 0,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    success_requests: 0,
    failed_requests: 0
  };
}

/**
 * Get a statistics summary for the frontend.
 * @returns {Object} Statistics summary
 */
export function getStatsSummary() {
  const stats = loadStats();
  const today = getTodayKey();
  const todayStats = stats.daily[today] || {
    tokens: 0,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0
  };

  return {
    total_tokens: stats.total.tokens,
    total_requests: stats.total.requests,
    today_tokens: todayStats.tokens,
    today_requests: todayStats.requests,
    today_input_tokens: todayStats.input_tokens,
    today_output_tokens: todayStats.output_tokens,
    today_thinking_tokens: todayStats.thinking_tokens || 0,
    today_cache_creation_tokens: todayStats.cache_creation_tokens || 0,
    today_cache_read_tokens: todayStats.cache_read_tokens || 0,
    last_updated: stats.total.last_updated,
    models: Object.keys(stats.by_model).map(model => ({
      name: model,
      total_tokens: stats.by_model[model].total_tokens,
      total_requests: stats.by_model[model].total_requests,
      input_tokens: stats.by_model[model].input_tokens,
      output_tokens: stats.by_model[model].output_tokens,
      thinking_tokens: stats.by_model[model].thinking_tokens || 0,
      cache_creation_tokens: stats.by_model[model].cache_creation_tokens || 0,
      cache_read_tokens: stats.by_model[model].cache_read_tokens || 0
    }))
  };
}

/**
 * Get statistics for the last N days for the trend chart.
 * @param {number} days - Number of days; defaults to 7
 * @returns {Array} Daily statistics sorted by date, oldest first
 */
export function get7DaysTrend(days = 7) {
  const stats = loadStats();
  const result = [];
  const today = new Date();

  // Generate dates for the last N days in local time.
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    // BaSui: Format the date in local time.
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateKey = `${year}-${month}-${day}`;

    const dayStats = stats.daily[dateKey] || {
      tokens: 0,
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      success_requests: 0,
      failed_requests: 0
    };

    result.push({
      date: dateKey,
      date_formatted: `${date.getMonth() + 1}/${date.getDate()}`,  // Format as MM/DD.
      ...dayStats
    });
  }

  return result;
}

/**
 * Reset all statistics (destructive).
 */
export function resetStats() {
  const emptyStats = {
    total: {
      tokens: 0,
      requests: 0,
      last_updated: new Date().toISOString()
    },
    daily: {},
    by_model: {}
  };
  saveStats(emptyStats);
  logInfo('Statistics reset');
}

export default {
  recordRequest,
  getStats,
  getTodayStats,
  getStatsSummary,
  get7DaysTrend,
  resetStats
};
