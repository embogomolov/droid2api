import { getUserAgent } from '../config.js';
import { generateUUID } from '../utils/uuid.js';

/**
 * 生成会话Headers（x-session-id 和 x-assistant-message-id）
 * 如果客户端已提供则使用客户端的，否则自动生成UUID
 */
export function generateSessionHeaders(clientHeaders = {}) {
  return {
    'x-session-id': clientHeaders['x-session-id'] || generateUUID(),
    'x-assistant-message-id': clientHeaders['x-assistant-message-id'] || generateUUID()
  };
}

/**
 * 获取Stainless SDK默认Headers配置
 */
export function getStainlessDefaults() {
  return {
    'x-stainless-arch': 'x64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'MacOS',
    'x-stainless-runtime': 'node',
    'x-stainless-retry-count': '0',
    'x-stainless-package-version': '5.23.2',
    'x-stainless-runtime-version': 'v24.3.0'
  };
}

/**
 * 应用Stainless SDK Headers（客户端提供优先，否则使用默认值）
 */
export function applyStainlessDefaults(headers, clientHeaders = {}) {
  const defaults = getStainlessDefaults();

  Object.keys(defaults).forEach(header => {
    headers[header] = clientHeaders[header] || defaults[header];
  });

  return headers;
}

/**
 * 生成通用基础Headers
 */
export function getBaseHeaders(authHeader, clientHeaders = {}) {
  const sessionHeaders = generateSessionHeaders(clientHeaders);

  return {
    'content-type': 'application/json',
    'authorization': authHeader || '',
    'x-factory-client': 'cli',
    ...sessionHeaders,
    'user-agent': getUserAgent(),
    'connection': 'keep-alive'
  };
}
