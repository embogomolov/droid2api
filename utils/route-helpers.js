import { logInfo, logDebug, logError } from '../logger.js';
import keyPoolManager from '../auth.js';
import fetchWithPool, { FetchRetryError } from './http-client.js';

/**
 * Extract token usage from a response.
 * @param {Object} data - Response data
 * @param {string} type - Model type (openai/anthropic/common)
 * @returns {Object|null} Usage information
 */
export function extractUsageFromResponse(data, type) {
  try {
    if (type === 'openai') {
      if (data.usage) {
        return {
          total_tokens: data.usage.total_tokens || 0,
          prompt_tokens: data.usage.prompt_tokens || 0,
          completion_tokens: data.usage.completion_tokens || 0
        };
      }
    } else if (type === 'anthropic') {
      if (data.usage) {
        return {
          total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
          prompt_tokens: data.usage.input_tokens || 0,
          completion_tokens: data.usage.output_tokens || 0
        };
      }
    } else if (type === 'common') {
      if (data.usage) {
        if (data.usage.total_tokens) {
          return {
            total_tokens: data.usage.total_tokens || 0,
            prompt_tokens: data.usage.prompt_tokens || 0,
            completion_tokens: data.usage.completion_tokens || 0
          };
        }
        if (data.usage.input_tokens || data.usage.output_tokens) {
          return {
            total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
            prompt_tokens: data.usage.input_tokens || 0,
            completion_tokens: data.usage.output_tokens || 0
          };
        }
      }
    }
  } catch (error) {
    logDebug(`Failed to extract usage information: ${error.message}`);
  }
  return null;
}

/**
 * Record token usage using more accurate counting.
 * @param {Object} data - Response data
 * @param {string} modelType - Model type
 * @param {string} keyId - Key ID
 * @param {Object} request - Original request data, used to verify counting accuracy
 * @param {Object} estimated - Estimated token usage
 * @param {number} latency - Request latency in milliseconds
 */
export function recordTokenUsage(data, modelType, keyId, request = null, estimated = null, latency = null) {
  try {
    const usage = extractUsageFromResponse(data, modelType);

    if (usage && keyId) {
      // Record usage with the token usage manager.
      import('./token-usage-manager.js').then(module => {
        const tokenUsageManager = module.default;
        tokenUsageManager.recordUsage({
          keyId,
          model: modelType,
          usage,
          estimated,
          latency
        });
      }).catch(err => {
        logDebug(`Failed to import token-usage-manager: ${err.message}`);
      });

      // Verify token counting accuracy when request data is available.
      if (request && request.messages) {
        import('./token-counter.js').then(({ countMessagesTokens }) => {
          const calculatedInputTokens = countMessagesTokens(request.messages, modelType);
          
          // Compare the reported and calculated values.
          const actualInputTokens = usage.prompt_tokens || usage.input_tokens || 0;
          if (actualInputTokens > 0) {
            const difference = Math.abs(actualInputTokens - calculatedInputTokens);
            const percentDiff = (difference / actualInputTokens * 100).toFixed(1);
            
            if (percentDiff > 10) {
              logDebug(`Token count discrepancy: reported=${actualInputTokens}, calculated=${calculatedInputTokens}, difference=${percentDiff}%`);
            }
          }
        }).catch(err => {
          logDebug(`Failed to import token-counter: ${err.message}`);
        });
      }

      // Log detailed token usage.
      const tokenDetails = {
        total: usage.total_tokens || 0,
        input: usage.prompt_tokens || usage.input_tokens || 0,
        output: usage.completion_tokens || usage.output_tokens || 0
      };

      logDebug(`Token usage (keyId: ${keyId}): total=${tokenDetails.total}, input=${tokenDetails.input}, output=${tokenDetails.output}`);
    }
  } catch (error) {
    logDebug(`Failed to record token usage: ${error.message}`);
  }
}

/**
 * Handle HTTP 402 by automatically disabling the key.
 * @param {string} keyId - Key ID
 * @param {Response} response - Fetch response object
 * @param {Object} res - Express response object
 */
export async function handle402Error(keyId, response, res) {
  keyPoolManager.disableKey(keyId, '402: Payment Required - No Credits');
  const errorText = await response.text();
  logError(`Key disabled due to 402 error: ${keyId}`, new Error(errorText));

  return res.status(402).json({
    error: 'Payment Required',
    message: 'Key has been disabled due to insufficient credits',
    details: errorText
  });
}

/**
 * Handle upstream API error responses.
 * @param {Response} response - Fetch response object
 * @param {Object} res - Express response object
 */
export async function handleUpstreamError(response, res) {
  const errorText = await response.text();
  logError(`Endpoint error: ${response.status}`, new Error(errorText));

  return res.status(response.status).json({
    error: `Endpoint returned ${response.status}`,
    details: errorText
  });
}

/**
 * Handle streaming responses.
 * @param {Response} upstreamResponse - Upstream API response
 * @param {Object} res - Express response object
 * @param {Object|null} transformer - Response transformer instance (optional)
 */
export async function handleStreamResponse(upstreamResponse, res, transformer = null) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    if (transformer) {
      // Transform the streaming response using the transformer.
      for await (const chunk of transformer.transformStream(upstreamResponse.body)) {
        res.write(chunk);
      }
    } else {
      // Forward the original stream directly.
      for await (const chunk of upstreamResponse.body) {
        res.write(chunk);
      }
    }
    res.end();
    logInfo('Stream completed');
  } catch (streamError) {
    logError('Stream error', streamError);
    res.end();
  }
}

/**
 * Handle non-streaming responses.
 * @param {Response} upstreamResponse - Upstream API response
 * @param {Object} res - Express response object
 * @param {string} modelType - Model type
 * @param {string} keyId - Key ID
 * @param {Function|null} converter - Response format converter (optional)
 */
export async function handleNonStreamResponse(upstreamResponse, res, modelType, keyId, converter = null) {
  const data = await upstreamResponse.json();

  // Record token usage.
  recordTokenUsage(data, modelType, keyId);

  // If a converter is provided, try to convert the response format.
  if (converter) {
    try {
      const converted = converter(data);
      return res.json(converted);
    } catch (e) {
      // Return the original data if conversion fails.
      logDebug(`Response conversion failed, returning original: ${e.message}`);
    }
  }

  // Return the original response.
  return res.json(data);
}

/**
 * Get the next available key from the pool.
 * @returns {Promise<{key: string, keyId: string}>}
 * @throws {Error} Key pool error
 */
export async function getNextKeyFromPool() {
  try {
    const keyResult = await keyPoolManager.getNextKey();
    return {
      key: keyResult.key,
      keyId: keyResult.keyId,
      authHeader: `Bearer ${keyResult.key}`
    };
  } catch (error) {
    logError('Failed to get API key from pool', error);
    throw new Error(`Key pool error: ${error.message}`);
  }
}

/**
 * Shared wrapper for upstream API calls
 * Handle key selection, disabling keys on HTTP 402, and streaming/non-streaming responses.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Object} options - Configuration options
 * @param {string} options.endpoint - Upstream API endpoint URL
 * @param {Object} options.headers - Request headers
 * @param {Object} options.body - Request body
 * @param {boolean} options.isStreaming - Whether the response is streamed
 * @param {string} options.modelType - Model type (openai/anthropic/common)
 * @param {Object|null} options.transformer - Streaming response transformer
 * @param {Function|null} options.converter - Non-streaming response converter
 */
export async function executeUpstreamRequest(req, res, options) {
  const {
    endpoint,
    headers,
    body,
    isStreaming,
    modelType,
    transformer = null,
    converter = null
  } = options;

  // Get a key.
  let keyInfo;
  try {
    keyInfo = await getNextKeyFromPool();
  } catch (error) {
    return res.status(500).json({
      error: 'Key pool error',
      message: error.message
    });
  }

  // Call the upstream API.
  let response;
  const requestBody = typeof body === 'string' ? body : JSON.stringify(body);

  try {
    response = await fetchWithPool(endpoint, {
      method: 'POST',
      headers,
      body: requestBody,
      maxRetries: 1
    });
  } catch (fetchError) {
    if (fetchError instanceof FetchRetryError) {
      logError('Upstream retry exhausted', fetchError);
      if (!res.headersSent) {
        return res.status(504).json({
          error: 'Upstream retry exhausted',
          message: fetchError.message,
          attempts: fetchError.attempts
        });
      }
      return;
    }
    logError('Failed to call upstream API', fetchError);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Upstream API call failed',
        message: fetchError.message
      });
    }
    return;
  }

  logInfo(`Response status: ${response.status}`);

  // Handle HTTP 402 by automatically disabling the key.
  if (response.status === 402) {
    return await handle402Error(keyInfo.keyId, response, res);
  }

  // Handle other error statuses.
  if (!response.ok) {
    return await handleUpstreamError(response, res);
  }

  // Handle a successful response.
  if (isStreaming) {
    await handleStreamResponse(response, res, transformer);
  } else {
    await handleNonStreamResponse(response, res, modelType, keyInfo.keyId, converter);
  }
}
