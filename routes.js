import { requestWithFailover } from './utils/factory-upstream.js';
import express from 'express';
import fetch from 'node-fetch';
import { getConfig, getModelById, getEndpointByType, getModelReasoning } from './config.js';
import { logInfo, logDebug, logError, logWarn, logRequest, logResponse } from './logger.js';
import { transformToAnthropic, getAnthropicHeaders, prepareDirectAnthropic } from './transformers/request-anthropic.js';
import { transformToOpenAI, getOpenAIHeaders, prepareOpenAIInstructions, prepareOpenAIInput } from './transformers/request-openai.js';
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
  writeResponseChunk,
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
      display_name: model.name || model.id,
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
    logInfo(`Token estimate - model: ${modelId}, input: ${estimatedTokens.estimated_prompt_tokens}, estimated output: ${estimatedTokens.estimated_completion_tokens}, total: ${estimatedTokens.estimated_total_tokens}`);

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
      headers = getAnthropicHeaders('', clientHeaders, isStreaming, modelId);
      
      if (backendModel) {
        logInfo(`Model mapping: ${modelId} → ${backendModel}`);
      }
    } else if (model.type === 'openai') {
      transformedRequest = transformToOpenAI(openaiRequest);
      headers = getOpenAIHeaders('', clientHeaders);
    } else if (model.type === 'common') {
      transformedRequest = transformToCommon(openaiRequest);
      headers = getCommonHeaders('', clientHeaders, model.api_provider);
    } else {
      return res.status(500).json({ error: `Unknown model type: ${model.type}` });
    }

    const upstream = await requestWithFailover(req, res, authHeader => ({
      url: endpoint.base_url, headers: { ...headers, authorization: authHeader }, body: transformedRequest
    }));
    if (!upstream) return;
    const { response, currentKeyId } = upstream;

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
            await writeResponseChunk(res, chunk);

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
          res.destroy(streamError);
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
                  await writeResponseChunk(res, transformed);
                }
              } else {
                await writeResponseChunk(res, chunk);
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
              await writeResponseChunk(res, chunk);
            }
          }
          
          res.end();
          logInfo('Stream completed');
        } catch (streamError) {
          logError('Stream error', streamError);
          if (!res.headersSent) {
            res.status(502).json({ error: 'Stream processing error' });
          } else {
            res.destroy(streamError);
          }
        }
      }

      // BaSui: Record token usage statistics (all supported token types)
      try {
        if (!upstream.usageRecorded && (tokenStats.inputTokens > 0 || tokenStats.outputTokens > 0)) {
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
      if (!upstream.usageRecorded) recordTokenUsage(data, model.type, currentKeyId, openaiRequest, estimatedTokens, requestLatency);

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

    // Share system compatibility and prefixing with the Chat Completions adapter.
    const instructions = prepareOpenAIInstructions(openaiRequest.instructions);
    const modifiedRequest = { ...openaiRequest };
    if (instructions) modifiedRequest.instructions = instructions;
    if (modifiedRequest.input !== undefined) modifiedRequest.input = prepareOpenAIInput(modifiedRequest.input);

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

    const upstream = await requestWithFailover(req, res, authHeader => ({
      url: endpoint.base_url, headers: getOpenAIHeaders(authHeader, clientHeaders), body: modifiedRequest
    }));
    if (!upstream) return;
    const { response, currentKeyId } = upstream;

      const isStreaming = openaiRequest.stream === true;

      if (isStreaming) {
        setStreamingHeaders(res);

        try {
          const tokenStats = createTokenStats();
          let buffer = '';

          for await (const chunk of response.body) {
            await writeResponseChunk(res, chunk);

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
          if (upstream.outcome.failed) return;
          logInfo('Stream forwarded successfully');

          if (!upstream.usageRecorded && (tokenStats.inputTokens > 0 || tokenStats.outputTokens > 0)) {
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
          res.destroy(streamError);
        }
      } else {
        const data = await response.json();
        if (!upstream.usageRecorded) recordTokenUsage(data, 'openai', currentKeyId);
        logResponse(200, null, data);
        res.json(data);
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

    const modifiedRequest = prepareDirectAnthropic(anthropicRequest);

    const upstream = await requestWithFailover(req, res, authHeader => ({
      url: endpoint.base_url, headers: getAnthropicHeaders(authHeader, clientHeaders, isStreamingRequest, modelId), body: modifiedRequest
    }));
    if (!upstream) return;
    const { response, currentKeyId } = upstream;

      if (isStreamingRequest) {
        setStreamingHeaders(res);

        try {
          for await (const chunk of response.body) await writeResponseChunk(res, chunk);
          res.end();
          if (!upstream.outcome.failed) logInfo('Stream forwarded successfully');
        } catch (streamError) {
          logError('Stream error', streamError);
          res.destroy(streamError);
        }
      } else {
        const data = await response.json();
        if (!upstream.usageRecorded) recordTokenUsage(data, 'anthropic', currentKeyId);
        logResponse(200, null, data);
        res.json(data);
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

    const upstream = await requestWithFailover(req, res, authHeader => ({
      url: `${endpoint.base_url}/count_tokens`,
      headers: getAnthropicHeaders(authHeader, req.headers, false, modelId), body: prepareDirectAnthropic(anthropicRequest)
    }));
    if (!upstream) return;
    const { response } = upstream;

    // Return the token count result
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
