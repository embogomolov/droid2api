/**
 * 路由公共函数
 * 提取routes.js中的重复代码
 */

import { logError, logDebug, logInfo } from '../logger.js';
import { log403Error } from './error-403-logger.js';
import keyPoolManager from '../auth.js';

/**
 * 获取API密钥
 * @param {Request} req - 请求对象
 * @param {Response} res - 响应对象
 * @returns {Promise<{authHeader: string, currentKeyId: string}|null>}
 */
export async function getApiKey(req, res) {
  let authHeader = req.headers['authorization'];
  let currentKeyId = null;

  if (!authHeader || authHeader === 'Bearer undefined') {
    try {
      const keyResult = await keyPoolManager.getNextKey();
      authHeader = `Bearer ${keyResult.key}`;
      currentKeyId = keyResult.keyId;
    } catch (error) {
      logError('Failed to get API key from pool', error);
      // 🔧 修复：添加headersSent检查
      if (!res.headersSent) {
        res.status(500).json({
          error: '密钥池错误',
          message: error.message
        });
      }
      return null;
    }
  }

  return { authHeader, currentKeyId };
}

/**
 * 处理402错误（余额不足）
 * @param {Response} res - 响应对象
 * @param {string} currentKeyId - 当前密钥ID
 * @param {string} errorText - 错误文本
 * @returns {boolean} - 是否已处理
 */
export function handle402Error(res, currentKeyId, errorText) {
  if (currentKeyId) {
    keyPoolManager.disableKey(currentKeyId, '402 Payment Required');
  }
  
  if (!res.headersSent) {
    res.status(402).json({
      error: 'Payment Required',
      message: 'No credits remaining',
      details: errorText
    });
  }
  return true;
}

/**
 * 处理403错误（禁止访问）
 * @param {Object} params - 参数对象
 */
export async function handle403Error({
  res, 
  currentKeyId, 
  errorText, 
  req, 
  modelId, 
  originalRequest,
  transformedRequest
}) {
  logError(`403 Forbidden error with key: ${currentKeyId}`, new Error(errorText));
  
  // 记录403错误日志
  await log403Error({
    keyId: currentKeyId,
    endpoint: req.path,
    modelId: modelId,
    originalRequest: originalRequest,
    transformedRequest: transformedRequest,
    errorDetails: errorText,
    headers: req.headers
  });

  if (currentKeyId) {
    keyPoolManager.incrementErrorCount(currentKeyId);
  }
  
  if (!res.headersSent) {
    res.status(403).json({
      error: 'Forbidden',
      message: '请求被拒绝，可能触发了内容策略',
      details: errorText
    });
  }
  return true;
}

/**
 * 处理其他HTTP错误
 * @param {Response} res - 响应对象
 * @param {Response} response - 上游响应
 * @param {string} errorText - 错误文本
 * @returns {boolean} - 是否已处理
 */
export function handleHttpError(res, response, errorText) {
  if (!res.headersSent) {
    res.status(response.status).json({
      error: `HTTP ${response.status}`,
      message: response.statusText,
      details: errorText
    });
  }
  return true;
}

/**
 * 处理流式响应的Token统计
 */
export function createTokenStats() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  };
}

/**
 * 记录调试日志
 */
export function logClientHeaders(clientHeaders) {
  logDebug('Client headers received', {
    'x-factory-client': clientHeaders['x-factory-client'],
    'x-session-id': clientHeaders['x-session-id'],
    'x-assistant-message-id': clientHeaders['x-assistant-message-id'],
    'user-agent': clientHeaders['user-agent']
  });
}

/**
 * 验证模型配置
 * @param {Request} req - 请求对象
 * @param {Response} res - 响应对象
 * @param {Object} models - 模型配置
 * @param {Object} endpoints - 端点配置
 * @returns {{model: Object, endpoint: Object, modelId: string}|null}
 */
export function validateModel(req, res, models, endpoints) {
  const modelId = req.body.model;
  
  if (!modelId) {
    if (!res.headersSent) {
      res.status(400).json({ error: 'model is required' });
    }
    return null;
  }

  const model = models[modelId];
  if (!model) {
    if (!res.headersSent) {
      res.status(404).json({ error: `Model ${modelId} not found` });
    }
    return null;
  }

  const endpoint = endpoints.find(e => e.name === model.type);
  if (!endpoint) {
    if (!res.headersSent) {
      res.status(500).json({ error: `Endpoint type ${model.type} not found` });
    }
    return null;
  }

  return { model, endpoint, modelId };
}

/**
 * 设置流式响应头
 */
export function setStreamingHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
}

export default {
  getApiKey,
  handle402Error,
  handle403Error,
  handleHttpError,
  createTokenStats,
  logClientHeaders,
  validateModel,
  setStreamingHeaders
};
