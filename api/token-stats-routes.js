/**
 * Token usage statistics API routes
 * Provide token usage queries, analysis, and reports
 *
 * BaSui: Provide detailed statistics based on the new accurate token counting algorithm
 */

import express from 'express';
import tokenUsageManager from '../utils/token-usage-manager.js';
import { logInfo, logError } from '../logger.js';
import { sendSuccessResponse, sendErrorResponse, wrapAsync } from './admin-error-handlers.js';

const router = express.Router();

/**
 * GET /admin/token-stats/summary
 * Get a token usage overview
 */
router.get('/summary', wrapAsync(async (req, res) => {
  const summary = tokenUsageManager.getSummary();
  
  // Add extra statistics
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

  sendSuccessResponse(res, enrichedSummary, 'Token usage overview');
}, 'get token usage summary'));

/**
 * GET /admin/token-stats/by-key/:keyId
 * Get token usage for a specific key
 */
router.get('/by-key/:keyId', wrapAsync(async (req, res) => {
  const { keyId } = req.params;
  const usage = tokenUsageManager.getKeyUsage(keyId);
  
  if (!usage) {
    return sendErrorResponse(res, 404, `No usage records found for key ${keyId}`);
  }

  sendSuccessResponse(res, usage, `Token usage for key ${keyId}`);
}, 'get token usage by key'));

/**
 * GET /admin/token-stats/by-model/:model
 * Get token usage for a specific model
 */
router.get('/by-model/:model', wrapAsync(async (req, res) => {
  const { model } = req.params;
  const usage = tokenUsageManager.getModelUsage(model);
  
  if (!usage) {
    return sendErrorResponse(res, 404, `No usage records found for model ${model}`);
  }

  sendSuccessResponse(res, usage, `Token usage for model ${model}`);
}, 'get token usage by model'));

/**
 * GET /admin/token-stats/by-date-range
 * Get token usage within a date range
 * Query parameters: start, end (YYYY-MM-DD format
 */
router.get('/by-date-range', wrapAsync(async (req, res) => {
  const { start, end } = req.query;
  
  if (!start || !end) {
    return sendErrorResponse(res, 400, 'Provide start and end parameters in YYYY-MM-DD format');
  }

  const usage = tokenUsageManager.getUsageByDateRange(start, end);
  
  // Calculate totals for the date range
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
  }, `${start} to ${end}: token usage`);
}, 'get token usage by date range'));

/**
 * GET /admin/token-stats/top-keys
 * Get the keys with the highest token usage
 * Query parameter: limit (default 10)
 */
router.get('/top-keys', wrapAsync(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const allData = tokenUsageManager.usageData;
  
  // Get usage for all keys and sort
  const keyUsages = Object.entries(allData.keys || {})
    .map(([keyId, usage]) => ({
      keyId,
      ...usage
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, limit);

  sendSuccessResponse(res, keyUsages, `Top ${limit} keys by token usage`);
}, 'get top keys by token usage'));

/**
 * GET /admin/token-stats/top-models
 * Get the models with the highest token usage
 * Query parameter: limit (default 10)
 */
router.get('/top-models', wrapAsync(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const allData = tokenUsageManager.usageData;
  
  // Get usage for all models and sort
  const modelUsages = Object.entries(allData.models || {})
    .map(([model, usage]) => ({
      model,
      ...usage
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, limit);

  sendSuccessResponse(res, modelUsages, `Top ${limit} models by token usage`);
}, 'get top models by token usage'));

/**
 * GET /admin/token-stats/hourly
 * Get token usage for the last 24 hours
 */
router.get('/hourly', wrapAsync(async (req, res) => {
  const allData = tokenUsageManager.usageData;
  const now = new Date();
  const hourlyData = {};
  
  // Get data for the last 24 hours
  for (let i = 0; i < 24; i++) {
    const hour = new Date(now - i * 60 * 60 * 1000);
    const hourKey = `${hour.toISOString().split('T')[0]}T${hour.getHours().toString().padStart(2, '0')}`;
    
    if (allData.hourly[hourKey]) {
      hourlyData[hourKey] = allData.hourly[hourKey];
    }
  }

  sendSuccessResponse(res, hourlyData, 'Token usage in the last 24 hours');
}, 'get hourly token usage'));

/**
 * GET /admin/token-stats/accuracy
 * Get token estimation accuracy statistics
 */
router.get('/accuracy', wrapAsync(async (req, res) => {
  const allData = tokenUsageManager.usageData;
  const accuracy = allData.accuracy || {
    samples: 0,
    avg_accuracy_prompt: 0,
    avg_accuracy_completion: 0,
    message: 'No accuracy data available yet'
  };

  if (accuracy.samples > 0) {
    accuracy.prompt_accuracy_percent = (accuracy.avg_accuracy_prompt * 100).toFixed(2) + '%';
    accuracy.completion_accuracy_percent = (accuracy.avg_accuracy_completion * 100).toFixed(2) + '%';
  }

  sendSuccessResponse(res, accuracy, 'Token estimation accuracy');
}, 'get token estimation accuracy'));

/**
 * GET /admin/token-stats/cost-analysis
 * Get cost analysis
 */
router.get('/cost-analysis', wrapAsync(async (req, res) => {
  const allData = tokenUsageManager.usageData;
  const today = new Date().toISOString().split('T')[0];
  
  // Calculate costs over different periods
  const costAnalysis = {
    total_cost: allData.total.estimated_cost || 0,
    today_cost: allData.daily[today]?.estimated_cost || 0,
    models: {},
    keys: {}
  };

  // Analyze cost by model
  Object.entries(allData.models || {}).forEach(([model, usage]) => {
    costAnalysis.models[model] = {
      requests: usage.requests,
      total_tokens: usage.total_tokens,
      estimated_cost: tokenUsageManager.calculateCost(usage, model)
    };
  });

  // Get the 10 keys with the highest cost
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

  sendSuccessResponse(res, costAnalysis, 'Cost analysis');
}, 'get cost analysis'));

/**
 * POST /admin/token-stats/cleanup
 * Clean up old statistics
 */
router.post('/cleanup', wrapAsync(async (req, res) => {
  tokenUsageManager.cleanupOldData();
  sendSuccessResponse(res, { message: 'Old statistics removed' }, 'Cleanup completed');
}, 'cleanup old stats'));

export default router;
