/**
 * 请求统计追踪中间件
 * 在每次 API 请求后自动记录 Token 使用量和请求次数
 */

import { recordRequest } from '../utils/request-stats.js';
import { logDebug, logError } from '../logger.js';

/**
 * 从响应体中提取 Token 使用量
 * 支持 OpenAI 和 Anthropic 格式
 */
function extractTokenUsage(body, provider = 'openai') {
  try {
    if (!body) return { inputTokens: 0, outputTokens: 0 };

    if (provider === 'anthropic' || body.type === 'message') {
      // Anthropic 格式
      const usage = body.usage || {};
      return {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0
      };
    }

    // OpenAI 格式
    const usage = body.usage || {};
    return {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0
    };
  } catch (error) {
    logError('提取Token使用量失败', error);
    return { inputTokens: 0, outputTokens: 0 };
  }
}

/**
 * 统计追踪中间件
 * 拦截响应并记录统计数据
 */
export function statsTrackerMiddleware(req, res, next) {
  // 只追踪特定端点
  const trackedPaths = [
    '/v1/chat/completions',
    '/v1/messages',
    '/v1/responses'
  ];

  const shouldTrack = trackedPaths.some(path => req.path.startsWith(path));
  if (!shouldTrack) {
    return next();
  }

  // 保存原始的 res.json 和 res.send 方法
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  // 拦截 res.json
  res.json = function (body) {
    // 记录统计
    try {
      const model = req.body?.model || 'unknown';
      const success = res.statusCode >= 200 && res.statusCode < 400;
      const { inputTokens, outputTokens } = extractTokenUsage(body);

      recordRequest({
        inputTokens,
        outputTokens,
        model,
        success
      });

      logDebug(`统计已记录: ${model}, input=${inputTokens}, output=${outputTokens}, status=${res.statusCode}`);
    } catch (error) {
      logError('记录统计失败', error);
    }

    // 调用原始方法
    return originalJson(body);
  };

  // 拦截 res.send (某些情况下使用)
  res.send = function (body) {
    try {
      // 尝试解析 JSON
      if (typeof body === 'string') {
        const parsed = JSON.parse(body);
        const model = req.body?.model || 'unknown';
        const success = res.statusCode >= 200 && res.statusCode < 400;
        const { inputTokens, outputTokens } = extractTokenUsage(parsed);

        recordRequest({
          inputTokens,
          outputTokens,
          model,
          success
        });
      }
    } catch (error) {
      // 忽略非 JSON 响应
    }

    return originalSend(body);
  };

  next();
}

/**
 * 流式响应统计追踪（用于 SSE）
 * 需要在流结束时手动调用
 */
export function recordStreamingRequest({ inputTokens, outputTokens, model, success = true }) {
  recordRequest({
    inputTokens,
    outputTokens,
    model,
    success
  });
}

export default statsTrackerMiddleware;
