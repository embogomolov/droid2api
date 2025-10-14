/**
 * Token使用量统计API路由
 * 提供token使用量的查询、分析和报告功能
 * 
 * BaSui: 基于新的准确token计算算法提供详细统计
 */

import express from 'express';
import tokenUsageManager from '../utils/token-usage-manager.js';
import { logInfo, logError } from '../logger.js';
import { sendSuccessResponse, sendErrorResponse, wrapAsync } from './admin-error-handlers.js';

const router = express.Router();

/**
 * GET /admin/token-stats/summary
 * 获取token使用量总览
 */
router.get('/summary', wrapAsync(async (req, res) => {
  const summary = tokenUsageManager.getSummary();
  
  // 添加额外的统计信息
  const enrichedSummary = {
    ...summary,
    metrics: {
      avg_tokens_per_request: summary.total.requests > 0 
        ? Math.round(summary.total.total_tokens / summary.total.requests)
        : 0,
      avg_prompt_tokens: summary.total.requests > 0
        ? Math.round(summary.total.prompt_tokens / summary.total.requests)
        : 0,
      avg_completion_tokens: summary.total.requests > 0
        ? Math.round(summary.total.completion_tokens / summary.total.requests)
        : 0,
      cache_hit_rate: summary.total.prompt_tokens > 0
        ? ((summary.total.cache_read_tokens / summary.total.prompt_tokens) * 100).toFixed(2) + '%'
        : '0%',
      estimated_daily_cost: summary.today.estimated_cost || 0
    }
  };

  sendSuccessResponse(res, enrichedSummary, 'Token使用量总览');
}, 'get token usage summary'));

/**
 * GET /admin/token-stats/by-key/:keyId
 * 获取指定密钥的token使用量
 */
router.get('/by-key/:keyId', wrapAsync(async (req, res) => {
  const { keyId } = req.params;
  const usage = tokenUsageManager.getKeyUsage(keyId);
  
  if (!usage) {
    return sendErrorResponse(res, 404, `未找到密钥 ${keyId} 的使用记录`);
  }

  sendSuccessResponse(res, usage, `密钥 ${keyId} 的token使用量`);
}, 'get token usage by key'));

/**
 * GET /admin/token-stats/by-model/:model
 * 获取指定模型的token使用量
 */
router.get('/by-model/:model', wrapAsync(async (req, res) => {
  const { model } = req.params;
  const usage = tokenUsageManager.getModelUsage(model);
  
  if (!usage) {
    return sendErrorResponse(res, 404, `未找到模型 ${model} 的使用记录`);
  }

  sendSuccessResponse(res, usage, `模型 ${model} 的token使用量`);
}, 'get token usage by model'));

/**
 * GET /admin/token-stats/by-date-range
 * 获取日期范围内的token使用量
 * Query参数: start, end (YYYY-MM-DD格式)
 */
router.get('/by-date-range', wrapAsync(async (req, res) => {
  const { start, end } = req.query;
  
  if (!start || !end) {
    return sendErrorResponse(res, 400, '请提供start和end参数（YYYY-MM-DD格式）');
  }

  const usage = tokenUsageManager.getUsageByDateRange(start, end);
  
  // 计算日期范围内的总计
  const total = {
    requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  };

  Object.values(usage).forEach(dayStats => {
    total.requests += dayStats.requests;
    total.prompt_tokens += dayStats.prompt_tokens;
    total.completion_tokens += dayStats.completion_tokens;
    total.total_tokens += dayStats.total_tokens;
  });

  sendSuccessResponse(res, {
    range: { start, end },
    daily: usage,
    total
  }, `${start} 到 ${end} 的token使用量`);
}, 'get token usage by date range'));

/**
 * GET /admin/token-stats/top-keys
 * 获取token使用量最多的密钥
 * Query参数: limit (默认10)
 */
router.get('/top-keys', wrapAsync(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const allData = tokenUsageManager.usageData;
  
  // 获取所有密钥的使用量并排序
  const keyUsages = Object.entries(allData.keys || {})
    .map(([keyId, usage]) => ({
      keyId,
      ...usage
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, limit);

  sendSuccessResponse(res, keyUsages, `Token使用量前${limit}的密钥`);
}, 'get top keys by token usage'));

/**
 * GET /admin/token-stats/top-models
 * 获取token使用量最多的模型
 * Query参数: limit (默认10)
 */
router.get('/top-models', wrapAsync(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const allData = tokenUsageManager.usageData;
  
  // 获取所有模型的使用量并排序
  const modelUsages = Object.entries(allData.models || {})
    .map(([model, usage]) => ({
      model,
      ...usage
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, limit);

  sendSuccessResponse(res, modelUsages, `Token使用量前${limit}的模型`);
}, 'get top models by token usage'));

/**
 * GET /admin/token-stats/hourly
 * 获取最近24小时的token使用量
 */
router.get('/hourly', wrapAsync(async (req, res) => {
  const allData = tokenUsageManager.usageData;
  const now = new Date();
  const hourlyData = {};
  
  // 获取最近24小时的数据
  for (let i = 0; i < 24; i++) {
    const hour = new Date(now - i * 60 * 60 * 1000);
    const hourKey = `${hour.toISOString().split('T')[0]}T${hour.getHours().toString().padStart(2, '0')}`;
    
    if (allData.hourly[hourKey]) {
      hourlyData[hourKey] = allData.hourly[hourKey];
    }
  }

  sendSuccessResponse(res, hourlyData, '最近24小时的token使用量');
}, 'get hourly token usage'));

/**
 * GET /admin/token-stats/accuracy
 * 获取token预估准确率统计
 */
router.get('/accuracy', wrapAsync(async (req, res) => {
  const allData = tokenUsageManager.usageData;
  const accuracy = allData.accuracy || {
    samples: 0,
    avg_accuracy_prompt: 0,
    avg_accuracy_completion: 0,
    message: '暂无准确率数据'
  };

  if (accuracy.samples > 0) {
    accuracy.prompt_accuracy_percent = (accuracy.avg_accuracy_prompt * 100).toFixed(2) + '%';
    accuracy.completion_accuracy_percent = (accuracy.avg_accuracy_completion * 100).toFixed(2) + '%';
  }

  sendSuccessResponse(res, accuracy, 'Token预估准确率');
}, 'get token estimation accuracy'));

/**
 * GET /admin/token-stats/cost-analysis
 * 获取成本分析
 */
router.get('/cost-analysis', wrapAsync(async (req, res) => {
  const allData = tokenUsageManager.usageData;
  const today = new Date().toISOString().split('T')[0];
  
  // 计算不同时间段的成本
  const costAnalysis = {
    total_cost: allData.total.estimated_cost || 0,
    today_cost: allData.daily[today]?.estimated_cost || 0,
    models: {},
    keys: {}
  };

  // 按模型分析成本
  Object.entries(allData.models || {}).forEach(([model, usage]) => {
    costAnalysis.models[model] = {
      requests: usage.requests,
      total_tokens: usage.total_tokens,
      estimated_cost: tokenUsageManager.calculateCost(usage, model)
    };
  });

  // 获取成本最高的前10个密钥
  const topCostKeys = Object.entries(allData.keys || {})
    .map(([keyId, usage]) => ({
      keyId,
      requests: usage.requests,
      total_tokens: usage.total_tokens,
      estimated_cost: tokenUsageManager.calculateCost(usage, 'default')
    }))
    .sort((a, b) => b.estimated_cost - a.estimated_cost)
    .slice(0, 10);

  costAnalysis.top_cost_keys = topCostKeys;

  sendSuccessResponse(res, costAnalysis, '成本分析');
}, 'get cost analysis'));

/**
 * POST /admin/token-stats/cleanup
 * 清理旧的统计数据
 */
router.post('/cleanup', wrapAsync(async (req, res) => {
  tokenUsageManager.cleanupOldData();
  sendSuccessResponse(res, { message: '已清理旧的统计数据' }, '清理完成');
}, 'cleanup old stats'));

export default router;
