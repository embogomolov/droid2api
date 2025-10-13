import { logDebug } from '../logger.js';
import { getSystemPrompt, getModelReasoning, getReasoningBudget } from '../config.js';
import { getBaseHeaders, applyStainlessDefaults } from './headers-common.js';
import keywordFilter from '../utils/keyword-filter.js';

export function transformToAnthropic(openaiRequest, targetModel = null) {
  logDebug('Transforming OpenAI request to Anthropic format');
  
  // 应用关键词过滤
  const filteredRequest = keywordFilter.filterRequest(openaiRequest);
  
  // BaSui：支持模型ID映射（如 gpt-5 → claude-sonnet-4）
  const modelId = targetModel || filteredRequest.model;
  
  const anthropicRequest = {
    model: modelId,
    messages: []
  };

  // Only add stream parameter if explicitly provided by client
  if (filteredRequest.stream !== undefined) {
    anthropicRequest.stream = filteredRequest.stream;
  }

  // Handle max_tokens
  if (filteredRequest.max_tokens) {
    anthropicRequest.max_tokens = filteredRequest.max_tokens;
  } else if (filteredRequest.max_completion_tokens) {
    anthropicRequest.max_tokens = filteredRequest.max_completion_tokens;
  } else {
    anthropicRequest.max_tokens = 4096;
  }

  // Extract system message(s) and transform other messages
  let systemContent = [];
  
  if (filteredRequest.messages && Array.isArray(filteredRequest.messages)) {
    for (const msg of filteredRequest.messages) {
      // Handle system messages separately
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') {
          systemContent.push({
            type: 'text',
            text: msg.content
          });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text') {
              systemContent.push({
                type: 'text',
                text: part.text
              });
            } else {
              systemContent.push(part);
            }
          }
        }
        continue; // Skip adding system messages to messages array
      }

      // BaSui：处理工具结果消息（OpenAI的tool role → Anthropic的tool_result content）
      if (msg.role === 'tool') {
        // OpenAI格式：{ role: "tool", content: "...", tool_call_id: "..." }
        // Anthropic格式：在assistant消息后添加user消息，包含tool_result内容块
        const toolResultMsg = {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id || `toolu_${Date.now()}`,
            content: msg.content || ''
          }]
        };
        anthropicRequest.messages.push(toolResultMsg);
        continue;
      }

      const anthropicMsg = {
        role: msg.role,
        content: []
      };

      if (typeof msg.content === 'string') {
        anthropicMsg.content.push({
          type: 'text',
          text: msg.content
        });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            anthropicMsg.content.push({
              type: 'text',
              text: part.text
            });
          } else if (part.type === 'image_url') {
            anthropicMsg.content.push({
              type: 'image',
              source: part.image_url
            });
          } else {
            anthropicMsg.content.push(part);
          }
        }
      }

      // BaSui：处理assistant消息中的tool_calls（转换为tool_use内容块）
      if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const toolCall of msg.tool_calls) {
          if (toolCall.type === 'function') {
            anthropicMsg.content.push({
              type: 'tool_use',
              id: toolCall.id || `toolu_${Date.now()}`,
              name: toolCall.function.name,
              input: typeof toolCall.function.arguments === 'string' 
                ? JSON.parse(toolCall.function.arguments) 
                : toolCall.function.arguments
            });
          }
        }
      }

      anthropicRequest.messages.push(anthropicMsg);
    }
  }

  // Add system parameter with system prompt prepended
  const systemPrompt = getSystemPrompt();
  if (systemPrompt || systemContent.length > 0) {
    anthropicRequest.system = [];
    // Prepend system prompt as first element if it exists
    if (systemPrompt) {
      anthropicRequest.system.push({
        type: 'text',
        text: systemPrompt
      });
    }
    // Add user-provided system content
    anthropicRequest.system.push(...systemContent);
  }

  // Transform tools if present
  if (filteredRequest.tools && Array.isArray(filteredRequest.tools)) {
    anthropicRequest.tools = filteredRequest.tools.map(tool => {
      if (tool.type === 'function') {
        return {
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters || {}
        };
      }
      return tool;
    });
  }

  // Handle thinking field based on model configuration
  const reasoningLevel = getModelReasoning(filteredRequest.model);
  if (reasoningLevel === 'auto') {
    // Auto mode: preserve original request's thinking field exactly as-is
    if (filteredRequest.thinking !== undefined) {
      anthropicRequest.thinking = filteredRequest.thinking;
    }
    // If original request has no thinking field, don't add one
  } else if (reasoningLevel && ['low', 'medium', 'high'].includes(reasoningLevel)) {
    // Specific level: override with model configuration
    const budgetTokens = getReasoningBudget(reasoningLevel);

    anthropicRequest.thinking = {
      type: 'enabled',
      budget_tokens: budgetTokens
    };
  } else {
    // Off or invalid: explicitly remove thinking field
    // This ensures any thinking field from the original request is deleted
    delete anthropicRequest.thinking;
  }

  // Pass through other compatible parameters
  if (filteredRequest.temperature !== undefined) {
    anthropicRequest.temperature = filteredRequest.temperature;
  }
  if (filteredRequest.top_p !== undefined) {
    anthropicRequest.top_p = filteredRequest.top_p;
  }
  if (filteredRequest.stop !== undefined) {
    anthropicRequest.stop_sequences = Array.isArray(filteredRequest.stop) 
      ? filteredRequest.stop 
      : [filteredRequest.stop];
  }

  logDebug('Transformed Anthropic request', anthropicRequest);
  return anthropicRequest;
}

export function getAnthropicHeaders(authHeader, clientHeaders = {}, isStreaming = true, modelId = null) {
  // 使用公共函数生成基础headers
  const headers = {
    'accept': 'application/json',
    ...getBaseHeaders(authHeader, clientHeaders),
    'anthropic-version': clientHeaders['anthropic-version'] || '2023-06-01',
    'x-api-provider': 'anthropic',
    'x-stainless-timeout': '600'
  };

  // Handle anthropic-beta header based on reasoning configuration
  const reasoningLevel = modelId ? getModelReasoning(modelId) : null;
  let betaValues = [];
  
  // Add existing beta values from client headers
  if (clientHeaders['anthropic-beta']) {
    const existingBeta = clientHeaders['anthropic-beta'];
    betaValues = existingBeta.split(',').map(v => v.trim());
  }
  
  // Handle thinking beta based on reasoning configuration
  const thinkingBeta = 'interleaved-thinking-2025-05-14';
  if (reasoningLevel === 'auto') {
    // Auto mode: don't modify anthropic-beta header, preserve original
    // betaValues remain unchanged from client headers
  } else if (reasoningLevel && ['low', 'medium', 'high'].includes(reasoningLevel)) {
    // Add thinking beta if not already present
    if (!betaValues.includes(thinkingBeta)) {
      betaValues.push(thinkingBeta);
    }
  } else {
    // Remove thinking beta if reasoning is off/invalid
    betaValues = betaValues.filter(v => v !== thinkingBeta);
  }
  
  // Set anthropic-beta header if there are any values
  if (betaValues.length > 0) {
    headers['anthropic-beta'] = betaValues.join(', ');
  }

  // 应用Stainless SDK默认headers
  applyStainlessDefaults(headers, clientHeaders);

  // Anthropic特有：覆盖package-version
  headers['x-stainless-package-version'] = clientHeaders['x-stainless-package-version'] || '0.57.0';

  // Set helper-method based on streaming
  if (isStreaming) {
    headers['x-stainless-helper-method'] = 'stream';
  }

  // Override timeout from defaults if client provided
  if (clientHeaders['x-stainless-timeout']) {
    headers['x-stainless-timeout'] = clientHeaders['x-stainless-timeout'];
  }

  return headers;
}
