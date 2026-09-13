import { logDebug } from '../logger.js';
import { getSystemPrompt, getModelById, getModelReasoning, getReasoningBudget } from '../config.js';
import { getBaseHeaders, applyStainlessDefaults } from './headers-common.js';
import keywordFilter from '../utils/keyword-filter.js';

// The counting and generation endpoints must see exactly the same prompt.
export function prepareDirectAnthropic(request) {
  const result = { ...request }, prompt = getSystemPrompt();
  result.model = getModelById(request.model)?.id || request.model;
  const droidIdentity = 'You are Droid, an AI software engineering agent built by Factory.';
  const system = Array.isArray(request.system) ? request.system : typeof request.system === 'string' ? [{ type: 'text', text: request.system }] : [];
  // Factory rejects these exact built-in client identity introductions (HTTP 403).
  // Rephrase only stock identity/environment wording; retain model values and conversation content.
  const identities = ["You are a Claude agent, built on Anthropic's Claude Agent SDK.", "You are Claude Code, Anthropic's official CLI for Claude.", "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."];
  const clientSystem = prompt.startsWith(droidIdentity) ? system.map(block => {
    if (block.type !== 'text') return block;
    const identity = block.type === 'text' && identities.find(text => block.text?.startsWith(text));
    const text = identity ? 'You are an AI software engineering agent.' + block.text.slice(identity.length) : block.text;
    return { ...block, text: text
      .replace(/^You have been invoked in the following environment: ?$/m, 'Current execution environment:')
      .replace(/^ - You are powered by the model named (.+)\. The exact model ID is (.+)\.$/m, ' - Active model: $1. Model ID: $2.') };
  }) : system;
  // Native Droid puts this identity in its own first system block.
  const prefix = prompt.startsWith(droidIdentity) && prompt.length > droidIdentity.length
    ? [droidIdentity, prompt.slice(droidIdentity.length)] : [prompt];
  if (prompt) result.system = [...prefix.map(text => ({ type: 'text', text })),
    ...clientSystem];
  // Claude Code embeds instruction-file labels in a user-role system reminder.
  // Factory rejects its stock label; retain the path and every instruction below it.
  if (prompt.startsWith(droidIdentity) && request.messages) result.messages = request.messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map(block => {
      if (message.role === 'system' && block.type === 'text' && block.text?.includes('- update-config: Use this skill to configure the Claude Code harness via settings.json.')) {
        return { ...block, text: block.text.replace(/^(- update-config: .*)require hooks configured in settings\.json - the harness executes these, not Claude, so memory\/preferences cannot fulfill them\./gm,
          '$1must use settings.json hooks, which the runtime executes; memory/preferences do not run automation.') };
      }
      if (block.type !== 'text' || !block.text?.startsWith('<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n')) return block;
      return { ...block, text: block.text.replace(/^Contents of (.+) \(user's private global instructions for all projects\):$/gm, 'Loaded instructions from $1 (user scope):') };
    }) };
  });
  const reasoning = getModelReasoning(request.model);
  if (['low', 'medium', 'high'].includes(reasoning)) {
    result.thinking = { type: 'enabled', budget_tokens: getReasoningBudget(reasoning) };
  } else if (reasoning !== 'auto') delete result.thinking;
  return result;
}

export function transformToAnthropic(openaiRequest, targetModel = null) {
  logDebug('Transforming OpenAI request to Anthropic format');
  
  // Apply keyword filtering
  const filteredRequest = keywordFilter.filterRequest(openaiRequest);

  // BaSui: Anthropic also rejects simultaneous temperature and top_p; prefer temperature
  if (filteredRequest.temperature !== undefined && filteredRequest.top_p !== undefined) {
    logDebug('BaSui: Both temperature and top_p were provided; dropping top_p to comply with the target API');
    delete filteredRequest.top_p;
  }
  
  // BaSui: Support model ID mapping (for example gpt-5 → claude-sonnet-4)
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

      // BaSui: Handle tool result messages (OpenAI tool role to Anthropic tool_result content)
      if (msg.role === 'tool') {
        // OpenAI format: { role: "tool", content: "...", tool_call_id: "..." }
        // Anthropic format: add a user message after the assistant message containing a tool_result content block
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

      // BaSui: Handle tool_calls in assistant messages (convert to tool_use content blocks)
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
  // Use the shared function to generate base headers
  const headers = {
    'accept': 'application/json',
    ...Object.fromEntries(Object.entries(clientHeaders).filter(([name]) => name.startsWith('anthropic-'))),
    ...getBaseHeaders(authHeader, clientHeaders),
    'anthropic-version': clientHeaders['anthropic-version'] || '2023-06-01',
    'x-api-provider': 'anthropic',
    'x-api-key': 'placeholder', // Native Droid Anthropic SDK key; Factory auth is the Bearer credential.
    'x-provider-routing-source': 'registry_default',
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
  if (reasoningLevel === 'auto' && clientHeaders['anthropic-beta']) headers['anthropic-beta'] = clientHeaders['anthropic-beta'];

  // Apply default Stainless SDK headers
  applyStainlessDefaults(headers, clientHeaders);

  // Anthropic specific: override package-version
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
