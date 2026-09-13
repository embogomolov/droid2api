import { logDebug, logInfo } from '../logger.js';
import { getSystemPrompt, getModelReasoning } from '../config.js';
import { getBaseHeaders, applyStainlessDefaults } from './headers-common.js';
import keywordFilter from '../utils/keyword-filter.js';

function adaptLegacyIdentity(instructions) {
  const prompt = getSystemPrompt();
  const legacyIdentity = 'You are Codex, a coding agent based on GPT-5.';
  // Factory rejects this stock legacy introduction even after the Droid prefix.
  // Adapt only the leading system identity; preserve all remaining text verbatim.
  if (prompt.startsWith('You are Droid, an AI software engineering agent built by Factory.') &&
      typeof instructions === 'string' && instructions.startsWith(legacyIdentity)) {
    instructions = instructions.slice(legacyIdentity.length);
    logInfo('Factory system adaptation applied: legacy_codex_identity');
  }
  return instructions;
}

export function prepareOpenAIInstructions(instructions = '') {
  return getSystemPrompt() + (adaptLegacyIdentity(instructions) || '');
}

export function prepareOpenAIInput(input) {
  if (!Array.isArray(input)) return input;
  // Codex can serialize its base instructions as the leading developer message
  // after tool declarations instead of using the Responses instructions field.
  const index = input.findIndex(item => item.type !== 'additional_tools');
  const message = input[index];
  if (!message || !['developer', 'system'].includes(message.role) ||
      (message.type && message.type !== 'message')) return input;
  let content = message.content;
  if (typeof content === 'string') content = adaptLegacyIdentity(content);
  else if (Array.isArray(content) && content[0]?.type === 'input_text') {
    const text = adaptLegacyIdentity(content[0].text);
    if (text !== content[0].text) content = [{ ...content[0], text }, ...content.slice(1)];
  }
  if (content === message.content) return input;
  return input.map((item, i) => i === index ? { ...message, content } : item);
}

export function transformToOpenAI(openaiRequest) {
  logDebug('Transforming OpenAI request to target OpenAI format');
  
  // Apply keyword filtering
  const filteredRequest = keywordFilter.filterRequest(openaiRequest);

  // BaSui: Upstream does not allow temperature and top_p together; prefer temperature
  if (filteredRequest.temperature !== undefined && filteredRequest.top_p !== undefined) {
    logDebug('BaSui: Both temperature and top_p were provided; dropping top_p to satisfy upstream requirements');
    delete filteredRequest.top_p;
  }
  
  const targetRequest = {
    model: filteredRequest.model,
    input: [],
    store: false
  };

  // Only add stream parameter if explicitly provided by client
  if (filteredRequest.stream !== undefined) {
    targetRequest.stream = filteredRequest.stream;
  }

  // Transform max_tokens to max_output_tokens
  if (filteredRequest.max_tokens) {
    targetRequest.max_output_tokens = filteredRequest.max_tokens;
  } else if (filteredRequest.max_completion_tokens) {
    targetRequest.max_output_tokens = filteredRequest.max_completion_tokens;
  }

  // Transform messages to input
  if (filteredRequest.messages && Array.isArray(filteredRequest.messages)) {
    for (const msg of filteredRequest.messages) {
      const inputMsg = {
        role: msg.role,
        content: []
      };

      // Determine content type based on role
      // user role uses 'input_text', assistant role uses 'output_text'
      const textType = msg.role === 'assistant' ? 'output_text' : 'input_text';
      const imageType = msg.role === 'assistant' ? 'output_image' : 'input_image';

      if (typeof msg.content === 'string') {
        inputMsg.content.push({
          type: textType,
          text: msg.content
        });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            inputMsg.content.push({
              type: textType,
              text: part.text
            });
          } else if (part.type === 'image_url') {
            inputMsg.content.push({
              type: imageType,
              image_url: part.image_url
            });
          } else {
            // Pass through other types as-is
            inputMsg.content.push(part);
          }
        }
      }

      targetRequest.input.push(inputMsg);
    }
  }

  // Transform tools if present
  if (filteredRequest.tools && Array.isArray(filteredRequest.tools)) {
    targetRequest.tools = filteredRequest.tools.map(tool => ({
      ...tool,
      strict: false
    }));
  }

  // Extract system message as instructions and prepend system prompt
  const systemPrompt = getSystemPrompt();
  const systemMessage = filteredRequest.messages?.find(m => m.role === 'system');
  
  if (systemMessage) {
    let userInstructions = '';
    if (typeof systemMessage.content === 'string') {
      userInstructions = systemMessage.content;
    } else if (Array.isArray(systemMessage.content)) {
      userInstructions = systemMessage.content
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n');
    }
    targetRequest.instructions = prepareOpenAIInstructions(userInstructions);
    targetRequest.input = targetRequest.input.filter(m => m.role !== 'system');
  } else if (systemPrompt) {
    // If no user-provided system message, just add the system prompt
    targetRequest.instructions = systemPrompt;
  }

  // Handle reasoning field based on model configuration
  const reasoningLevel = getModelReasoning(filteredRequest.model);
  if (reasoningLevel === 'auto') {
    // Auto mode: preserve original request's reasoning field exactly as-is
    if (filteredRequest.reasoning !== undefined) {
      targetRequest.reasoning = filteredRequest.reasoning;
    }
    // If original request has no reasoning field, don't add one
  } else if (reasoningLevel && ['low', 'medium', 'high'].includes(reasoningLevel)) {
    // Specific level: override with model configuration
    targetRequest.reasoning = {
      effort: reasoningLevel,
      summary: 'auto'
    };
  } else {
    // Off or invalid: explicitly remove reasoning field
    // This ensures any reasoning field from the original request is deleted
    delete targetRequest.reasoning;
  }

  // Pass through other parameters
  if (filteredRequest.temperature !== undefined) {
    targetRequest.temperature = filteredRequest.temperature;
  }
  if (filteredRequest.top_p !== undefined) {
    targetRequest.top_p = filteredRequest.top_p;
  }
  if (filteredRequest.presence_penalty !== undefined) {
    targetRequest.presence_penalty = filteredRequest.presence_penalty;
  }
  if (filteredRequest.frequency_penalty !== undefined) {
    targetRequest.frequency_penalty = filteredRequest.frequency_penalty;
  }
  if (filteredRequest.parallel_tool_calls !== undefined) {
    targetRequest.parallel_tool_calls = filteredRequest.parallel_tool_calls;
  }

  targetRequest.input = prepareOpenAIInput(targetRequest.input);
  logDebug('Transformed target OpenAI request', targetRequest);
  return targetRequest;
}

export function getOpenAIHeaders(authHeader, clientHeaders = {}) {
  // Use the shared function to generate base headers
  const headers = {
    ...getBaseHeaders(authHeader, clientHeaders),
    'x-api-provider': 'openai',
    // Static managed-OpenAI platform header from installed Droid's br$.
    'OpenAI-Platform': 'org-bHuLtG1fGmYk5YaOihAAXFBw',
    'x-provider-routing-source': 'registry_default'
  };

  // Apply default Stainless SDK headers
  applyStainlessDefaults(headers, clientHeaders);

  return headers;
}
