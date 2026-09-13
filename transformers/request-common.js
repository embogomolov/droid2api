import { logDebug } from '../logger.js';
import { getSystemPrompt } from '../config.js';
import { getBaseHeaders, applyStainlessDefaults } from './headers-common.js';
import keywordFilter from '../utils/keyword-filter.js';

export function transformToCommon(openaiRequest) {
  logDebug('Transforming OpenAI request to Common format');
  
  // Apply keyword filtering
  const filteredRequest = keywordFilter.filterRequest(openaiRequest);
  
  // Preserve the OpenAI format, inserting a system message at the start of messages
  const commonRequest = {
    ...filteredRequest
  };

  const systemPrompt = getSystemPrompt();
  
  if (systemPrompt) {
    // Check for an existing system message
    const hasSystemMessage = commonRequest.messages?.some(m => m.role === 'system');
    
    if (hasSystemMessage) {
      // If a system message exists, prepend our system prompt to it
      commonRequest.messages = filteredRequest.messages.map((msg, index) => {
        if (msg.role === 'system' && index === filteredRequest.messages.findIndex(m => m.role === 'system')) {
          // Find the first system message and prepend our prompt
          return {
            role: 'system',
            content: systemPrompt + (typeof msg.content === 'string' ? msg.content : '')
          };
        }
        return msg;
      });
    } else {
      // If no system message exists, insert one at the start of the messages array
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
  // Use the shared function to generate base headers
  const headers = {
    'accept': 'application/json',
    ...getBaseHeaders(authHeader, clientHeaders),
    'x-api-provider': 'baseten'
  };

  // Apply default Stainless SDK headers
  applyStainlessDefaults(headers, clientHeaders);

  return headers;
}
