/**
 * Token usage extraction helpers
 * BaSui: Extract complete token usage statistics from Anthropic/OpenAI responses.
 * Supports: input_tokens, output_tokens, thinking_tokens, cache_creation_tokens, cache_read_tokens
 *
 * Update: Integrated more accurate token counting and normalization.
 */

import { logDebug } from '../logger.js';
import { normalizeTokenStats, estimateRequestTokens } from './token-counter.js';

/**
 * Extract complete token statistics from an Anthropic streaming response.
 * @param {Object} data - SSE event data
 * @param {Object} tokenStats - Token statistics object (modified in place)
 * @returns {void}
 */
export function extractAnthropicTokens(data, tokenStats) {
  try {
    // The message_start event contains input token and cache statistics.
    if (data.type === 'message_start' && data.message?.usage) {
      const usage = data.message.usage;
      tokenStats.inputTokens = usage.input_tokens || 0;
      tokenStats.cacheCreationTokens = usage.cache_creation_input_tokens || 0;
      tokenStats.cacheReadTokens = usage.cache_read_input_tokens || 0;

      logDebug(`✅ Anthropic message_start: input=${tokenStats.inputTokens}, cache_creation=${tokenStats.cacheCreationTokens}, cache_read=${tokenStats.cacheReadTokens}`);
    }

    // The message_delta event contains cumulative output and reasoning token counts.
    if (data.type === 'message_delta' && data.usage) {
      const usage = data.usage;
      // BaSui: output_tokens is cumulative, not a delta. Assign it directly; do not use +=.
      tokenStats.outputTokens = usage.output_tokens || 0;

      // BaSui: 🔥 Include Extended Thinking tokens, which were previously omitted.
      if (usage.thinking_output_tokens !== undefined) {
        tokenStats.thinkingTokens = usage.thinking_output_tokens || 0;
        logDebug(`💡 Thinking tokens detected: ${tokenStats.thinkingTokens}`);
      }

      logDebug(`✅ Anthropic message_delta: output=${tokenStats.outputTokens}, thinking=${tokenStats.thinkingTokens}`);
    }
  } catch (error) {
    logDebug('⚠️ Error extracting Anthropic tokens', error);
  }
}

/**
 * Extract complete token statistics from an OpenAI streaming response.
 * @param {Object} data - SSE event data
 * @param {Object} tokenStats - Token statistics object (modified in place)
 * @returns {void}
 */
export function extractOpenAITokens(data, tokenStats) {
  try {
    if (data.usage) {
      tokenStats.inputTokens = data.usage.prompt_tokens || data.usage.input_tokens || 0;
      tokenStats.outputTokens = data.usage.completion_tokens || data.usage.output_tokens || 0;

      logDebug(`✅ OpenAI tokens: input=${tokenStats.inputTokens}, output=${tokenStats.outputTokens}`);
    }
  } catch (error) {
    logDebug('⚠️ Error extracting OpenAI tokens', error);
  }
}

/**
 * Extract token statistics from a Common-format streaming response.
 * @param {Object} data - SSE event data
 * @param {Object} tokenStats - Token statistics object (modified in place)
 * @returns {void}
 */
export function extractCommonTokens(data, tokenStats) {
  try {
    if (data.usage) {
      tokenStats.inputTokens = data.usage.prompt_tokens || data.usage.input_tokens || 0;
      tokenStats.outputTokens = data.usage.completion_tokens || data.usage.output_tokens || 0;

      logDebug(`✅ Common tokens: input=${tokenStats.inputTokens}, output=${tokenStats.outputTokens}`);
    }
  } catch (error) {
    logDebug('⚠️ Error extracting Common tokens', error);
  }
}

/**
 * Create an empty token statistics object.
 * @returns {Object}
 */
export function createTokenStats() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  };
}

/**
 * Calculate the total token count.
 * @param {Object} tokenStats
 * @returns {number}
 */
export function getTotalTokens(tokenStats) {
  return (
    (tokenStats.inputTokens || 0) +
    (tokenStats.outputTokens || 0) +
    (tokenStats.thinkingTokens || 0)
    // BaSui: Exclude cached tokens from the total (the Factory API does not bill them either).
  );
}

export default {
  extractAnthropicTokens,
  extractOpenAITokens,
  extractCommonTokens,
  createTokenStats,
  getTotalTokens
};
