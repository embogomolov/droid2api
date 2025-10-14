import { logInfo, logDebug, logError } from '../logger.js';
import keyPoolManager from '../auth.js';
import fetchWithPool, { FetchRetryError } from './http-client.js';

/**
 * 从响应中提取Token使用量信息
 * @param {Object} data - 响应数据
 * @param {string} type - 模型类型 (openai/anthropic/common)
 * @returns {Object|null} 使用量信息
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
    logDebug(`提取使用量信息失败: ${error.message}`);
  }
  return null;
}

/**
 * 记录Token使用量（使用更准确的计算方法）
 * @param {Object} data - 响应数据
 * @param {string} modelType - 模型类型
 * @param {string} keyId - 密钥ID
 * @param {Object} request - 原始请求数据（用于验证计算准确性）
 * @param {Object} estimated - 预估的token使用量
 * @param {number} latency - 请求延迟（毫秒）
 */
export function recordTokenUsage(data, modelType, keyId, request = null, estimated = null, latency = null) {
  try {
    const usage = extractUsageFromResponse(data, modelType);

    if (usage && keyId) {
      // 使用token使用量管理器记录
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
        logDebug(`导入token-usage-manager失败: ${err.message}`);
      });

      // 如果有请求数据，验证token计算的准确性
      if (request && request.messages) {
        import('./token-counter.js').then(({ countMessagesTokens }) => {
          const calculatedInputTokens = countMessagesTokens(request.messages, modelType);
          
          // 比较实际值和计算值
          const actualInputTokens = usage.prompt_tokens || usage.input_tokens || 0;
          if (actualInputTokens > 0) {
            const difference = Math.abs(actualInputTokens - calculatedInputTokens);
            const percentDiff = (difference / actualInputTokens * 100).toFixed(1);
            
            if (percentDiff > 10) {
              logDebug(`Token计算差异: 实际=${actualInputTokens}, 计算=${calculatedInputTokens}, 差异=${percentDiff}%`);
            }
          }
        }).catch(err => {
          logDebug(`导入token-counter失败: ${err.message}`);
        });
      }

      // 记录更详细的token使用信息
      const tokenDetails = {
        total: usage.total_tokens || 0,
        input: usage.prompt_tokens || usage.input_tokens || 0,
        output: usage.completion_tokens || usage.output_tokens || 0
      };

      logDebug(`Token使用量 (keyId: ${keyId}): 总计=${tokenDetails.total}, 输入=${tokenDetails.input}, 输出=${tokenDetails.output}`);
    }
  } catch (error) {
    logDebug(`记录Token使用量失败: ${error.message}`);
  }
}

/**
 * 处理402错误 - 自动封禁密钥
 * @param {string} keyId - 密钥ID
 * @param {Response} response - fetch响应对象
 * @param {Object} res - Express响应对象
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
 * 处理上游API错误响应
 * @param {Response} response - fetch响应对象
 * @param {Object} res - Express响应对象
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
 * 处理流式响应
 * @param {Response} upstreamResponse - 上游API响应
 * @param {Object} res - Express响应对象
 * @param {Object|null} transformer - 响应转换器实例 (可选)
 */
export async function handleStreamResponse(upstreamResponse, res, transformer = null) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    if (transformer) {
      // 使用transformer转换流式响应
      for await (const chunk of transformer.transformStream(upstreamResponse.body)) {
        res.write(chunk);
      }
    } else {
      // 直接转发原始流
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
 * 处理非流式响应
 * @param {Response} upstreamResponse - 上游API响应
 * @param {Object} res - Express响应对象
 * @param {string} modelType - 模型类型
 * @param {string} keyId - 密钥ID
 * @param {Function|null} converter - 响应格式转换函数 (可选)
 */
export async function handleNonStreamResponse(upstreamResponse, res, modelType, keyId, converter = null) {
  const data = await upstreamResponse.json();

  // 记录Token使用量
  recordTokenUsage(data, modelType, keyId);

  // 如果有转换函数,尝试转换响应格式
  if (converter) {
    try {
      const converted = converter(data);
      return res.json(converted);
    } catch (e) {
      // 转换失败,返回原始数据
      logDebug(`Response conversion failed, returning original: ${e.message}`);
    }
  }

  // 返回原始响应
  return res.json(data);
}

/**
 * 从密钥池获取下一个可用密钥
 * @returns {Promise<{key: string, keyId: string}>}
 * @throws {Error} 密钥池错误
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
    throw new Error(`密钥池错误: ${error.message}`);
  }
}

/**
 * 统一的上游API调用包装器
 * 自动处理密钥获取、402错误封禁、流式/非流式响应
 *
 * @param {Object} req - Express请求对象
 * @param {Object} res - Express响应对象
 * @param {Object} options - 配置选项
 * @param {string} options.endpoint - 上游API端点URL
 * @param {Object} options.headers - 请求头
 * @param {Object} options.body - 请求体
 * @param {boolean} options.isStreaming - 是否流式响应
 * @param {string} options.modelType - 模型类型 (openai/anthropic/common)
 * @param {Object|null} options.transformer - 流式响应转换器
 * @param {Function|null} options.converter - 非流式响应转换函数
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

  // 获取密钥
  let keyInfo;
  try {
    keyInfo = await getNextKeyFromPool();
  } catch (error) {
    return res.status(500).json({
      error: '密钥池错误',
      message: error.message
    });
  }

  // 调用上游API
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

  // 处理402错误 - 自动封禁密钥
  if (response.status === 402) {
    return await handle402Error(keyInfo.keyId, response, res);
  }

  // 处理其他错误状态
  if (!response.ok) {
    return await handleUpstreamError(response, res);
  }

  // 处理成功响应
  if (isStreaming) {
    await handleStreamResponse(response, res, transformer);
  } else {
    await handleNonStreamResponse(response, res, modelType, keyInfo.keyId, converter);
  }
}
