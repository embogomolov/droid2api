/**
 * 🚀 高级轮询算法模块
 *
 * 作者：BaSui
 * 版本：v1.0.0
 * 最后更新：2025-10-12
 *
 * 包含三个高级智能算法：
 * 1. weighted-usage - 加权综合评分
 * 2. quota-aware - 配额感知
 * 3. time-window - 时间窗口
 */

import { logInfo, logWarn, logError, logDebug } from '../logger.js';

/**
 * 🎯 算法1: weighted-usage（加权综合评分）
 *
 * 综合考虑：剩余Token (40%)、使用率 (30%)、成功率 (30%)
 *
 * @param {Array} activeKeys - 可用密钥列表
 * @param {Function} loadTokenUsageData - 加载Token使用量数据的方法
 * @param {Function} saveKeyPool - 保存密钥池的方法
 * @param {Array} allKeys - 所有密钥（用于查找原始密钥）
 * @returns {Object} 选中的密钥对象
 */
export async function selectKeyByWeightedUsage(activeKeys, loadTokenUsageData, saveKeyPool, allKeys) {
  // BaSui：边界检查 - 防止空数组导致 undefined 访问
  if (!activeKeys || activeKeys.length === 0) {
    throw new Error('selectKeyByWeightedUsage: activeKeys 为空，无法选择密钥');
  }

  const tokenUsageData = loadTokenUsageData();

  if (Object.keys(tokenUsageData).length === 0) {
    logInfo('⚠️ 没有Token使用量数据，降级使用第一个密钥');
    const keyObj = activeKeys[0];
    keyObj.usage_count = (keyObj.usage_count || 0) + 1;
    keyObj.last_used_at = new Date().toISOString();
    saveKeyPool();
    return keyObj;
  }

  // 为每个密钥计算综合评分
  const keysWithScore = activeKeys.map(key => {
    const usageInfo = tokenUsageData[key.id];

    // 获取Token相关数据
    const remaining = usageInfo?.standard?.remaining || 0;
    const totalAllowance = usageInfo?.standard?.totalAllowance || 1;
    const usedRatio = usageInfo?.standard?.usedRatio || 0;

    // 获取成功率数据
    const totalRequests = key.total_requests || key.usage_count || 0;
    const successRequests = key.success_requests || (totalRequests - (key.error_count || 0));
    const successRate = totalRequests > 0 ? successRequests / totalRequests : 1;

    // 计算各项得分（0-100分）
    const remainingScore = (remaining / totalAllowance) * 100;  // 剩余比例越高越好
    const usageScore = (1 - usedRatio) * 100;                   // 使用率越低越好
    const successScore = successRate * 100;                      // 成功率越高越好

    // 加权综合评分
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

  // 按综合评分降序排序（得分最高的排前面）
  keysWithScore.sort((a, b) => b.weighted_usage_score - a.weighted_usage_score);

  // 选择得分最高的密钥
  const selectedKey = keysWithScore[0];

  // 更新使用统计
  selectedKey.usage_count = (selectedKey.usage_count || 0) + 1;
  selectedKey.last_used_at = new Date().toISOString();

  const originalKey = allKeys.find(k => k.id === selectedKey.id);
  if (originalKey) {
    originalKey.usage_count = selectedKey.usage_count;
    originalKey.last_used_at = selectedKey.last_used_at;
    saveKeyPool();
  }

  logInfo(`🎯 weighted-usage: 选中密钥 ${selectedKey.id.substring(0, 20)}... (综合评分: ${selectedKey.weighted_usage_score}, 剩余: ${selectedKey.token_remaining.toLocaleString()}, 成功率: ${(selectedKey.success_rate * 100).toFixed(1)}%)`);

  return selectedKey;
}

/**
 * 📊 算法2: quota-aware（配额感知）
 *
 * 为每个密钥设置配额上限，超过上限自动跳过
 *
 * @param {Array} activeKeys - 可用密钥列表
 * @param {Function} loadTokenUsageData - 加载Token使用量数据的方法
 * @param {Function} saveKeyPool - 保存密钥池的方法
 * @param {Array} allKeys - 所有密钥
 * @param {Object} config - 配置对象
 * @returns {Object} 选中的密钥对象
 */
export async function selectKeyByQuotaAware(activeKeys, loadTokenUsageData, saveKeyPool, allKeys, config) {
  // BaSui：边界检查 - 防止空数组导致 undefined 访问
  if (!activeKeys || activeKeys.length === 0) {
    throw new Error('selectKeyByQuotaAware: activeKeys 为空，无法选择密钥');
  }

  const tokenUsageData = loadTokenUsageData();

  if (Object.keys(tokenUsageData).length === 0) {
    logInfo('⚠️ 没有Token使用量数据，降级使用第一个密钥');
    const keyObj = activeKeys[0];
    keyObj.usage_count = (keyObj.usage_count || 0) + 1;
    keyObj.last_used_at = new Date().toISOString();
    saveKeyPool();
    return keyObj;
  }

  // 从配置中获取配额限制（如果没有则使用默认值）
  const quotaLimits = config.quotaLimits || {
    per_key_daily_limit: 1000000,    // 每个密钥每日100万Token
    per_key_monthly_limit: 30000000,  // 每个密钥每月3000万Token
    warning_threshold: 0.8            // 80%触发告警
  };

  // 计算今天的日期键（用于统计每日用量）
  const today = new Date().toISOString().split('T')[0];

  // 过滤出未达配额上限的密钥
  const availableKeys = activeKeys.filter(key => {
    const usageInfo = tokenUsageData[key.id];
    if (!usageInfo) return true;  // 没有统计数据的密钥可用

    const used = usageInfo.standard?.orgTotalTokensUsed || 0;
    const remaining = usageInfo.standard?.remaining || 0;
    const totalAllowance = usageInfo.standard?.totalAllowance || 0;

    // 检查是否达到配额上限
    const dailyUsage = key.daily_usage?.[today] || 0;
    const monthlyUsage = used;  // 总使用量作为月度用量

    // 判断是否超过任何一个配额限制
    const isDailyQuotaExceeded = dailyUsage >= quotaLimits.per_key_daily_limit;
    const isMonthlyQuotaExceeded = monthlyUsage >= quotaLimits.per_key_monthly_limit;
    const isTotalQuotaExceeded = remaining <= 0;

    // 如果接近上限（80%），发出警告
    if (totalAllowance > 0 && remaining / totalAllowance < quotaLimits.warning_threshold) {
      logWarn(`密钥 ${key.id.substring(0, 20)} 配额即将耗尽！剩余: ${remaining.toLocaleString()} / ${totalAllowance.toLocaleString()}`);
    }

    return !isDailyQuotaExceeded && !isMonthlyQuotaExceeded && !isTotalQuotaExceeded;
  });

  if (availableKeys.length === 0) {
    throw new Error('所有密钥都已达到配额上限！请增加密钥或提高配额。');
  }

  logInfo(`📊 quota-aware: ${activeKeys.length} 个密钥中有 ${availableKeys.length} 个可用`);

  // 从可用密钥中选择剩余配额最多的
  const keysWithQuota = availableKeys.map(key => {
    const usageInfo = tokenUsageData[key.id];
    return {
      ...key,
      token_remaining: usageInfo?.standard?.remaining || 0
    };
  });

  keysWithQuota.sort((a, b) => b.token_remaining - a.token_remaining);
  const selectedKey = keysWithQuota[0];

  // 更新每日使用量统计
  if (!selectedKey.daily_usage) {
    selectedKey.daily_usage = {};
  }
  selectedKey.daily_usage[today] = (selectedKey.daily_usage[today] || 0) + 1;

  // 更新使用统计
  selectedKey.usage_count = (selectedKey.usage_count || 0) + 1;
  selectedKey.last_used_at = new Date().toISOString();

  const originalKey = allKeys.find(k => k.id === selectedKey.id);
  if (originalKey) {
    originalKey.usage_count = selectedKey.usage_count;
    originalKey.last_used_at = selectedKey.last_used_at;
    originalKey.daily_usage = selectedKey.daily_usage;
    saveKeyPool();
  }

  logInfo(`🎯 quota-aware: 选中密钥 ${selectedKey.id.substring(0, 20)}... (剩余配额: ${selectedKey.token_remaining.toLocaleString()})`);

  return selectedKey;
}

/**
 * ⏰ 算法3: time-window（时间窗口）
 *
 * 统计最近N小时的使用量，基于时间窗口做决策
 *
 * @param {Array} activeKeys - 可用密钥列表
 * @param {Function} saveKeyPool - 保存密钥池的方法
 * @param {Array} allKeys - 所有密钥
 * @param {Object} config - 配置对象
 * @returns {Object} 选中的密钥对象
 */
export async function selectKeyByTimeWindow(activeKeys, saveKeyPool, allKeys, config) {
  // BaSui：边界检查 - 防止空数组导致 undefined 访问
  if (!activeKeys || activeKeys.length === 0) {
    throw new Error('selectKeyByTimeWindow: activeKeys 为空，无法选择密钥');
  }

  // 默认时间窗口：24小时
  const timeWindowHours = config.timeWindowHours || 24;
  const now = Date.now();
  const windowStart = now - (timeWindowHours * 60 * 60 * 1000);

  // 为每个密钥统计时间窗口内的使用量
  const keysWithWindowUsage = activeKeys.map(key => {
    // 从密钥的使用历史中统计时间窗口内的使用量
    const usageHistory = key.usage_history || [];

    // 过滤出时间窗口内的使用记录
    const windowUsage = usageHistory.filter(record => {
      const timestamp = new Date(record.timestamp).getTime();
      return timestamp >= windowStart;
    });

    // 统计时间窗口内的Token使用量
    const windowTokenUsage = windowUsage.reduce((sum, record) => {
      return sum + (record.tokens_used || 0);
    }, 0);

    // 统计请求数
    const windowRequestCount = windowUsage.length;

    return {
      ...key,
      window_token_usage: windowTokenUsage,
      window_request_count: windowRequestCount,
      window_hours: timeWindowHours
    };
  });

  // 按时间窗口内的Token使用量升序排序（使用量最少的排前面）
  keysWithWindowUsage.sort((a, b) => a.window_token_usage - b.window_token_usage);

  // 选择时间窗口内使用量最少的密钥
  const selectedKey = keysWithWindowUsage[0];

  // 记录本次使用到历史中
  if (!selectedKey.usage_history) {
    selectedKey.usage_history = [];
  }

  selectedKey.usage_history.push({
    timestamp: new Date().toISOString(),
    tokens_used: 0  // 实际使用量将在请求完成后更新
  });

  // 清理超出时间窗口的历史记录（保持数组不会无限增长）
  selectedKey.usage_history = selectedKey.usage_history.filter(record => {
    const timestamp = new Date(record.timestamp).getTime();
    return timestamp >= windowStart;
  });

  // 更新使用统计
  selectedKey.usage_count = (selectedKey.usage_count || 0) + 1;
  selectedKey.last_used_at = new Date().toISOString();

  const originalKey = allKeys.find(k => k.id === selectedKey.id);
  if (originalKey) {
    originalKey.usage_count = selectedKey.usage_count;
    originalKey.last_used_at = selectedKey.last_used_at;
    originalKey.usage_history = selectedKey.usage_history;
    saveKeyPool();
  }

  logInfo(`🎯 time-window: 选中密钥 ${selectedKey.id.substring(0, 20)}... (${timeWindowHours}h内使用: ${selectedKey.window_token_usage.toLocaleString()} tokens, ${selectedKey.window_request_count} 次请求)`);

  return selectedKey;
}

/**
 * 🔧 辅助方法：更新时间窗口内的Token使用量
 * 在请求完成后调用
 *
 * @param {String} keyId - 密钥ID
 * @param {Number} tokensUsed - 本次使用的Token数量
 * @param {Array} allKeys - 所有密钥
 * @param {Function} saveKeyPool - 保存密钥池的方法
 */
export function updateTimeWindowUsage(keyId, tokensUsed, allKeys, saveKeyPool) {
  const key = allKeys.find(k => k.id === keyId);
  if (!key || !key.usage_history) return;

  // 更新最后一条记录的Token使用量
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
