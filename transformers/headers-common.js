import { getUserAgent } from '../config.js';
import { generateUUID } from '../utils/uuid.js';

/**
 * Generate session headers (x-session-id and x-assistant-message-id)
 * Use client-supplied values when available; otherwise generate them UUID
 */
export function generateSessionHeaders(clientHeaders = {}) {
  return {
    'x-session-id': clientHeaders['x-session-id'] || generateUUID(),
    'x-assistant-message-id': clientHeaders['x-assistant-message-id'] || generateUUID()
  };
}

/**
 * Get default Stainless SDK header settings
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
 * Apply Stainless SDK headers (client values take precedence over defaults)
 */
export function applyStainlessDefaults(headers, clientHeaders = {}) {
  const defaults = getStainlessDefaults();

  Object.keys(defaults).forEach(header => {
    headers[header] = clientHeaders[header] || defaults[header];
  });

  return headers;
}

/**
 * Generate common base Headers
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
