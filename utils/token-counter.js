/**
 * Token counting helpers based on commonly used estimation methods
 * Improve token counting accuracy over the previous implementation.
 *
 * BaSui: Uses a more accurate counting approach based on the new-api project.
 * Intended to count tokens across text, image, audio, and other content types.
 */

import { logDebug, logInfo, logError } from '../logger.js';

// Define token estimation ratios and characteristics for each model.
// Based on the models configured in this project.
const MODEL_TOKEN_RATIOS = {
  // Claude models (Anthropic) used by this project
  'claude-sonnet-4-20250514': { charToTokenRatio: 0.35, type: 'anthropic' },
  'claude-sonnet-4-5-20250929': { charToTokenRatio: 0.35, type: 'anthropic' },
  
  // GPT-5 models (use the Anthropic token estimation settings here)
  'gpt-5-2025-08-07': { charToTokenRatio: 0.35, type: 'anthropic' },
  'gpt-5-codex': { charToTokenRatio: 0.35, type: 'anthropic' },
  
  // GLM models
  'glm-4.6': { charToTokenRatio: 0.38, type: 'common' },
  
  // Default configuration
  'anthropic': { charToTokenRatio: 0.35, type: 'anthropic' },
  'openai': { charToTokenRatio: 0.38, type: 'openai' },
  'common': { charToTokenRatio: 0.38, type: 'common' },
  'default': { charToTokenRatio: 0.38, type: 'common' }
};

/**
 * Estimate the text token count using the updated algorithm.
 * @param {string} text - Text to count
 * @param {string} model - Model name or type
 * @returns {number} Token count
 */
export function countTextTokens(text, model = 'default') {
  if (!text || typeof text !== 'string') {
    return 0;
  }

  // Get the model configuration.
  const modelConfig = MODEL_TOKEN_RATIOS[model] || MODEL_TOKEN_RATIOS['default'];
  const modelType = modelConfig.type;

  // Basic character and word counts
  const chineseCharCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWordCount = (text.match(/[a-zA-Z]+/g) || []).length;
  const numberCount = (text.match(/\d+/g) || []).length;
  const punctuationCount = (text.match(/[^\w\s\u4e00-\u9fa5]/g) || []).length;
  const spaceCount = (text.match(/\s/g) || []).length;
  
  let tokenCount = 0;
  
  // Use a counting method appropriate to the model type.
  if (modelType === 'anthropic') {
    // Anthropic (Claude) token estimation
    // Estimate Chinese text for Claude at approximately 1.2 tokens per character.
    tokenCount = 
      chineseCharCount * 1.2 +
      englishWordCount * 1.0 +
      numberCount * 0.8 +
      punctuationCount * 0.5 +
      spaceCount * 0.3;
  } else if (modelType === 'openai') {
    // OpenAI GPT token estimation
    tokenCount = 
      chineseCharCount * 1.0 +
      englishWordCount * 1.0 +
      numberCount * 0.7 +
      punctuationCount * 0.3 +
      spaceCount * 0.2;
  } else {
    // Generic estimation for GLM and other models
    tokenCount = 
      chineseCharCount * 1.0 +
      englishWordCount * 1.0 +
      numberCount * 0.8 +
      punctuationCount * 0.4 +
      spaceCount * 0.2;
  }

  // Round up.
  tokenCount = Math.ceil(tokenCount);

  logDebug(`Token estimate [${modelType}]: text length=${text.length}, Chinese characters=${chineseCharCount}, English words=${englishWordCount}, numbers=${numberCount}, estimated tokens=${tokenCount}`);

  return tokenCount;
}

/**
 * Estimate the token count for a list of messages.
 * @param {Array} messages - Message list
 * @param {string} model - Model name or type
 * @returns {number} Token count
 */
export function countMessagesTokens(messages, model = 'default') {
  if (!messages || !Array.isArray(messages)) {
    return 0;
  }

  // Get the model configuration.
  const modelConfig = MODEL_TOKEN_RATIOS[model] || MODEL_TOKEN_RATIOS['default'];
  const modelType = modelConfig.type;

  let totalTokens = 0;

  // Set per-message overhead according to the model type.
  const messageOverhead = modelType === 'anthropic' ? 4 : 3; // The Anthropic format has slightly higher overhead.

  messages.forEach(message => {
    // Add message formatting overhead.
    totalTokens += messageOverhead;

    // Count role tokens.
    if (message.role) {
      totalTokens += countTextTokens(message.role, model);
    }

    // Count content tokens.
    if (message.content) {
      if (typeof message.content === 'string') {
        totalTokens += countTextTokens(message.content, model);
      } else if (Array.isArray(message.content)) {
        // Handle multimodal content: text, images, tool use, and so on.
        message.content.forEach(item => {
          if (item.type === 'text' && item.text) {
            totalTokens += countTextTokens(item.text, model);
          } else if (item.type === 'image' || item.type === 'image_url') {
            // Image token estimation
            totalTokens += calculateImageTokens(item.image_url || item, modelType);
          } else if (item.type === 'tool_use') {
            // Anthropic tool use format
            totalTokens += messageOverhead;
            if (item.name) {
              totalTokens += countTextTokens(item.name, model);
            }
            if (item.input) {
              totalTokens += countTextTokens(JSON.stringify(item.input), model);
            }
          } else if (item.type === 'tool_result') {
            // Anthropic tool result format
            totalTokens += messageOverhead;
            if (item.content) {
              totalTokens += countTextTokens(item.content, model);
            }
          }
        });
      }
    }

    // Handle OpenAI-format tool calls.
    if (message.tool_calls) {
      message.tool_calls.forEach(toolCall => {
        totalTokens += messageOverhead;
        if (toolCall.function?.name) {
          totalTokens += countTextTokens(toolCall.function.name, model);
        }
        if (toolCall.function?.arguments) {
          totalTokens += countTextTokens(toolCall.function.arguments, model);
        }
      });
    }

    // Handle the name field.
    if (message.name) {
      totalTokens += countTextTokens(message.name, model);
    }
  });

  // Add conversation-level overhead.
  totalTokens += modelType === 'anthropic' ? 5 : 3;

  return totalTokens;
}

/**
 * Estimate the token count for an image.
 * @param {Object} imageData - Image data object
 * @param {string} modelType - Model type
 * @returns {number} Token count
 */
function calculateImageTokens(imageData, modelType = 'openai') {
  if (!imageData) {
    return 0;
  }

  if (modelType === 'anthropic') {
    // Anthropic (Claude) image token estimation
    // Claude Vision processes images differently.
    // Assume roughly 1,600-3,000 tokens for a typical image, depending on complexity.
    // Use a conservative estimate here.
    if (imageData.source?.type === 'base64') {
      // Estimate base64-encoded images from the data size.
      const base64Length = imageData.source.data?.length || 0;
      // Rough estimate: base64 length / 100 is approximately the token count.
      return Math.ceil(base64Length / 100);
    }
    // Use the default estimate for images specified by URL.
    return 2000;
  } else {
    // OpenAI image token estimation
    // Based on the OpenAI pricing documentation:
    // - Low-resolution image: 85 tokens
    // - High-resolution image: 85 base tokens + 170 tokens per 512x512 tile
    
    if (!imageData.url && !imageData.image_url) {
      return 0;
    }

    const detail = imageData.detail || imageData.image_url?.detail || 'auto';
    
    if (detail === 'low') {
      return 85;
    }

    // Use the default estimate for 'high' or 'auto'.
    // Return an estimate assuming an average image size.
    return 765; // Estimate: 85 base tokens + 4 tiles (4 * 170).
  }
}

/**
 * Extract token usage from a streaming response.
 * @param {string} data - SSE data
 * @param {Object} tokenStats - Token statistics object
 * @param {string} modelType - Model type
 */
export function extractTokensFromStream(data, tokenStats, modelType) {
  try {
    if (modelType === 'anthropic') {
      // Extract tokens from the Anthropic format.
      if (data.type === 'message_start' && data.message?.usage) {
        const usage = data.message.usage;
        tokenStats.inputTokens = usage.input_tokens || 0;
        tokenStats.cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        tokenStats.cacheReadTokens = usage.cache_read_input_tokens || 0;
        
        logDebug(`Anthropic tokens - input: ${tokenStats.inputTokens}, cache_creation: ${tokenStats.cacheCreationTokens}, cache_read: ${tokenStats.cacheReadTokens}`);
      }
      
      if (data.type === 'message_delta' && data.usage) {
        tokenStats.outputTokens = data.usage.output_tokens || 0;
        
        // Handle thinking tokens.
        if (data.usage.thinking_output_tokens !== undefined) {
          tokenStats.thinkingTokens = data.usage.thinking_output_tokens || 0;
          logDebug(`Anthropic thinking tokens: ${tokenStats.thinkingTokens}`);
        }
      }
    } else if (modelType === 'openai') {
      // Extract tokens from the OpenAI format.
      if (data.usage) {
        tokenStats.promptTokens = data.usage.prompt_tokens || 0;
        tokenStats.completionTokens = data.usage.completion_tokens || 0;
        tokenStats.totalTokens = data.usage.total_tokens || 0;
        
        // Handle reasoning tokens for o1 models.
        if (data.usage.completion_tokens_details?.reasoning_tokens) {
          tokenStats.reasoningTokens = data.usage.completion_tokens_details.reasoning_tokens;
        }
        
        logDebug(`OpenAI tokens - prompt: ${tokenStats.promptTokens}, completion: ${tokenStats.completionTokens}, total: ${tokenStats.totalTokens}`);
      }
    }
  } catch (error) {
    logError('Failed to extract token usage', error);
  }
}

/**
 * Merge and normalize token statistics.
 * @param {Object} tokenStats - Raw token statistics
 * @returns {Object} Normalized token statistics
 */
export function normalizeTokenStats(tokenStats) {
  const normalized = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    thinking_tokens: 0
  };

  // Normalize input token counts from different field formats.
  normalized.prompt_tokens = 
    tokenStats.promptTokens || 
    tokenStats.inputTokens || 
    tokenStats.prompt_tokens || 
    0;

  // Normalize output token counts from different field formats.
  normalized.completion_tokens = 
    tokenStats.completionTokens || 
    tokenStats.outputTokens || 
    tokenStats.completion_tokens || 
    0;

  // Handle cache-related tokens.
  normalized.cache_creation_tokens = tokenStats.cacheCreationTokens || 0;
  normalized.cache_read_tokens = tokenStats.cacheReadTokens || 0;

  // Handle reasoning and thinking tokens.
  normalized.reasoning_tokens = tokenStats.reasoningTokens || 0;
  normalized.thinking_tokens = tokenStats.thinkingTokens || 0;

  // Calculate total tokens.
  normalized.total_tokens = 
    tokenStats.totalTokens || 
    tokenStats.total_tokens ||
    (normalized.prompt_tokens + normalized.completion_tokens);

  // Include additional reasoning/thinking tokens in the total, if present.
  if (normalized.reasoning_tokens > 0) {
    normalized.total_tokens += normalized.reasoning_tokens;
  }
  if (normalized.thinking_tokens > 0) {
    normalized.total_tokens += normalized.thinking_tokens;
  }

  return normalized;
}

/**
 * Estimate token usage before sending a request.
 * @param {Object} request - Request object
 * @param {string} model - Model name
 * @returns {Object} Estimated token usage
 */
export function estimateRequestTokens(request, model = 'default') {
  const estimate = {
    estimated_prompt_tokens: 0,
    estimated_completion_tokens: 0,
    estimated_total_tokens: 0
  };

  // Estimate input tokens.
  if (request.messages) {
    estimate.estimated_prompt_tokens = countMessagesTokens(request.messages, model);
  } else if (request.prompt) {
    estimate.estimated_prompt_tokens = countTextTokens(request.prompt, model);
  }

  // Estimate output tokens using max_tokens or the default.
  const maxTokens = request.max_tokens || request.max_completion_tokens || 1000;
  estimate.estimated_completion_tokens = Math.min(maxTokens, 4096); // Cap the estimate at a reasonable upper bound.

  // Calculate the total estimated usage.
  estimate.estimated_total_tokens = 
    estimate.estimated_prompt_tokens + 
    estimate.estimated_completion_tokens;

  logInfo(`Token estimate - model: ${model}, input: ${estimate.estimated_prompt_tokens}, output: ${estimate.estimated_completion_tokens}, total: ${estimate.estimated_total_tokens}`);

  return estimate;
}

export default {
  countTextTokens,
  countMessagesTokens,
  calculateImageTokens,
  extractTokensFromStream,
  normalizeTokenStats,
  estimateRequestTokens
};
