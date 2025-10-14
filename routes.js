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
// 🔧 优化：导入公共函数，移除重复代码
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
 * BaSui：将 Anthropic Messages API 响应转换为 OpenAI Chat Completions 格式
 * 用于非流式响应
 */
function convertAnthropicToChatCompletion(anthropicResp) {
  if (!anthropicResp || typeof anthropicResp !== 'object') {
    throw new Error('无效的 Anthropic 响应对象');
  }

  // 提取文本内容和工具调用
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

  // 映射 stop_reason
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

  // 如果有工具调用，添加到message
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
    throw new Error('无效的响应对象');
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
    // 🔧 修复：添加headersSent检查
    if (!res.headersSent) {
      res.status(500).json({ error: '内部服务器错误' });
    }
  }
});

// 标准 OpenAI 聊天补全处理函数（带格式转换和自动重试）
async function handleChatCompletions(req, res) {
  logInfo('POST /v1/chat/completions');
  
  // 记录请求开始时间（用于延迟计算）
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
      return res.status(400).json({ error: '缺少必需参数：model' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `未找到模型：${modelId}` });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `未找到端点类型：${model.type}` });
    }

    logInfo(`Routing to ${model.type} endpoint: ${endpoint.base_url}`);

    // 🎯 Token预估：在请求前估算token使用量
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

    // BaSui：根据模型类型选择合适的转换器
    // 所有模型都使用统一的OpenAI输入格式，转换器自动适配到目标API
    if (model.type === 'anthropic') {
      // 如果配置了 backend_model，使用它作为实际调用的模型ID（用于模型别名）
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
      return res.status(500).json({ error: `未知的模型类型：${model.type}` });
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
      // 🔧 优化：使用公共函数设置流响应头
      setStreamingHeaders(res);

      // BaSui: 收集流式响应中的Token统计（完整版 - 包含 thinking 和 cache tokens）
      const tokenStats = createTokenStats();

      // common 类型直接转发，不使用 transformer
      if (model.type === 'common') {
        try {
          let buffer = '';
          for await (const chunk of response.body) {
            res.write(chunk);

            // BaSui: 解析SSE流，提取Token使用量
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data:')) {
                try {
                  const dataStr = line.slice(5).trim();
                  if (dataStr === '[DONE]') continue;
                  const data = JSON.parse(dataStr);
                  // 使用新的 Token 提取工具函数
                  extractCommonTokens(data, tokenStats);
                } catch (e) {
                  // 忽略非JSON行
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
        // anthropic 和 openai 类型使用 transformer
        let transformer;
        let buffer = '';

        if (model.type === 'anthropic') {
          transformer = new AnthropicResponseTransformer(modelId, `chatcmpl-${Date.now()}`);
        } else if (model.type === 'openai') {
          transformer = new OpenAIResponseTransformer(modelId, `chatcmpl-${Date.now()}`);
        }

        try {
          // BaSui: 🔧 修复内存泄漏 - 使用流式处理，设置最大缓冲区大小
          const MAX_BUFFER_SIZE = 50 * 1024 * 1024; // 50MB 最大缓冲
          let bufferSize = 0;
          const rawChunks = [];
          let isOversized = false;

          // 流式处理，边读边转换边发送
          for await (const chunk of response.body) {
            // 检查缓冲区大小
            bufferSize += chunk.length;
            if (bufferSize > MAX_BUFFER_SIZE) {
              logError(`Response too large: ${bufferSize} bytes (max: ${MAX_BUFFER_SIZE})`);
              isOversized = true;
              // 对于超大响应，直接流式转发，不再积累
              if (transformer) {
                const chunkStream = (async function* () { yield chunk; })();
                for await (const transformed of transformer.transformStream(chunkStream)) {
                  res.write(transformed);
                }
              } else {
                res.write(chunk);
              }
            } else {
              // 正常大小，积累用于Token统计
              rawChunks.push(chunk);
            }
          }

          if (!isOversized) {
            // 只对正常大小的响应进行Token统计
            let buffer = '';  // 🔧 修复：声明buffer变量
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
                    // 忽略非JSON行
                  }
                }
              }
            }

            // 转换并转发积累的chunks
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

      // BaSui: 记录Token使用量统计（包含完整的 Token 类型）
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
          logDebug(`流式响应Token统计(/v1/chat/completions): input=${tokenStats.inputTokens}, output=${tokenStats.outputTokens}, thinking=${tokenStats.thinkingTokens}, cache_creation=${tokenStats.cacheCreationTokens}, cache_read=${tokenStats.cacheReadTokens}`);
        }
      } catch (err) {
        logError('记录Token统计失败', err);
      }
    } else {
      // 🔧 修复：添加JSON解析错误处理
      let data;
      try {
        data = await response.json();
      } catch (jsonError) {
        logError('Failed to parse JSON response', jsonError);
        // 🔧 修复：response body已经被消费，不能再次读取
        return res.status(502).json({
          error: 'Invalid JSON response from upstream',
          details: jsonError.message
        });
      }

      // 记录Token使用量（包含预估值和延迟）
      const requestLatency = Date.now() - req.startTime; // 需要在请求开始时记录startTime
      recordTokenUsage(data, model.type, currentKeyId, openaiRequest, estimatedTokens, requestLatency);

      if (model.type === 'anthropic') {
        // BaSui：转换 Anthropic 响应为 OpenAI 格式
        try {
          const converted = convertAnthropicToChatCompletion(data);
          logResponse(200, null, converted);
          res.json(converted);
        } catch (e) {
          logError('Anthropic响应转换失败', e);
          // 如果转换失败，回退为原始数据
          logResponse(200, null, data);
          res.json(data);
        }
      } else if (model.type === 'openai') {
        try {
          const converted = convertResponseToChatCompletion(data);
          logResponse(200, null, converted);
          res.json(converted);
        } catch (e) {
          // 如果转换失败，回退为原始数据
          logResponse(200, null, data);
          res.json(data);
        }
      } else {
        // common: 直接转发
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
          error: '上游服务重试已耗尽',
          message: `请求失败：${error.message}`,
          attempts: error.attempts
        });
      } else {
        res.end();
      }
      return;
    }

    logError('Error in /v1/chat/completions', error);
    // BaSui：检查响应是否已经开始发送，避免重复发送导致崩溃
    if (!res.headersSent) {
      res.status(500).json({
        error: '内部服务器错误',
        message: `服务器处理异常：${error.message}`
      });
    } else {
      // 流式响应已开始，直接结束连接
      res.end();
    }
  }
}

// 直接转发 OpenAI 请求（不做格式转换）
async function handleDirectResponses(req, res) {
  logInfo('POST /v1/responses');
  
  try {
    const openaiRequest = req.body;
    const modelId = openaiRequest.model;

    if (!modelId) {
      return res.status(400).json({ error: '缺少必需参数：model' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `未找到模型：${modelId}` });
    }

    // 只允许 openai 类型端点
    if (model.type !== 'openai') {
      return res.status(400).json({
        error: 'Invalid endpoint type',
        message: `/v1/responses 接口只支持 openai 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `未找到端点类型：${model.type}` });
    }

    logInfo(`Direct forwarding to ${model.type} endpoint: ${endpoint.base_url}`);

    const clientHeaders = req.headers;

    // 注入系统提示到 instructions 字段
    const systemPrompt = getSystemPrompt();
    const modifiedRequest = { ...openaiRequest };
    if (systemPrompt) {
      if (modifiedRequest.instructions) {
        modifiedRequest.instructions = systemPrompt + modifiedRequest.instructions;
      } else {
        modifiedRequest.instructions = systemPrompt;
      }
    }

    // 处理reasoning字段
    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') {
      // Auto模式：保持原始请求的reasoning字段不变
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
            logDebug(`流式响应Token统计(/v1/responses): input=${tokenStats.inputTokens}, output=${tokenStats.outputTokens}, thinking=${tokenStats.thinkingTokens}, cache_creation=${tokenStats.cacheCreationTokens}, cache_read=${tokenStats.cacheReadTokens}`);
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
          error: '上游服务重试已耗尽',
          message: `请求失败：${error.message}`,
          attempts: error.attempts
        });
      } else {
        res.end();
      }
      return;
    }

    logError('Error in /v1/responses', error);
    // BaSui：检查响应是否已经开始发送，避免重复发送导致崩溃
    if (!res.headersSent) {
      res.status(500).json({
        error: '内部服务器错误',
        message: `服务器处理异常：${error.message}`
      });
    } else {
      // 流式响应已开始，直接结束连接
      res.end();
    }
  }
}

// 直接转发 Anthropic 请求（不做格式转换）
async function handleDirectMessages(req, res) {
  logInfo('POST /v1/messages');
  
  try {
    const anthropicRequest = req.body;
    const modelId = anthropicRequest.model;

    if (!modelId) {
      return res.status(400).json({ error: '缺少必需参数：model' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `未找到模型：${modelId}` });
    }

    if (model.type !== 'anthropic') {
      return res.status(400).json({ 
        error: 'Invalid endpoint type',
        message: `/v1/messages 接口只支持 anthropic 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `未找到端点类型：${model.type}` });
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
          error: '上游服务重试已耗尽',
          message: `请求失败：${error.message}`,
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
        error: '内部服务器错误',
        message: `服务器处理异常：${error.message}`
      });
    } else {
      res.end();
    }
  }
}

// BaSui: 处理Anthropic token计数请求（不调用模型，只计算token数）
async function handleCountTokens(req, res) {
  logInfo('POST /v1/messages/count_tokens');

  try {
    const anthropicRequest = req.body;
    const modelId = anthropicRequest.model;

    if (!modelId) {
      return res.status(400).json({ error: '缺少必需参数：model' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `未找到模型：${modelId}` });
    }

    // 只允许 anthropic 类型端点
    if (model.type !== 'anthropic') {
      return res.status(400).json({
        error: 'Invalid endpoint type',
        message: `/v1/messages/count_tokens 接口只支持 anthropic 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `未找到端点类型：${model.type}` });
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
        error: '上游服务重试已耗尽',
        message: `请求失败：${error.message}`,
        attempts: error.attempts
      });
      return;
    }

    logError('Error in /v1/messages/count_tokens', error);
    res.status(500).json({
      error: '内部服务器错误',
      message: `服务器处理异常：${error.message}`
    });
  }
}

// 注册路由
router.post('/v1/chat/completions', handleChatCompletions);
router.post('/v1/responses', handleDirectResponses);
router.post('/v1/messages', handleDirectMessages);
router.post('/v1/messages/count_tokens', handleCountTokens);  // BaSui: 新增token计数端点

export default router;
