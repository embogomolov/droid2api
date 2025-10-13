import express from 'express';
import fetch from 'node-fetch';
import { getConfig, getModelById, getEndpointByType, getSystemPrompt, getModelReasoning } from './config.js';
import { logInfo, logDebug, logError, logRequest, logResponse } from './logger.js';
import { transformToAnthropic, getAnthropicHeaders } from './transformers/request-anthropic.js';
import { transformToOpenAI, getOpenAIHeaders } from './transformers/request-openai.js';
import { transformToCommon, getCommonHeaders } from './transformers/request-common.js';
import { AnthropicResponseTransformer } from './transformers/response-anthropic.js';
import { OpenAIResponseTransformer } from './transformers/response-openai.js';
import { getApiKey } from './auth.js';
import keyPoolManager from './auth.js';
import fetchWithPool from './utils/http-client.js';
import {
  getNextKeyFromPool,
  handle402Error,
  handleUpstreamError,
  handleStreamResponse,
  handleNonStreamResponse,
  recordTokenUsage
} from './utils/route-helpers.js';
import {
  createTokenStats,
  extractAnthropicTokens,
  extractOpenAITokens,
  extractCommonTokens
} from './utils/token-extractor.js';
import { log403Error } from './utils/error-403-logger.js';
const router = express.Router();



/**
 * BaSui：将 Anthropic Messages API 响应转换为 OpenAI Chat Completions 格式
 * 用于非流式响应
 */
function convertAnthropicToChatCompletion(anthropicResp) {
  if (!anthropicResp || typeof anthropicResp !== 'object') {
    throw new Error('Invalid Anthropic response object');
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
  if (toolCalls.length > 0) {
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
  const content = textBlocks.map(c => c.text).join('');

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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 标准 OpenAI 聊天补全处理函数（带格式转换）
async function handleChatCompletions(req, res) {
  logInfo('POST /v1/chat/completions');
  
  try {
    const openaiRequest = req.body;
    const modelId = openaiRequest.model;

    if (!modelId) {
      return res.status(400).json({ error: 'model is required' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model ${modelId} not found` });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `Endpoint type ${model.type} not found` });
    }

    logInfo(`Routing to ${model.type} endpoint: ${endpoint.base_url}`);

    // Get API key from pool (轮询获取)
    let authHeader;
    let currentKeyId;
    try {
      const keyResult = await keyPoolManager.getNextKey();
      authHeader = `Bearer ${keyResult.key}`;
      currentKeyId = keyResult.keyId;
    } catch (error) {
      logError('Failed to get API key from pool', error);
      return res.status(500).json({
        error: '密钥池错误',
        message: error.message
      });
    }

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
      return res.status(500).json({ error: `Unknown model type: ${model.type}` });
    }

    logRequest('POST', endpoint.base_url, headers, transformedRequest);

    // BaSui：🚀 使用 HTTP 连接池（复用 TCP 连接，减少握手开销）
    const response = await fetchWithPool(endpoint.base_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(transformedRequest)
    });

    logInfo(`Response status: ${response.status}`);

    // 处理402错误 - 永久封禁密钥
    if (response.status === 402) {
      keyPoolManager.banKey(currentKeyId, 'Payment Required - No Credits');
      const errorText = await response.text();
      logError(`Key banned due to 402 error: ${currentKeyId}`, new Error(errorText));
      return res.status(402).json({
        error: 'Payment Required',
        message: 'Key has been banned due to insufficient credits',
        details: errorText
      });
    }

    // BaSui：处理403错误 - 记录详细日志，包含系统提示词和用户提示词
    if (response.status === 403) {
      const errorText = await response.text();
      logError(`403 Forbidden error with key: ${currentKeyId}`, new Error(errorText));
      
      // 记录详细的 403 错误日志
      log403Error({
        requestId: `req-${Date.now()}`,
        keyId: currentKeyId,
        originalRequest: openaiRequest,
        transformedRequest: transformedRequest,
        headers: headers,
        endpoint: endpoint.base_url,
        errorDetails: errorText
      });

      return res.status(403).json({
        error: 'Forbidden',
        message: 'Access denied by upstream API',
        details: errorText
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      logError(`Endpoint error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({
        error: `Endpoint returned ${response.status}`,
        details: errorText
      });
    }

    const isStreaming = transformedRequest.stream === true;

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

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
          // BaSui: 同时解析原始流和转换后的流
          const rawChunks = [];
          for await (const chunk of response.body) {
            rawChunks.push(chunk);
          }

          // BaSui: 先从原始流中提取Token统计
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
                    // 使用新的 Token 提取工具函数（自动处理所有 Token 类型）
                    extractAnthropicTokens(data, tokenStats);
                  } else {
                    // 使用新的 Token 提取工具函数（OpenAI 格式）
                    extractOpenAITokens(data, tokenStats);
                  }
                } catch (e) {
                  // 忽略非JSON行
                }
              }
            }
          }

          // BaSui: 然后转换并转发
          const rawStream = (async function* () {
            for (const chunk of rawChunks) {
              yield chunk;
            }
          })();

          for await (const chunk of transformer.transformStream(rawStream)) {
            res.write(chunk);
          }
          res.end();
          logInfo('Stream completed');
        } catch (streamError) {
          logError('Stream error', streamError);
          res.end();
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
      const data = await response.json();

      // 记录Token使用量
      recordTokenUsage(data, model.type, currentKeyId);

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

  } catch (error) {
    logError('Error in /v1/chat/completions', error);
    // BaSui：检查响应是否已经开始发送，避免重复发送导致崩溃
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: error.message
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
      return res.status(400).json({ error: 'model is required' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model ${modelId} not found` });
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
      return res.status(500).json({ error: `Endpoint type ${model.type} not found` });
    }

    logInfo(`Direct forwarding to ${model.type} endpoint: ${endpoint.base_url}`);

    // Get API key from pool (轮询获取)
    let authHeader;
    let currentKeyId;
    try {
      const keyResult = await keyPoolManager.getNextKey();
      authHeader = `Bearer ${keyResult.key}`;
      currentKeyId = keyResult.keyId;
    } catch (error) {
      logError('Failed to get API key from pool', error);
      return res.status(500).json({
        error: '密钥池错误',
        message: error.message
      });
    }

    const clientHeaders = req.headers;

    // 获取 headers
    const headers = getOpenAIHeaders(authHeader, clientHeaders);

    // 注入系统提示到 instructions 字段
    const systemPrompt = getSystemPrompt();
    const modifiedRequest = { ...openaiRequest };
    if (systemPrompt) {
      // 如果已有 instructions，则在前面添加系统提示
      if (modifiedRequest.instructions) {
        modifiedRequest.instructions = systemPrompt + modifiedRequest.instructions;
      } else {
        // 否则直接设置系统提示
        modifiedRequest.instructions = systemPrompt;
      }
    }

    // 处理reasoning字段
    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') {
      // Auto模式：保持原始请求的reasoning字段不变
      // 如果原始请求有reasoning字段就保留，没有就不添加
    } else if (reasoningLevel && ['low', 'medium', 'high'].includes(reasoningLevel)) {
      modifiedRequest.reasoning = {
        effort: reasoningLevel,
        summary: 'auto'
      };
    } else {
      // 如果配置是off或无效，移除reasoning字段
      delete modifiedRequest.reasoning;
    }

    logRequest('POST', endpoint.base_url, headers, modifiedRequest);

    // BaSui：🚀 使用 HTTP 连接池转发修改后的请求
    const response = await fetchWithPool(endpoint.base_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(modifiedRequest)
    });

    logInfo(`Response status: ${response.status}`);

    // 处理402错误 - 永久封禁密钥
    if (response.status === 402) {
      keyPoolManager.banKey(currentKeyId, 'Payment Required - No Credits');
      const errorText = await response.text();
      logError(`Key banned due to 402 error: ${currentKeyId}`, new Error(errorText));
      return res.status(402).json({
        error: 'Payment Required',
        message: 'Key has been banned due to insufficient credits',
        details: errorText
      });
    }

    // BaSui：处理403错误 - 记录详细日志，包含系统提示词和用户提示词
    if (response.status === 403) {
      const errorText = await response.text();
      logError(`403 Forbidden error with key: ${currentKeyId}`, new Error(errorText));
      
      // 记录详细的 403 错误日志
      log403Error({
        requestId: `req-${Date.now()}`,
        keyId: currentKeyId,
        originalRequest: openaiRequest,
        transformedRequest: modifiedRequest,
        headers: headers,
        endpoint: endpoint.base_url,
        errorDetails: errorText
      });

      return res.status(403).json({
        error: 'Forbidden',
        message: 'Access denied by upstream API',
        details: errorText
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      logError(`Endpoint error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({
        error: `Endpoint returned ${response.status}`,
        details: errorText
      });
    }

    const isStreaming = openaiRequest.stream === true;

    if (isStreaming) {
      // 直接转发流式响应，不做任何转换
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        // BaSui: 收集流式响应中的Token统计（完整版）
        const tokenStats = createTokenStats();
        let buffer = '';

        // 直接将原始响应流转发给客户端
        for await (const chunk of response.body) {
          res.write(chunk);

          // BaSui: 解析SSE流，提取Token使用量（OpenAI格式）
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // 保留最后不完整的行

          for (const line of lines) {
            if (line.startsWith('data:')) {
              try {
                const dataStr = line.slice(5).trim();
                if (dataStr === '[DONE]') continue;

                const data = JSON.parse(dataStr);
                // 使用新的 Token 提取工具函数（OpenAI 格式）
                extractOpenAITokens(data, tokenStats);
              } catch (e) {
                // 忽略非JSON行
              }
            }
          }
        }
        res.end();
        logInfo('Stream forwarded successfully');

        // BaSui: 记录Token使用量统计（包含完整的 Token 类型）
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
      // 直接转发非流式响应，不做任何转换
      const data = await response.json();

      // 记录Token使用量
      recordTokenUsage(data, 'openai', currentKeyId);

      logResponse(200, null, data);
      res.json(data);
    }

  } catch (error) {
    logError('Error in /v1/responses', error);
    // BaSui：检查响应是否已经开始发送，避免重复发送导致崩溃
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: error.message
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
      return res.status(400).json({ error: 'model is required' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model ${modelId} not found` });
    }

    // 只允许 anthropic 类型端点
    if (model.type !== 'anthropic') {
      return res.status(400).json({ 
        error: 'Invalid endpoint type',
        message: `/v1/messages 接口只支持 anthropic 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `Endpoint type ${model.type} not found` });
    }

    logInfo(`Direct forwarding to ${model.type} endpoint: ${endpoint.base_url}`);

    // Get API key from pool (轮询获取)
    let authHeader;
    let currentKeyId;
    try {
      const keyResult = await keyPoolManager.getNextKey();
      authHeader = `Bearer ${keyResult.key}`;
      currentKeyId = keyResult.keyId;
    } catch (error) {
      logError('Failed to get API key from pool', error);
      return res.status(500).json({
        error: '密钥池错误',
        message: error.message
      });
    }

    const clientHeaders = req.headers;

    // 获取 headers
    const isStreaming = anthropicRequest.stream === true;
    const headers = getAnthropicHeaders(authHeader, clientHeaders, isStreaming, modelId);

    // 注入系统提示到 system 字段
    const systemPrompt = getSystemPrompt();
    const modifiedRequest = { ...anthropicRequest };
    if (systemPrompt) {
      if (modifiedRequest.system && Array.isArray(modifiedRequest.system)) {
        // 如果已有 system 数组，则在最前面插入系统提示
        modifiedRequest.system = [
          { type: 'text', text: systemPrompt },
          ...modifiedRequest.system
        ];
      } else {
        // 否则创建新的 system 数组
        modifiedRequest.system = [
          { type: 'text', text: systemPrompt }
        ];
      }
    }

    // 处理thinking字段
    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') {
      // Auto模式：保持原始请求的thinking字段不变
      // 如果原始请求有thinking字段就保留，没有就不添加
    } else if (reasoningLevel && ['low', 'medium', 'high'].includes(reasoningLevel)) {
      const budgetTokens = {
        'low': 4096,
        'medium': 12288,
        'high': 24576
      };
      
      modifiedRequest.thinking = {
        type: 'enabled',
        budget_tokens: budgetTokens[reasoningLevel]
      };
    } else {
      // 如果配置是off或无效，移除thinking字段
      delete modifiedRequest.thinking;
    }

    logRequest('POST', endpoint.base_url, headers, modifiedRequest);

    // BaSui：🚀 使用 HTTP 连接池转发修改后的请求
    const response = await fetchWithPool(endpoint.base_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(modifiedRequest)
    });

    logInfo(`Response status: ${response.status}`);

    // 处理402错误 - 永久封禁密钥
    if (response.status === 402) {
      keyPoolManager.banKey(currentKeyId, 'Payment Required - No Credits');
      const errorText = await response.text();
      logError(`Key banned due to 402 error: ${currentKeyId}`, new Error(errorText));
      return res.status(402).json({
        error: 'Payment Required',
        message: 'Key has been banned due to insufficient credits',
        details: errorText
      });
    }

    // BaSui：处理403错误 - 记录详细日志，包含系统提示词和用户提示词
    if (response.status === 403) {
      const errorText = await response.text();
      logError(`403 Forbidden error with key: ${currentKeyId}`, new Error(errorText));
      
      // 记录详细的 403 错误日志
      log403Error({
        requestId: `req-${Date.now()}`,
        keyId: currentKeyId,
        originalRequest: anthropicRequest,
        transformedRequest: modifiedRequest,
        headers: headers,
        endpoint: endpoint.base_url,
        errorDetails: errorText
      });

      return res.status(403).json({
        error: 'Forbidden',
        message: 'Access denied by upstream API',
        details: errorText
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      logError(`Endpoint error: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({
        error: `Endpoint returned ${response.status}`,
        details: errorText
      });
    }

    if (isStreaming) {
      // 直接转发流式响应，不做任何转换
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        // BaSui: 收集流式响应中的Token统计（完整版 - 包含 thinking 和 cache tokens）
        const tokenStats = createTokenStats();
        let buffer = '';

        // 直接将原始响应流转发给客户端
        for await (const chunk of response.body) {
          res.write(chunk);

          // BaSui: 解析SSE流，提取Token使用量
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // 保留最后不完整的行

          for (const line of lines) {
            if (line.startsWith('data:')) {
              try {
                const data = JSON.parse(line.slice(5).trim());
                // 使用新的 Token 提取工具函数（自动处理所有 Token 类型）
                extractAnthropicTokens(data, tokenStats);
              } catch (e) {
                // 忽略非JSON行
              }
            }
          }
        }
        res.end();
        logInfo('Stream forwarded successfully');

        // BaSui: 记录Token使用量统计（包含完整的 Token 类型）
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
      // 直接转发非流式响应，不做任何转换
      const data = await response.json();

      // 记录Token使用量
      recordTokenUsage(data, 'anthropic', currentKeyId);

      logResponse(200, null, data);
      res.json(data);
    }

  } catch (error) {
    logError('Error in /v1/messages', error);
    // BaSui：检查响应是否已经开始发送，避免重复发送导致崩溃
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: error.message
      });
    } else {
      // 流式响应已开始，直接结束连接
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
      return res.status(400).json({ error: 'model is required' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `Model ${modelId} not found` });
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
      return res.status(500).json({ error: `Endpoint type ${model.type} not found` });
    }

    logInfo(`Counting tokens for ${model.type} endpoint: ${endpoint.base_url}/count_tokens`);

    // Get API key from pool (轮询获取)
    let authHeader;
    let currentKeyId;
    try {
      const keyResult = await keyPoolManager.getNextKey();
      authHeader = `Bearer ${keyResult.key}`;
      currentKeyId = keyResult.keyId;
    } catch (error) {
      logError('Failed to get API key from pool', error);
      return res.status(500).json({
        error: '密钥池错误',
        message: error.message
      });
    }

    const clientHeaders = req.headers;

    // 获取 headers（count_tokens不需要stream参数）
    const headers = getAnthropicHeaders(authHeader, clientHeaders, false, modelId);

    logRequest('POST', `${endpoint.base_url}/count_tokens`, headers, anthropicRequest);

    // BaSui：调用Anthropic的count_tokens端点
    const response = await fetchWithPool(`${endpoint.base_url}/count_tokens`, {
      method: 'POST',
      headers,
      body: JSON.stringify(anthropicRequest)
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
    logError('Error in /v1/messages/count_tokens', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}

// 注册路由
router.post('/v1/chat/completions', handleChatCompletions);
router.post('/v1/responses', handleDirectResponses);
router.post('/v1/messages', handleDirectMessages);
router.post('/v1/messages/count_tokens', handleCountTokens);  // BaSui: 新增token计数端点

export default router;
