import express from 'express';
import fetch from 'node-fetch';
import { getConfig, getModelById, getEndpointByType, getSystemPrompt, getModelReasoning } from './config.js';
import { logInfo, logDebug, logError, logWarn, logRequest, logResponse } from './logger.js';
import { transformToAnthropic, getAnthropicHeaders } from './transformers/request-anthropic.js';
import { transformToOpenAI, getOpenAIHeaders } from './transformers/request-openai.js';
import { transformToCommon, getCommonHeaders } from './transformers/request-common.js';
import { AnthropicResponseTransformer } from './transformers/response-anthropic.js';
import { OpenAIResponseTransformer } from './transformers/response-openai.js';
import keyPoolManager from './auth.js';
import fetchWithPool, { FetchRetryError } from './utils/http-client.js';
import {
  getNextKeyFromPool,
  handleUpstreamError,
  handleStreamResponse,
  handleNonStreamResponse,
  recordTokenUsage
} from './utils/route-helpers.js';
import {
  extractAnthropicTokens,
  extractOpenAITokens,
  extractCommonTokens
} from './utils/token-extractor.js';
import {
  countMessagesTokens,
  estimateRequestTokens,
  normalizeTokenStats
} from './utils/token-counter.js';
import { log403Error } from './utils/error-403-logger.js';
// 🔧 Optimization: import shared functions to remove duplicate code
import {
  getApiKey,
  handle402Error,
  handle403Error,
  handleHttpError,
  createTokenStats,
  logClientHeaders,
  validateModel,
  setStreamingHeaders
} from './utils/route-common.js';
const router = express.Router();



/**
 * BaSui: Convert Anthropic Messages API responses to OpenAI Chat Completions format
 * For non-streaming responses
 */
function convertAnthropicToChatCompletion(anthropicResp) {
  if (!anthropicResp || typeof anthropicResp !== 'object') {
    throw new Error('Invalid Anthropic response object');
  }

  // Extract text content and tool calls
  const content = [];
  const toolCalls = [];
  
  if (anthropicResp.content && Array.isArray(anthropicResp.content)) {
    for (const block of anthropicResp.content) {
      if (block.type === 'text') {
        content.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input)
          }
        });
      }
    }
  }

  // Map stop_reason
  let finishReason = 'stop';
  if (anthropicResp.stop_reason === 'end_turn') {
    finishReason = 'stop';
  } else if (anthropicResp.stop_reason === 'max_tokens') {
    finishReason = 'length';
  } else if (anthropicResp.stop_reason === 'tool_use') {
    finishReason = 'tool_calls';
  }

  const message = {
    role: 'assistant',
    content: content.join('')
  };

  // Add tool calls, if present, to message
  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const chatCompletion = {
    id: anthropicResp.id ? anthropicResp.id.replace(/^msg_/, 'chatcmpl-') : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicResp.model || 'unknown-model',
    choices: [
      {
        index: 0,
        message: message,
        finish_reason: finishReason
      }
    ],
    usage: {
      prompt_tokens: anthropicResp.usage?.input_tokens ?? 0,
      completion_tokens: anthropicResp.usage?.output_tokens ?? 0,
      total_tokens: (anthropicResp.usage?.input_tokens ?? 0) + (anthropicResp.usage?.output_tokens ?? 0)
    }
  };

  return chatCompletion;
}

/**
 * Convert a /v1/responses API result to a /v1/chat/completions-compatible format.
 * Works for non-streaming responses.
 */
function convertResponseToChatCompletion(resp) {
  if (!resp || typeof resp !== 'object') {
    throw new Error('Invalid response object');
  }

  const outputMsg = (resp.output || []).find(o => o.type === 'message');
  const textBlocks = outputMsg?.content?.filter(c => c.type === 'output_text') || [];
  const content = textBlocks.map(c => c?.text || '').join('');

  const chatCompletion = {
    id: resp.id ? resp.id.replace(/^resp_/, 'chatcmpl-') : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: resp.created_at || Math.floor(Date.now() / 1000),
    model: resp.model || 'unknown-model',
    choices: [
      {
        index: 0,
        message: {
          role: outputMsg?.role || 'assistant',
          content: content || ''
        },
        finish_reason: resp.status === 'completed' ? 'stop' : 'unknown'
      }
    ],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: resp.usage?.total_tokens ?? 0
    }
  };

  return chatCompletion;
}

router.get('/v1/models', (req, res) => {
  logInfo('GET /v1/models');
  
  try {
    const config = getConfig();
    const models = config.models.map(model => ({
      id: model.id,
      object: 'model',
      created: Date.now(),
      owned_by: model.type,
      permission: [],
      root: model.id,
      parent: null
    }));

    const response = {
      object: 'list',
      data: models
    };

    logResponse(200, null, response);
    res.json(response);
  } catch (error) {
    logError('Error in GET /v1/models', error);
    // 🔧 Fix: check headersSent
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Standard OpenAI Chat Completions handler (with format conversion and automatic retries)
async function handleChatCompletions(req, res) {
  logInfo('POST /v1/chat/completions');
  
  // Record request start time (for latency calculation)
  req.startTime = Date.now();
  
  // 最大重试次数（使用密钥池中的活动密钥数量，但最多5次，别成无限火力）
  const activeKeys = keyPoolManager.getActiveKeyCount();
  const maxRetries = Math.min(activeKeys > 0 ? activeKeys : 1, 5);
  let retryCount = 0;
  let lastError = null;
  
  try {
    const openaiRequest = req.body;
    const modelId = openaiRequest.model;

    if (!modelId) {
      return res.status(400).json({ error: 'Missing required parameter: model' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model not found: ${modelId}` });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `Endpoint type not found: ${model.type}` });
    }

    logInfo(`Routing to ${model.type} endpoint: ${endpoint.base_url}`);

    // 🎯 Token estimation: estimate token usage before the request
    const estimatedTokens = estimateRequestTokens(openaiRequest, modelId);
    logInfo(`Token预估 - 模型: ${modelId}, 输入: ${estimatedTokens.estimated_prompt_tokens}, 预计输出: ${estimatedTokens.estimated_completion_tokens}, 总计: ${estimatedTokens.estimated_total_tokens}`);

    // 重试循环 - 除了403错误外，其他错误都重试
    while (retryCount < maxRetries) {
      // 🔧 优化：使用公共函数获取API密钥
      const keyResult = await getApiKey(req, res);
      if (!keyResult) {
        if (retryCount === 0) return;
        retryCount++;
        logWarn(`获取密钥失败，正在重试 ${retryCount}/${maxRetries}...`);
        continue;
      }
      const { authHeader, currentKeyId } = keyResult;

    let transformedRequest;
    let headers;
    const clientHeaders = req.headers;

    // Log received client headers for debugging
    logDebug('Client headers received', {
      'x-factory-client': clientHeaders['x-factory-client'],
      'x-session-id': clientHeaders['x-session-id'],
      'x-assistant-message-id': clientHeaders['x-assistant-message-id'],
      'user-agent': clientHeaders['user-agent']
    });

    // BaSui: Select the appropriate transformer for the model type
    // All models accept the same OpenAI input format; transformers adapt it to the target API
    if (model.type === 'anthropic') {
      // Use backend_model as the actual model ID when configured (for model aliases)
      const backendModel = model.backend_model || null;
      transformedRequest = transformToAnthropic(openaiRequest, backendModel);
      const isStreaming = openaiRequest.stream === true;
      headers = getAnthropicHeaders(authHeader, clientHeaders, isStreaming, modelId);
      
      if (backendModel) {
        logInfo(`Model mapping: ${modelId} → ${backendModel}`);
      }
    } else if (model.type === 'openai') {
      transformedRequest = transformToOpenAI(openaiRequest);
      headers = getOpenAIHeaders(authHeader, clientHeaders);
    } else if (model.type === 'common') {
      transformedRequest = transformToCommon(openaiRequest);
      headers = getCommonHeaders(authHeader, clientHeaders);
    } else {
      return res.status(500).json({ error: `Unknown model type: ${model.type}` });
    }

    logRequest('POST', endpoint.base_url, headers, transformedRequest);

    // BaSui：🚀 使用 HTTP 连接池（复用 TCP 连接，减少握手开销）
    const response = await fetchWithPool(endpoint.base_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(transformedRequest),
      maxRetries: 1
    });

    logInfo(`Response status: ${response.status}`);

    // 处理402错误 - 封禁密钥并重试
    if (response.status === 402) {
      const errorText = await response.text();
      if (currentKeyId) {
        keyPoolManager.disableKey(currentKeyId, '402: 密钥余额不足');
      }
      logError(`密钥 ${currentKeyId} 因402错误被禁用，准备重试...`);
      lastError = { status: 402, message: '密钥余额不足', details: errorText };
      retryCount++;
      
      // 如果还有其他密钥，继续重试
      if (retryCount < maxRetries) {
        logInfo(`正在切换到下一个密钥... (重试 ${retryCount}/${maxRetries})`);
        continue;
      } else {
        // 所有密钥都用尽了
        return res.status(402).json({
          error: '余额不足',
          message: '所有可用密钥余额都已耗尽',
          attempts: retryCount
        });
      }
    }

    // BaSui：处理403错误 - 内容违规，直接返回用户，提醒清除上下文
    if (response.status === 403) {
      const errorText = await response.text();
      logError(`403错误 - 内容可能违规，密钥: ${currentKeyId}`, new Error(errorText));
      
      // 记录403错误详情
      await handle403Error({
        res: null, currentKeyId, errorText, req, modelId,
        originalRequest: openaiRequest,
        transformedRequest: transformedRequest
      });
      
      // 返回给用户，提醒清除上下文
      return res.status(403).json({
        error: '内容违规',
        message: '您的请求可能包含敏感内容，请清除上下文后重试。如果问题持续存在，请尝试修改您的提示词。',
        details: errorText
      });
    }

    // 处理其他非2xx错误 - 自动重试
    if (!response.ok) {
      const errorText = await response.text();
      logError(`API错误 ${response.status}，密钥: ${currentKeyId}，准备重试...`, new Error(errorText));
      lastError = { status: response.status, message: `API返回错误 ${response.status}`, details: errorText };
      
      // 对于5xx错误，增加密钥错误计数
      if (response.status >= 500) {
        keyPoolManager.incrementErrorCount(currentKeyId);
      }
      
      retryCount++;
      
      // 如果还有重试机会，继续
      if (retryCount < maxRetries) {
        logInfo(`正在切换到下一个密钥... (重试 ${retryCount}/${maxRetries})`);
        continue;
      } else {
        // 重试次数用尽
        return res.status(response.status).json({
          error: `上游服务错误`,
          message: `请求在尝试 ${retryCount} 个密钥后失败`,
          lastError: lastError,
          attempts: retryCount
        });
      }
    }

    const isStreaming = transformedRequest.stream === true;

    if (isStreaming) {
      // 🔧 Optimization: use the shared function to set streaming response headers
      setStreamingHeaders(res);

      // BaSui: Collect token statistics from streaming responses (including thinking and cache tokens)
      const tokenStats = createTokenStats();

      // common type is forwarded directly without using transformer
      if (model.type === 'common') {
        try {
          let buffer = '';
          for await (const chunk of response.body) {
            res.write(chunk);

            // BaSui: Parse the SSE stream to extract token usage
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data:')) {
                try {
                  const dataStr = line.slice(5).trim();
                  if (dataStr === '[DONE]') continue;
                  const data = JSON.parse(dataStr);
                  // Use the new token extraction helper
                  extractCommonTokens(data, tokenStats);
                } catch (e) {
                  // Ignore non-JSON lines
                }
              }
            }
          }
          res.end();
          logInfo('Stream forwarded (common type)');
        } catch (streamError) {
          logError('Stream error', streamError);
          res.end();
        }
      } else {
        // anthropic and openai types use transformer
        let transformer;
        let buffer = '';

        if (model.type === 'anthropic') {
          transformer = new AnthropicResponseTransformer(modelId, `chatcmpl-${Date.now()}`);
        } else if (model.type === 'openai') {
          transformer = new OpenAIResponseTransformer(modelId, `chatcmpl-${Date.now()}`);
        }

        try {
          // BaSui: 🔧 Fix memory leaks: stream data with a maximum buffer size
          const MAX_BUFFER_SIZE = 50 * 1024 * 1024; // 50MB maximum buffer
          let bufferSize = 0;
          const rawChunks = [];
          let isOversized = false;

          // Stream data, converting and sending as it arrives
          for await (const chunk of response.body) {
            // Check buffer size
            bufferSize += chunk.length;
            if (bufferSize > MAX_BUFFER_SIZE) {
              logError(`Response too large: ${bufferSize} bytes (max: ${MAX_BUFFER_SIZE})`);
              isOversized = true;
              // Forward oversized responses directly without further accumulation
              if (transformer) {
                const chunkStream = (async function* () { yield chunk; })();
                for await (const transformed of transformer.transformStream(chunkStream)) {
                  res.write(transformed);
                }
              } else {
                res.write(chunk);
              }
            } else {
              // Accumulate normal-sized responses for token statistics
              rawChunks.push(chunk);
            }
          }

          if (!isOversized) {
            // Calculate token statistics only for normal-sized responses
            let buffer = '';  // 🔧 Fix: declare the buffer variable
            for (const chunk of rawChunks) {
              buffer += chunk.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('data:')) {
                  try {
                    const dataStr = line.slice(5).trim();
                    if (dataStr === '[DONE]') continue;

                    const data = JSON.parse(dataStr);

                    if (model.type === 'anthropic') {
                      extractAnthropicTokens(data, tokenStats);
                    } else {
                      extractOpenAITokens(data, tokenStats);
                    }
                  } catch (e) {
                    // Ignore non-JSON lines
                  }
                }
              }
            }

            // Convert and forward accumulated chunks
            const rawStream = (async function* () {
              for (const chunk of rawChunks) {
                yield chunk;
              }
            })();

            for await (const chunk of transformer.transformStream(rawStream)) {
              res.write(chunk);
            }
          }
          
          res.end();
          logInfo('Stream completed');
        } catch (streamError) {
          logError('Stream error', streamError);
          if (!res.headersSent) {
            res.status(500).json({ error: '流处理错误' });
          } else {
            res.end();
          }
        }
      }

      // BaSui: Record token usage statistics (all supported token types)
      try {
        if (tokenStats.inputTokens > 0 || tokenStats.outputTokens > 0) {
          const { recordRequest } = await import('./utils/request-stats.js');
          recordRequest({
            inputTokens: tokenStats.inputTokens,
            outputTokens: tokenStats.outputTokens,
            thinkingTokens: tokenStats.thinkingTokens,
            cacheCreationTokens: tokenStats.cacheCreationTokens,
            cacheReadTokens: tokenStats.cacheReadTokens,
            model: modelId,
            success: true
          });
          logDebug(`Streaming response token statistics (/v1/chat/completions): input=${tokenStats.inputTokens}, output=${tokenStats.outputTokens}, thinking=${tokenStats.thinkingTokens}, cache_creation=${tokenStats.cacheCreationTokens}, cache_read=${tokenStats.cacheReadTokens}`);
        }
      } catch (err) {
        logError('Failed to record token statistics', err);
      }
    } else {
      // 🔧 Fix: handle JSON parsing errors
      let data;
      try {
        data = await response.json();
      } catch (jsonError) {
        logError('Failed to parse JSON response', jsonError);
        // 🔧 Fix: the response body has already been consumed and cannot be read again
        return res.status(502).json({
          error: 'Invalid JSON response from upstream',
          details: jsonError.message
        });
      }

      // Record token usage (including estimates and latency)
      const requestLatency = Date.now() - req.startTime; // startTime must be recorded at request start
      recordTokenUsage(data, model.type, currentKeyId, openaiRequest, estimatedTokens, requestLatency);

      if (model.type === 'anthropic') {
        // BaSui: Convert the Anthropic response to OpenAI format
        try {
          const converted = convertAnthropicToChatCompletion(data);
          logResponse(200, null, converted);
          res.json(converted);
        } catch (e) {
          logError('Anthropic response conversion failed', e);
          // Fall back to the original data if conversion fails
          logResponse(200, null, data);
          res.json(data);
        }
      } else if (model.type === 'openai') {
        try {
          const converted = convertResponseToChatCompletion(data);
          logResponse(200, null, converted);
          res.json(converted);
        } catch (e) {
          // Fall back to the original data if conversion fails
          logResponse(200, null, data);
          res.json(data);
        }
      } else {
        // common: Forward directly
        logResponse(200, null, data);
        res.json(data);
      }
    }
    
    // 请求成功，跳出重试循环
    break;
    
    } // 结束 while 循环

  } catch (error) {
    if (error instanceof FetchRetryError) {
      logError('Upstream retry exhausted in /v1/chat/completions', error);
      if (!res.headersSent) {
        res.status(504).json({
          error: 'Upstream service retries exhausted',
          message: `Request failed: ${error.message}`,
          attempts: error.attempts
        });
      } else {
        res.end();
      }
      return;
    }

    logError('Error in /v1/chat/completions', error);
    // BaSui: Check whether the response has started to prevent errors from sending it twice
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: `Server processing error: ${error.message}`
      });
    } else {
      // Streaming response has started; end the connection
      res.end();
    }
  }
}

// Forward OpenAI requests directly (without format conversion)
async function handleDirectResponses(req, res) {
  logInfo('POST /v1/responses');
  
  try {
    const openaiRequest = req.body;
    const modelId = openaiRequest.model;

    if (!modelId) {
      return res.status(400).json({ error: 'Missing required parameter: model' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model not found: ${modelId}` });
    }

    // Allow only openai endpoint types
    if (model.type !== 'openai') {
      return res.status(400).json({
        error: 'Invalid endpoint type',
        message: `/v1/responses endpoint supports only openai endpoints; model ${modelId} has type ${model.type}`
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `Endpoint type not found: ${model.type}` });
    }

    logInfo(`Direct forwarding to ${model.type} endpoint: ${endpoint.base_url}`);

    const clientHeaders = req.headers;

    // Inject the system prompt into the instructions field
    const systemPrompt = getSystemPrompt();
    const modifiedRequest = { ...openaiRequest };
    if (systemPrompt) {
      if (modifiedRequest.instructions) {
        modifiedRequest.instructions = systemPrompt + modifiedRequest.instructions;
      } else {
        modifiedRequest.instructions = systemPrompt;
      }
    }

    // Handle the reasoning field
    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') {
      // Auto mode: preserve the original request reasoning field
    } else if (reasoningLevel && ['low', 'medium', 'high'].includes(reasoningLevel)) {
      modifiedRequest.reasoning = {
        effort: reasoningLevel,
        summary: 'auto'
      };
    } else {
      delete modifiedRequest.reasoning;
    }

    const activeKeys = keyPoolManager.getActiveKeyCount() || 1;
    const maxRetries = Math.min(activeKeys, 5);
    let retryCount = 0;
    let lastError = null;

    while (retryCount < maxRetries) {
      const keyResult = await getApiKey(req, res);
      if (!keyResult) {
        if (retryCount === 0) {
          return;
        }
        retryCount++;
        logWarn(`获取密钥失败，正在重试 ${retryCount}/${maxRetries}...`);
        continue;
      }

      const { authHeader, currentKeyId } = keyResult;
      const headers = getOpenAIHeaders(authHeader, clientHeaders);

      logRequest('POST', endpoint.base_url, headers, modifiedRequest);

      const response = await fetchWithPool(endpoint.base_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(modifiedRequest),
        maxRetries: 1
      });

      logInfo(`Response status: ${response.status}`);

      // BaSui：402来了，当前密钥请回到休息区，换下一个扛锅
      if (response.status === 402) {
        const errorText = await response.text();
        if (currentKeyId) {
          keyPoolManager.disableKey(currentKeyId, '402: 密钥余额不足');
        }
        logError(`密钥 ${currentKeyId || 'unknown'} 因402错误被禁用，准备重试...`);
        lastError = { status: 402, message: '密钥余额不足', details: errorText };
        retryCount++;

        if (retryCount < maxRetries) {
          logInfo(`正在切换到下一个密钥... (重试 ${retryCount}/${maxRetries})`);
          continue;
        }

        return res.status(402).json({
          error: '余额不足',
          message: '所有可用密钥余额都已耗尽',
          attempts: retryCount
        });
      }

      // 403属于内容违规，提示用户清理上下文
      if (response.status === 403) {
        const errorText = await response.text();
        await handle403Error({
          res, currentKeyId, errorText, req, modelId,
          originalRequest: openaiRequest,
          transformedRequest: modifiedRequest
        });
        return;
      }

      if (!response.ok) {
        const errorText = await response.text();
        logError(`Endpoint error: ${response.status}`, new Error(errorText));
        lastError = {
          status: response.status,
          message: `API返回错误 ${response.status}`,
          details: errorText
        };

        if (currentKeyId && response.status >= 500) {
          keyPoolManager.incrementErrorCount(currentKeyId);
        }

        retryCount++;
        if (retryCount < maxRetries) {
          logInfo(`正在切换到下一个密钥... (重试 ${retryCount}/${maxRetries})`);
          continue;
        }

        return res.status(response.status).json({
          error: `上游服务错误`,
          message: `请求在尝试 ${retryCount} 个密钥后失败`,
          lastError,
          attempts: retryCount
        });
      }

      const isStreaming = openaiRequest.stream === true;

      if (isStreaming) {
        setStreamingHeaders(res);

        try {
          const tokenStats = createTokenStats();
          let buffer = '';

          for await (const chunk of response.body) {
            res.write(chunk);

            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data:')) {
                try {
                  const dataStr = line.slice(5).trim();
                  if (dataStr === '[DONE]') continue;

                  const data = JSON.parse(dataStr);
                  extractOpenAITokens(data, tokenStats);
                } catch (e) {
                  // Ignore non-JSON lines
                }
              }
            }
          }
          res.end();
          logInfo('Stream forwarded successfully');

          if (tokenStats.inputTokens > 0 || tokenStats.outputTokens > 0) {
            const { recordRequest } = await import('./utils/request-stats.js');
            recordRequest({
              inputTokens: tokenStats.inputTokens,
              outputTokens: tokenStats.outputTokens,
              thinkingTokens: tokenStats.thinkingTokens,
              cacheCreationTokens: tokenStats.cacheCreationTokens,
              cacheReadTokens: tokenStats.cacheReadTokens,
              model: modelId,
              success: true
            });
            logDebug(`Streaming response token statistics (/v1/responses): input=${tokenStats.inputTokens}, output=${tokenStats.outputTokens}, thinking=${tokenStats.thinkingTokens}, cache_creation=${tokenStats.cacheCreationTokens}, cache_read=${tokenStats.cacheReadTokens}`);
          }
        } catch (streamError) {
          logError('Stream error', streamError);
          res.end();
        }
      } else {
        const data = await response.json();
        recordTokenUsage(data, 'openai', currentKeyId);
        logResponse(200, null, data);
        res.json(data);
      }

      break;
    }

  } catch (error) {
    if (error instanceof FetchRetryError) {
      logError('Upstream retry exhausted in /v1/responses', error);
      if (!res.headersSent) {
        res.status(504).json({
          error: 'Upstream service retries exhausted',
          message: `Request failed: ${error.message}`,
          attempts: error.attempts
        });
      } else {
        res.end();
      }
      return;
    }

    logError('Error in /v1/responses', error);
    // BaSui: Check whether the response has started to prevent errors from sending it twice
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: `Server processing error: ${error.message}`
      });
    } else {
      // Streaming response has started; end the connection
      res.end();
    }
  }
}

// Forward Anthropic requests directly (without format conversion)
async function handleDirectMessages(req, res) {
  logInfo('POST /v1/messages');
  
  try {
    const anthropicRequest = req.body;
    const modelId = anthropicRequest.model;

    if (!modelId) {
      return res.status(400).json({ error: 'Missing required parameter: model' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model not found: ${modelId}` });
    }

    if (model.type !== 'anthropic') {
      return res.status(400).json({ 
        error: 'Invalid endpoint type',
        message: `/v1/messages endpoint supports only anthropic endpoints; model ${modelId} has type ${model.type}`
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `Endpoint type not found: ${model.type}` });
    }

    logInfo(`Direct forwarding to ${model.type} endpoint: ${endpoint.base_url}`);

    const clientHeaders = req.headers;
    const isStreamingRequest = anthropicRequest.stream === true;

    const systemPrompt = getSystemPrompt();
    const modifiedRequest = { ...anthropicRequest };
    if (systemPrompt) {
      if (modifiedRequest.system && Array.isArray(modifiedRequest.system)) {
        modifiedRequest.system = [
          { type: 'text', text: systemPrompt },
          ...modifiedRequest.system
        ];
      } else {
        modifiedRequest.system = [
          { type: 'text', text: systemPrompt }
        ];
      }
    }

    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') {
      // 自动挡保持原样
    } else if (reasoningLevel && ['low', 'medium', 'high'].includes(reasoningLevel)) {
      const budgetTokens = {
        low: 4096,
        medium: 12288,
        high: 24576
      };
      modifiedRequest.thinking = {
        type: 'enabled',
        budget_tokens: budgetTokens[reasoningLevel]
      };
    } else {
      delete modifiedRequest.thinking;
    }

    const activeKeys = keyPoolManager.getActiveKeyCount() || 1;
    const maxRetries = Math.min(activeKeys, 5);
    let retryCount = 0;
    let lastError = null;

    while (retryCount < maxRetries) {
      const keyResult = await getApiKey(req, res);
      if (!keyResult) {
        if (retryCount === 0) {
          return;
        }
        retryCount++;
        logWarn(`获取密钥失败，正在重试 ${retryCount}/${maxRetries}...`);
        continue;
      }

      const { authHeader, currentKeyId } = keyResult;
      const headers = getAnthropicHeaders(authHeader, clientHeaders, isStreamingRequest, modelId);

      logRequest('POST', endpoint.base_url, headers, modifiedRequest);

      const response = await fetchWithPool(endpoint.base_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(modifiedRequest),
        maxRetries: 1
      });

      logInfo(`Response status: ${response.status}`);

      if (response.status === 402) {
        const errorText = await response.text();
        if (currentKeyId) {
          keyPoolManager.disableKey(currentKeyId, '402: 密钥余额不足');
        }
        logError(`密钥 ${currentKeyId || 'unknown'} 因402错误被禁用，准备重试...`);
        lastError = { status: 402, message: '密钥余额不足', details: errorText };
        retryCount++;

        if (retryCount < maxRetries) {
          logInfo(`正在切换到下一个密钥... (重试 ${retryCount}/${maxRetries})`);
          continue;
        }

        return res.status(402).json({
          error: '余额不足',
          message: '所有可用密钥余额都已耗尽',
          attempts: retryCount
        });
      }

      if (response.status === 403) {
        const errorText = await response.text();
        await handle403Error({
          res, currentKeyId, errorText, req, modelId,
          originalRequest: anthropicRequest,
          transformedRequest: modifiedRequest
        });
        return;
      }

      if (!response.ok) {
        const errorText = await response.text();
        logError(`Endpoint error: ${response.status}`, new Error(errorText));
        lastError = {
          status: response.status,
          message: `API返回错误 ${response.status}`,
          details: errorText
        };

        if (currentKeyId && response.status >= 500) {
          keyPoolManager.incrementErrorCount(currentKeyId);
        }

        retryCount++;
        if (retryCount < maxRetries) {
          logInfo(`正在切换到下一个密钥... (重试 ${retryCount}/${maxRetries})`);
          continue;
        }

        return res.status(response.status).json({
          error: `上游服务错误`,
          message: `请求在尝试 ${retryCount} 个密钥后失败`,
          lastError,
          attempts: retryCount
        });
      }

      if (isStreamingRequest) {
        setStreamingHeaders(res);

        try {
          const tokenStats = createTokenStats();
          let buffer = '';

          for await (const chunk of response.body) {
            res.write(chunk);

            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data:')) {
                try {
                  const data = JSON.parse(line.slice(5).trim());
                  extractAnthropicTokens(data, tokenStats);
                } catch (e) {
                  // 忽略非JSON行
                }
              }
            }
          }
          res.end();
          logInfo('Stream forwarded successfully');

          if (tokenStats.inputTokens > 0 || tokenStats.outputTokens > 0) {
            const { recordRequest } = await import('./utils/request-stats.js');
            recordRequest({
              inputTokens: tokenStats.inputTokens,
              outputTokens: tokenStats.outputTokens,
              thinkingTokens: tokenStats.thinkingTokens,
              cacheCreationTokens: tokenStats.cacheCreationTokens,
              cacheReadTokens: tokenStats.cacheReadTokens,
              model: modelId,
              success: true
            });
            logDebug(`流式响应Token统计(/v1/messages): input=${tokenStats.inputTokens}, output=${tokenStats.outputTokens}, thinking=${tokenStats.thinkingTokens}, cache_creation=${tokenStats.cacheCreationTokens}, cache_read=${tokenStats.cacheReadTokens}`);
          }
        } catch (streamError) {
          logError('Stream error', streamError);
          res.end();
        }
      } else {
        const data = await response.json();
        recordTokenUsage(data, 'anthropic', currentKeyId);
        logResponse(200, null, data);
        res.json(data);
      }

      break;
    }

  } catch (error) {
    if (error instanceof FetchRetryError) {
      logError('Upstream retry exhausted in /v1/messages', error);
      if (!res.headersSent) {
        res.status(504).json({
          error: 'Upstream service retries exhausted',
          message: `Request failed: ${error.message}`,
          attempts: error.attempts
        });
      } else {
        res.end();
      }
      return;
    }

    logError('Error in /v1/messages', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: `Server processing error: ${error.message}`
      });
    } else {
      res.end();
    }
  }
}

// BaSui: Handle Anthropic token count requests (count tokens without invoking the model)
async function handleCountTokens(req, res) {
  logInfo('POST /v1/messages/count_tokens');

  try {
    const anthropicRequest = req.body;
    const modelId = anthropicRequest.model;

    if (!modelId) {
      return res.status(400).json({ error: 'Missing required parameter: model' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model not found: ${modelId}` });
    }

    // Allow only anthropic endpoint types
    if (model.type !== 'anthropic') {
      return res.status(400).json({
        error: 'Invalid endpoint type',
        message: `/v1/messages/count_tokens endpoint supports only anthropic endpoints; model ${modelId} has type ${model.type}`
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `Endpoint type not found: ${model.type}` });
    }

    logInfo(`Counting tokens for ${model.type} endpoint: ${endpoint.base_url}/count_tokens`);

    // 🔧 优化：使用公共函数获取API密钥
    const keyResult = await getApiKey(req, res);
    if (!keyResult) return;
    const { authHeader, currentKeyId } = keyResult;

    const clientHeaders = req.headers;

    // 获取 headers（count_tokens不需要stream参数）
    const headers = getAnthropicHeaders(authHeader, clientHeaders, false, modelId);

    logRequest('POST', `${endpoint.base_url}/count_tokens`, headers, anthropicRequest);

    // BaSui：调用Anthropic的count_tokens端点
    const response = await fetchWithPool(`${endpoint.base_url}/count_tokens`, {
      method: 'POST',
      headers,
      body: JSON.stringify(anthropicRequest),
      maxRetries: 1
    });

    logInfo(`Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      logError(`Endpoint error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({
        error: `Endpoint returned ${response.status}`,
        details: errorText
      });
    }

    // 返回token计数结果
    const data = await response.json();
    logResponse(200, null, data);
    res.json(data);

  } catch (error) {
    if (error instanceof FetchRetryError) {
      logError('Upstream retry exhausted in /v1/messages/count_tokens', error);
      res.status(504).json({
        error: 'Upstream service retries exhausted',
        message: `Request failed: ${error.message}`,
        attempts: error.attempts
      });
      return;
    }

    logError('Error in /v1/messages/count_tokens', error);
    res.status(500).json({
      error: 'Internal server error',
      message: `Server processing error: ${error.message}`
    });
  }
}

// Register routes
router.post('/v1/chat/completions', handleChatCompletions);
router.post('/v1/responses', handleDirectResponses);
router.post('/v1/messages', handleDirectMessages);
router.post('/v1/messages/count_tokens', handleCountTokens);  // BaSui: Add the token counting endpoint

export default router;
