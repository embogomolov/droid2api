/**
 * 请求统计模块
 * 功能：记录和查询 API 请求的 Token 使用量和请求次数
 * 支持：总统计、每日统计、按模型统计
 *
 * 数据结构：
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
const DAILY_RETENTION_DAYS = 30; // 保留30天的每日数据

/**
 * 确保data目录存在
 */
function ensureDataDir() {
  const dataDir = path.dirname(STATS_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    logInfo(`创建data目录: ${dataDir}`);
  }
}

/**
 * 加载统计数据
 */
function loadStats() {
  ensureDataDir();

  if (!fs.existsSync(STATS_FILE)) {
    // 初始化空数据
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
    logError('加载统计数据失败', error);
    return {
      total: { tokens: 0, requests: 0, last_updated: new Date().toISOString() },
      daily: {},
      by_model: {}
    };
  }
}

/**
 * 保存统计数据
 */
function saveStats(stats) {
  try {
    ensureDataDir();
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
  } catch (error) {
    logError('保存统计数据失败', error);
  }
}

/**
 * 获取今天的日期字符串 (YYYY-MM-DD)
 * BaSui: 使用本地时区而不是UTC时区，避免凌晨切换日期不及时！
 */
function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 清理过期的每日数据
 */
function cleanupOldDailyStats(stats) {
  const today = new Date();
  const cutoffDate = new Date(today);
  cutoffDate.setDate(cutoffDate.getDate() - DAILY_RETENTION_DAYS);
  // BaSui: 使用本地时区格式化日期
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
    logDebug(`清理了 ${DAILY_RETENTION_DAYS} 天前的统计数据`);
  }
}

/**
 * 记录一次请求统计
 * @param {Object} options - 统计选项
 * @param {number} options.inputTokens - 输入Token数
 * @param {number} options.outputTokens - 输出Token数
 * @param {number} options.thinkingTokens - 推理Token数（Anthropic Extended Thinking）
 * @param {number} options.cacheCreationTokens - 缓存创建Token数
 * @param {number} options.cacheReadTokens - 缓存读取Token数
 * @param {string} options.model - 模型名称
 * @param {boolean} options.success - 是否成功
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

    // 更新总统计
    stats.total.tokens += totalTokens;
    stats.total.requests += 1;
    stats.total.last_updated = new Date().toISOString();

    // 更新每日统计
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

    // 更新按模型统计
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

    // 清理过期数据
    cleanupOldDailyStats(stats);

    // 保存
    saveStats(stats);

    logDebug(`记录请求统计: model=${model}, tokens=${totalTokens} (input=${inputTokens}, output=${outputTokens}, thinking=${thinkingTokens}, cache_creation=${cacheCreationTokens}, cache_read=${cacheReadTokens}), success=${success}`);
  } catch (error) {
    logError('记录请求统计失败', error);
  }
}

/**
 * 获取统计数据
 * @returns {Object} 统计数据
 */
export function getStats() {
  return loadStats();
}

/**
 * 获取今日统计
 * @returns {Object} 今日统计数据
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
 * 获取统计摘要（用于前端显示）
 * @returns {Object} 统计摘要
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
 * 获取最近N天的统计数据（用于趋势图）
 * @param {number} days - 天数，默认7天
 * @returns {Array} 每日统计数据数组（按日期升序）
 */
export function get7DaysTrend(days = 7) {
  const stats = loadStats();
  const result = [];
  const today = new Date();

  // 生成最近N天的日期列表（使用本地时区）
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    // BaSui: 使用本地时区格式化日期
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
      date_formatted: `${date.getMonth() + 1}/${date.getDate()}`,  // 格式化为 MM/DD
      ...dayStats
    });
  }

  return result;
}

/**
 * 重置统计数据（危险操作！）
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
  logInfo('统计数据已重置');
}

export default {
  recordRequest,
  getStats,
  getTodayStats,
  getStatsSummary,
  get7DaysTrend,
  resetStats
};
