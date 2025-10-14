/**
 * Token计算工具 - 基于业内标准算法实现
 * 提供更准确的token计算，修复原有计算不准确的问题
 * 
 * BaSui: 参考new-api项目的实现，使用更准确的计算方法
 * 支持文本、图片、音频等多种内容的token计算
 */

import { logDebug, logInfo, logError } from '../logger.js';

// 定义不同模型的token计算比率和特性
// 基于项目实际配置的模型列表
const MODEL_TOKEN_RATIOS = {
  // Claude 系列 (Anthropic) - 实际使用的模型
  'claude-sonnet-4-20250514': { charToTokenRatio: 0.35, type: 'anthropic' },
  'claude-sonnet-4-5-20250929': { charToTokenRatio: 0.35, type: 'anthropic' },
  
  // GPT-5 系列（实际是Claude后端）
  'gpt-5-2025-08-07': { charToTokenRatio: 0.35, type: 'anthropic' },
  'gpt-5-codex': { charToTokenRatio: 0.35, type: 'anthropic' },
  
  // GLM 系列
  'glm-4.6': { charToTokenRatio: 0.38, type: 'common' },
  
  // 默认配置
  'anthropic': { charToTokenRatio: 0.35, type: 'anthropic' },
  'openai': { charToTokenRatio: 0.38, type: 'openai' },
  'common': { charToTokenRatio: 0.38, type: 'common' },
  'default': { charToTokenRatio: 0.38, type: 'common' }
};

/**
 * 计算文本的token数量（更准确的算法）
 * @param {string} text - 要计算的文本
 * @param {string} model - 模型名称或类型
 * @returns {number} token数量
 */
export function countTextTokens(text, model = 'default') {
  if (!text || typeof text !== 'string') {
    return 0;
  }

  // 获取模型配置
  const modelConfig = MODEL_TOKEN_RATIOS[model] || MODEL_TOKEN_RATIOS['default'];
  const modelType = modelConfig.type;

  // 基础统计
  const chineseCharCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWordCount = (text.match(/[a-zA-Z]+/g) || []).length;
  const numberCount = (text.match(/\d+/g) || []).length;
  const punctuationCount = (text.match(/[^\w\s\u4e00-\u9fa5]/g) || []).length;
  const spaceCount = (text.match(/\s/g) || []).length;
  
  let tokenCount = 0;
  
  // 根据模型类型使用不同的计算方式
  if (modelType === 'anthropic') {
    // Anthropic (Claude) 的token计算
    // Claude对中文的处理略有不同，通常1个中文字符 ≈ 1.2 tokens
    tokenCount = 
      chineseCharCount * 1.2 +
      englishWordCount * 1.0 +
      numberCount * 0.8 +
      punctuationCount * 0.5 +
      spaceCount * 0.3;
  } else if (modelType === 'openai') {
    // OpenAI GPT 的token计算
    tokenCount = 
      chineseCharCount * 1.0 +
      englishWordCount * 1.0 +
      numberCount * 0.7 +
      punctuationCount * 0.3 +
      spaceCount * 0.2;
  } else {
    // 通用计算（GLM等其他模型）
    tokenCount = 
      chineseCharCount * 1.0 +
      englishWordCount * 1.0 +
      numberCount * 0.8 +
      punctuationCount * 0.4 +
      spaceCount * 0.2;
  }

  // 向上取整
  tokenCount = Math.ceil(tokenCount);

  logDebug(`Token计算 [${modelType}]: 文本长度=${text.length}, 中文=${chineseCharCount}, 英文词=${englishWordCount}, 数字=${numberCount}, 计算tokens=${tokenCount}`);

  return tokenCount;
}

/**
 * 计算消息列表的token数量
 * @param {Array} messages - 消息列表
 * @param {string} model - 模型名称或类型
 * @returns {number} token数量
 */
export function countMessagesTokens(messages, model = 'default') {
  if (!messages || !Array.isArray(messages)) {
    return 0;
  }

  // 获取模型配置
  const modelConfig = MODEL_TOKEN_RATIOS[model] || MODEL_TOKEN_RATIOS['default'];
  const modelType = modelConfig.type;

  let totalTokens = 0;

  // 根据模型类型设置不同的消息开销
  const messageOverhead = modelType === 'anthropic' ? 4 : 3; // Anthropic格式稍微复杂一些

  messages.forEach(message => {
    // 添加消息格式开销
    totalTokens += messageOverhead;

    // 计算角色tokens
    if (message.role) {
      totalTokens += countTextTokens(message.role, model);
    }

    // 计算内容tokens
    if (message.content) {
      if (typeof message.content === 'string') {
        totalTokens += countTextTokens(message.content, model);
      } else if (Array.isArray(message.content)) {
        // 处理多模态内容（文本、图片、工具使用等）
        message.content.forEach(item => {
          if (item.type === 'text' && item.text) {
            totalTokens += countTextTokens(item.text, model);
          } else if (item.type === 'image' || item.type === 'image_url') {
            // 图片token计算
            totalTokens += calculateImageTokens(item.image_url || item, modelType);
          } else if (item.type === 'tool_use') {
            // Anthropic的工具使用格式
            totalTokens += messageOverhead;
            if (item.name) {
              totalTokens += countTextTokens(item.name, model);
            }
            if (item.input) {
              totalTokens += countTextTokens(JSON.stringify(item.input), model);
            }
          } else if (item.type === 'tool_result') {
            // Anthropic的工具结果格式
            totalTokens += messageOverhead;
            if (item.content) {
              totalTokens += countTextTokens(item.content, model);
            }
          }
        });
      }
    }

    // 处理工具调用（OpenAI格式）
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

    // 处理name字段
    if (message.name) {
      totalTokens += countTextTokens(message.name, model);
    }
  });

  // 添加对话的整体开销
  totalTokens += modelType === 'anthropic' ? 5 : 3;

  return totalTokens;
}

/**
 * 计算图片的token数量
 * @param {Object} imageData - 图片数据对象
 * @param {string} modelType - 模型类型
 * @returns {number} token数量
 */
function calculateImageTokens(imageData, modelType = 'openai') {
  if (!imageData) {
    return 0;
  }

  if (modelType === 'anthropic') {
    // Anthropic (Claude) 的图片token计算
    // Claude Vision对图片的处理方式不同
    // 通常一张标准图片约 1600-3000 tokens，取决于图片复杂度
    // 这里使用保守估算
    if (imageData.source?.type === 'base64') {
      // Base64编码的图片，根据数据大小估算
      const base64Length = imageData.source.data?.length || 0;
      // 粗略估算：base64长度 / 100 ≈ tokens
      return Math.ceil(base64Length / 100);
    }
    // URL图片，使用默认估算
    return 2000;
  } else {
    // OpenAI的图片token计算
    // 根据OpenAI的定价文档：
    // - 低分辨率图片: 85 tokens
    // - 高分辨率图片: 基础85 + 每512x512瓦片170 tokens
    
    if (!imageData.url && !imageData.image_url) {
      return 0;
    }

    const detail = imageData.detail || imageData.image_url?.detail || 'auto';
    
    if (detail === 'low') {
      return 85;
    }

    // 对于'high'或'auto'，使用默认估算
    // 假设平均图片大小，返回一个合理的估算值
    return 765; // 基础85 + 4个瓦片(4*170)的估算
  }
}

/**
 * 从流式响应中提取token使用量
 * @param {string} data - SSE数据
 * @param {Object} tokenStats - token统计对象
 * @param {string} modelType - 模型类型
 */
export function extractTokensFromStream(data, tokenStats, modelType) {
  try {
    if (modelType === 'anthropic') {
      // Anthropic格式的token提取
      if (data.type === 'message_start' && data.message?.usage) {
        const usage = data.message.usage;
        tokenStats.inputTokens = usage.input_tokens || 0;
        tokenStats.cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        tokenStats.cacheReadTokens = usage.cache_read_input_tokens || 0;
        
        logDebug(`Anthropic tokens - input: ${tokenStats.inputTokens}, cache_creation: ${tokenStats.cacheCreationTokens}, cache_read: ${tokenStats.cacheReadTokens}`);
      }
      
      if (data.type === 'message_delta' && data.usage) {
        tokenStats.outputTokens = data.usage.output_tokens || 0;
        
        // 处理思考模型的tokens
        if (data.usage.thinking_output_tokens !== undefined) {
          tokenStats.thinkingTokens = data.usage.thinking_output_tokens || 0;
          logDebug(`Anthropic thinking tokens: ${tokenStats.thinkingTokens}`);
        }
      }
    } else if (modelType === 'openai') {
      // OpenAI格式的token提取
      if (data.usage) {
        tokenStats.promptTokens = data.usage.prompt_tokens || 0;
        tokenStats.completionTokens = data.usage.completion_tokens || 0;
        tokenStats.totalTokens = data.usage.total_tokens || 0;
        
        // 处理推理token（o1模型）
        if (data.usage.completion_tokens_details?.reasoning_tokens) {
          tokenStats.reasoningTokens = data.usage.completion_tokens_details.reasoning_tokens;
        }
        
        logDebug(`OpenAI tokens - prompt: ${tokenStats.promptTokens}, completion: ${tokenStats.completionTokens}, total: ${tokenStats.totalTokens}`);
      }
    }
  } catch (error) {
    logError('提取token使用量失败', error);
  }
}

/**
 * 合并和标准化token统计
 * @param {Object} tokenStats - 原始token统计
 * @returns {Object} 标准化的token统计
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

  // 处理不同格式的输入tokens
  normalized.prompt_tokens = 
    tokenStats.promptTokens || 
    tokenStats.inputTokens || 
    tokenStats.prompt_tokens || 
    0;

  // 处理不同格式的输出tokens
  normalized.completion_tokens = 
    tokenStats.completionTokens || 
    tokenStats.outputTokens || 
    tokenStats.completion_tokens || 
    0;

  // 处理缓存相关tokens
  normalized.cache_creation_tokens = tokenStats.cacheCreationTokens || 0;
  normalized.cache_read_tokens = tokenStats.cacheReadTokens || 0;

  // 处理推理相关tokens
  normalized.reasoning_tokens = tokenStats.reasoningTokens || 0;
  normalized.thinking_tokens = tokenStats.thinkingTokens || 0;

  // 计算总tokens
  normalized.total_tokens = 
    tokenStats.totalTokens || 
    tokenStats.total_tokens ||
    (normalized.prompt_tokens + normalized.completion_tokens);

  // 如果有额外的推理/思考tokens，加入总数
  if (normalized.reasoning_tokens > 0) {
    normalized.total_tokens += normalized.reasoning_tokens;
  }
  if (normalized.thinking_tokens > 0) {
    normalized.total_tokens += normalized.thinking_tokens;
  }

  return normalized;
}

/**
 * 估算请求的token使用量（请求前预估）
 * @param {Object} request - 请求对象
 * @param {string} model - 模型名称
 * @returns {Object} 估算的token使用量
 */
export function estimateRequestTokens(request, model = 'default') {
  const estimate = {
    estimated_prompt_tokens: 0,
    estimated_completion_tokens: 0,
    estimated_total_tokens: 0
  };

  // 估算输入tokens
  if (request.messages) {
    estimate.estimated_prompt_tokens = countMessagesTokens(request.messages, model);
  } else if (request.prompt) {
    estimate.estimated_prompt_tokens = countTextTokens(request.prompt, model);
  }

  // 估算输出tokens（基于max_tokens或默认值）
  const maxTokens = request.max_tokens || request.max_completion_tokens || 1000;
  estimate.estimated_completion_tokens = Math.min(maxTokens, 4096); // 合理的上限

  // 计算总估算
  estimate.estimated_total_tokens = 
    estimate.estimated_prompt_tokens + 
    estimate.estimated_completion_tokens;

  logInfo(`Token预估 - 模型: ${model}, 输入: ${estimate.estimated_prompt_tokens}, 输出: ${estimate.estimated_completion_tokens}, 总计: ${estimate.estimated_total_tokens}`);

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
