/**
 * Shared route helpers
 * Common logic extracted from routes.js
 */

import { logError, logDebug, logInfo } from '../logger.js';
import { log403Error } from './error-403-logger.js';
import keyPoolManager from '../auth.js';

/**
 * Get an API key.
 * @param {Request} req - Request object
 * @param {Response} res - Response object
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
      // 🔧 Fix: Check headersSent before sending a response.
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Key pool error',
          message: error.message
        });
      }
      return null;
    }
  }

  return { authHeader, currentKeyId };
}

/**
 * Handle HTTP 402 (insufficient credits).
 * @param {Response} res - Response object
 * @param {string} currentKeyId - Current key ID
 * @param {string} errorText - Error text
 * @returns {boolean} - Whether the error was handled
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
 * Handle HTTP 403 (forbidden).
 * @param {Object} params - Parameter object
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
  
  // Log the HTTP 403 error.
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
      message: 'Request denied, possibly due to a content policy restriction',
      details: errorText
    });
  }
  return true;
}

/**
 * Handle other HTTP errors.
 * @param {Response} res - Response object
 * @param {Response} response - Upstream response
 * @param {string} errorText - Error text
 * @returns {boolean} - Whether the error was handled
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
 * Initialize token statistics for a streaming response.
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
 * Write debug logs.
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
 * Validate the model configuration.
 * @param {Request} req - Request object
 * @param {Response} res - Response object
 * @param {Object} models - Model configuration
 * @param {Object} endpoints - Endpoint configuration
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
 * Set streaming response headers.
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

// Stop pulling upstream events while a slow client is backpressured.
export function writeResponseChunk(res, chunk) {
  if (res.destroyed) throw new Error('Client disconnected');
  if (res.write(chunk)) return;
  return new Promise((resolve, reject) => {
    const cleanup = () => { res.off('drain', drained); res.off('close', closed); res.off('error', failed); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('Client disconnected')); };
    const failed = error => { cleanup(); reject(error); };
    res.once('drain', drained); res.once('close', closed); res.once('error', failed);
    if (res.destroyed) closed();
  });
}
