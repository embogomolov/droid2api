import { logDebug } from '../logger.js';
import { getSystemPrompt } from '../config.js';
import { getBaseHeaders, applyStainlessDefaults } from './headers-common.js';
import keywordFilter from '../utils/keyword-filter.js';

export function transformToCommon(openaiRequest) {
  logDebug('Transforming OpenAI request to Common format');
  
  // 应用关键词过滤
  const filteredRequest = keywordFilter.filterRequest(openaiRequest);
  
  // 基本保持 OpenAI 格式，只在 messages 前面插入 system 消息
  const commonRequest = {
    ...filteredRequest
  };

  const systemPrompt = getSystemPrompt();
  
  if (systemPrompt) {
    // 检查是否已有 system 消息
    const hasSystemMessage = commonRequest.messages?.some(m => m.role === 'system');
    
    if (hasSystemMessage) {
      // 如果已有 system 消息，在第一个 system 消息前插入我们的 system prompt
      commonRequest.messages = filteredRequest.messages.map((msg, index) => {
        if (msg.role === 'system' && index === filteredRequest.messages.findIndex(m => m.role === 'system')) {
          // 找到第一个 system 消息，前置我们的 prompt
          return {
            role: 'system',
            content: systemPrompt + (typeof msg.content === 'string' ? msg.content : '')
          };
        }
        return msg;
      });
    } else {
      // 如果没有 system 消息，在 messages 数组最前面插入
      commonRequest.messages = [
        {
          role: 'system',
          content: systemPrompt
        },
        ...(filteredRequest.messages || [])
      ];
    }
  }

  logDebug('Transformed Common request', commonRequest);
  return commonRequest;
}

export function getCommonHeaders(authHeader, clientHeaders = {}) {
  // 使用公共函数生成基础headers
  const headers = {
    'accept': 'application/json',
    ...getBaseHeaders(authHeader, clientHeaders),
    'x-api-provider': 'baseten'
  };

  // 应用Stainless SDK默认headers
  applyStainlessDefaults(headers, clientHeaders);

  return headers;
}
