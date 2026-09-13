/**
 * Request statistics middleware
 * Automatically record token usage and request counts after each API request
 */

import { recordRequest } from '../utils/request-stats.js';
import { logDebug, logError } from '../logger.js';

/**
 * Extract token usage from the response body
 * Supports OpenAI and Anthropic formats
 */
function extractTokenUsage(body, provider = 'openai') {
  try {
    if (!body) return { inputTokens: 0, outputTokens: 0 };

    if (provider === 'anthropic' || body.type === 'message') {
      // Anthropic format
      const usage = body.usage || {};
      return {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0
      };
    }

    // OpenAI format
    const usage = body.usage || {};
    return {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0
    };
  } catch (error) {
    logError('Failed to extract token usage', error);
    return { inputTokens: 0, outputTokens: 0 };
  }
}

/**
 * Statistics tracking middleware
 * Intercept responses and record statistics
 */
export function statsTrackerMiddleware(req, res, next) {
  // Track only selected endpoints
  const trackedPaths = [
    '/v1/chat/completions',
    '/v1/messages',
    '/v1/responses'
  ];

  const shouldTrack = trackedPaths.some(path => req.path.startsWith(path));
  if (!shouldTrack) {
    return next();
  }

  // Save the original res.json and res.send methods
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  // Intercept res.json
  res.json = function (body) {
    // Record statistics
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

      logDebug(`Statistics recorded: ${model}, input=${inputTokens}, output=${outputTokens}, status=${res.statusCode}`);
    } catch (error) {
      logError('Failed to record statistics', error);
    }

    // Call the original method
    return originalJson(body);
  };

  // Intercept res.send (used in some cases)
  res.send = function (body) {
    try {
      // Try parsing JSON
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
      // Ignore non-JSON responses
    }

    return originalSend(body);
  };

  next();
}

/**
 * Streaming response statistics (for SSE)
 * Must be called manually when the stream ends
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
