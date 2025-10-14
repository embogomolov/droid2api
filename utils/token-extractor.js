/**
 * Token 提取工具
 * BaSui: 专门用来从 Anthropic/OpenAI 响应中提取完整的 Token 统计
 * 支持：input_tokens, output_tokens, thinking_tokens, cache_creation_tokens, cache_read_tokens
 * 
 * 更新：集成了更准确的token计算和标准化功能
 */

import { logDebug } from '../logger.js';
import { normalizeTokenStats, estimateRequestTokens } from './token-counter.js';

/**
 * 从 Anthropic 流式响应中提取完整 Token 统计
 * @param {Object} data - SSE 事件数据
 * @param {Object} tokenStats - Token 统计对象（会被修改）
 * @returns {void}
 */
export function extractAnthropicTokens(data, tokenStats) {
  try {
    // message_start 事件：包含输入 Token 和缓存统计
    if (data.type === 'message_start' && data.message?.usage) {
      const usage = data.message.usage;
      tokenStats.inputTokens = usage.input_tokens || 0;
      tokenStats.cacheCreationTokens = usage.cache_creation_input_tokens || 0;
      tokenStats.cacheReadTokens = usage.cache_read_input_tokens || 0;

      logDebug(`✅ Anthropic message_start: input=${tokenStats.inputTokens}, cache_creation=${tokenStats.cacheCreationTokens}, cache_read=${tokenStats.cacheReadTokens}`);
    }

    // message_delta 事件：包含输出 Token（累计值）和推理 Token
    if (data.type === 'message_delta' && data.usage) {
      const usage = data.usage;
      // BaSui: output_tokens 是累计值，不是增量！直接赋值，不要用 +=
      tokenStats.outputTokens = usage.output_tokens || 0;

      // BaSui: 🔥 重要！Extended Thinking 的 Token 统计（这个之前漏了！）
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
 * 从 OpenAI 流式响应中提取完整 Token 统计
 * @param {Object} data - SSE 事件数据
 * @param {Object} tokenStats - Token 统计对象（会被修改）
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
 * 从 Common（通用）流式响应中提取 Token 统计
 * @param {Object} data - SSE 事件数据
 * @param {Object} tokenStats - Token 统计对象（会被修改）
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
 * 创建空的 Token 统计对象
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
 * 计算总 Token 数
 * @param {Object} tokenStats
 * @returns {number}
 */
export function getTotalTokens(tokenStats) {
  return (
    (tokenStats.inputTokens || 0) +
    (tokenStats.outputTokens || 0) +
    (tokenStats.thinkingTokens || 0)
    // BaSui: 缓存 Token 不计入总数（Factory API 也不计费）
  );
}

export default {
  extractAnthropicTokens,
  extractOpenAITokens,
  extractCommonTokens,
  createTokenStats,
  getTotalTokens
};
