import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// HTTP 403 error log directory
const LOG_DIR = path.join(__dirname, '..', 'logs');
const ERROR_403_LOG = path.join(LOG_DIR, '403_errors.log');

/**
 * BaSui: Ensure the log directory exists.
 */
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * BaSui: Format the timestamp.
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * BaSui: Mask key IDs, showing only the first 6 and last 4 characters.
 * @param {string} keyId - Full key ID
 * @returns {string} Masked key ID
 */
function maskKeyId(keyId) {
  if (!keyId || keyId.length <= 12) {
    return '***MASKED***';
  }
  const prefix = keyId.substring(0, 6);
  const suffix = keyId.substring(keyId.length - 4);
  return `${prefix}...${suffix}`;
}

/**
 * BaSui: Mask API keys, showing only the first 8 characters.
 * @param {string} key - Full API key, such as fk-xxx
 * @returns {string} Masked API key
 */
function maskApiKey(key) {
  if (!key || key.length <= 10) {
    return '***MASKED***';
  }
  return `${key.substring(0, 8)}...`;
}

/**
 * BaSui: Format JSON for readable output.
 */
function formatJson(data, indent = 2) {
  if (!data) return 'null';
  
  try {
    return JSON.stringify(data, null, indent);
  } catch (error) {
    return `[JSON serialization failed: ${error.message}]`;
  }
}

/**
 * BaSui: Extract the system prompt from a request.
 */
function extractSystemPrompt(request) {
  if (!request) return null;

  // Anthropic format: the system field
  if (request.system) {
    return request.system;
  }

  // OpenAI format: the system role in the messages array
  if (request.messages && Array.isArray(request.messages)) {
    const systemMsg = request.messages.find(msg => msg.role === 'system');
    if (systemMsg) {
      return systemMsg.content;
    }
  }

  return null;
}

/**
 * BaSui: Extract user prompts from a request.
 */
function extractUserPrompts(request) {
  if (!request || !request.messages || !Array.isArray(request.messages)) {
    return [];
  }

  return request.messages
    .filter(msg => msg.role === 'user')
    .map(msg => msg.content);
}

/**
 * BaSui: Format request details for readability.
 */
function formatRequestInfo(request) {
  const sections = [];

  sections.push('[Requested model]');
  sections.push(`  Model: ${request.model || 'N/A'}`);
  sections.push(`  Stream: ${request.stream || false}`);
  sections.push('');

  // System prompt
  const systemPrompt = extractSystemPrompt(request);
  if (systemPrompt) {
    sections.push('[System prompt]');
    if (typeof systemPrompt === 'string') {
      sections.push(`  ${systemPrompt}`);
    } else {
      sections.push(formatJson(systemPrompt, 2).split('\n').map(line => `  ${line}`).join('\n'));
    }
    sections.push('');
  }

  // User prompts
  const userPrompts = extractUserPrompts(request);
  if (userPrompts.length > 0) {
    sections.push('[User prompts]');
    userPrompts.forEach((prompt, index) => {
      sections.push(`  [Message ${index + 1}]`);
      if (typeof prompt === 'string') {
        sections.push(`  ${prompt}`);
      } else {
        sections.push(formatJson(prompt, 2).split('\n').map(line => `  ${line}`).join('\n'));
      }
      sections.push('');
    });
  }

  // Complete message history
  if (request.messages && Array.isArray(request.messages)) {
    sections.push('[Complete message history]');
    request.messages.forEach((msg, index) => {
      sections.push(`  [${index + 1}] Role: ${msg.role}`);
      if (typeof msg.content === 'string') {
        const preview = msg.content.length > 200 
          ? msg.content.substring(0, 200) + '...' 
          : msg.content;
        sections.push(`      Content: ${preview}`);
      } else {
        sections.push(`      Content: ${formatJson(msg.content, 2).split('\n').map(line => `      ${line}`).join('\n')}`);
      }
    });
    sections.push('');
  }

  // Other parameters
  sections.push('[Other parameters]');
  const otherParams = { ...request };
  delete otherParams.model;
  delete otherParams.stream;
  delete otherParams.messages;
  delete otherParams.system;
  
  if (Object.keys(otherParams).length > 0) {
    sections.push(formatJson(otherParams, 2).split('\n').map(line => `  ${line}`).join('\n'));
  } else {
    sections.push('  (none)');
  }
  sections.push('');

  return sections.join('\n');
}

/**
 * BaSui: Write a detailed HTTP 403 error log.
 * @param {Object} options - Logging options
 * @param {string} options.requestId - Request ID
 * @param {string} options.keyId - Key ID
 * @param {Object} options.originalRequest - Original request (OpenAI format)
 * @param {Object} options.transformedRequest - Transformed request as sent upstream
 * @param {Object} options.headers - Request headers
 * @param {string} options.endpoint - Upstream endpoint
 * @param {string} options.errorDetails - Error details
 *
 * Environment configuration:
 * - LOG_403_MASK_KEYS=false - Hide the entire key ID (displayed as ***HIDDEN***).
 */
export function log403Error(options) {
  try {
    ensureLogDir();

    const {
      requestId = 'N/A',
      keyId = 'N/A',
      originalRequest = {},
      transformedRequest = {},
      headers = {},
      endpoint = 'N/A',
      errorDetails = 'No details'
    } = options;
    
    // Check whether key IDs should be hidden completely.
    const maskKeys = process.env.LOG_403_MASK_KEYS !== 'false';
    const displayKeyId = maskKeys ? maskKeyId(keyId) : '***HIDDEN***';

    const timestamp = getTimestamp();
    
    // Build the log contents.
    const logLines = [];
    logLines.push('');
    logLines.push('═'.repeat(100));
    logLines.push(`403 FORBIDDEN ERROR - ${timestamp}`);
    logLines.push('═'.repeat(100));
    logLines.push('');

    // Basic information
    logLines.push('[Basic information]');
    logLines.push(`  Request ID: ${requestId}`);
    logLines.push(`  Key ID: ${displayKeyId}${maskKeys ? ' (masked)' : ' (hidden)'}`);
    logLines.push(`  Endpoint: ${endpoint}`);
    logLines.push(`  Timestamp: ${timestamp}`);
    logLines.push('');

    // Error details
    logLines.push('[Error details]');
    logLines.push(`  ${errorDetails}`);
    logLines.push('');

    // Original request details (OpenAI format)
    logLines.push('┌─────────────────────────────────────────────────────────────────────────┐');
    logLines.push('│  Original request (OpenAI format)                                       │');
    logLines.push('└─────────────────────────────────────────────────────────────────────────┘');
    logLines.push('');
    logLines.push(formatRequestInfo(originalRequest));

    // Transformed request as actually sent
    if (JSON.stringify(transformedRequest) !== JSON.stringify(originalRequest)) {
      logLines.push('┌─────────────────────────────────────────────────────────────────────────┐');
      logLines.push('│  Transformed request (as sent)                                          │');
      logLines.push('└─────────────────────────────────────────────────────────────────────────┘');
      logLines.push('');
      logLines.push(formatJson(transformedRequest, 2));
      logLines.push('');
    }

    // Request headers
    logLines.push('┌─────────────────────────────────────────────────────────────────────────┐');
    logLines.push('│  Request headers                                                        │');
    logLines.push('└─────────────────────────────────────────────────────────────────────────┘');
    logLines.push('');
    
    // Mask API keys and sensitive information.
    const sanitizedHeaders = { ...headers };
    
    // Mask the Authorization header.
    if (sanitizedHeaders.authorization) {
      sanitizedHeaders.authorization = sanitizedHeaders.authorization.replace(
        /Bearer\s+(.+)/i,
        (match, key) => `Bearer ${maskApiKey(key)} (masked)`
      );
    }
    
    // Mask other headers that may contain API keys.
    ['x-api-key', 'api-key', 'apikey'].forEach(headerName => {
      if (sanitizedHeaders[headerName]) {
        sanitizedHeaders[headerName] = maskApiKey(sanitizedHeaders[headerName]);
      }
    });
    
    logLines.push(formatJson(sanitizedHeaders, 2));
    logLines.push('');

    logLines.push('═'.repeat(100));
    logLines.push('');

    // Write to the log file.
    const logContent = logLines.join('\n');
    fs.appendFileSync(ERROR_403_LOG, logContent, 'utf-8');

  } catch (error) {
    try {
      ensureLogDir();
      const fallbackMessage = `[${getTimestamp()}] Failed to write HTTP 403 error log: ${error.message}\n`;
      fs.appendFileSync(ERROR_403_LOG, fallbackMessage, 'utf-8');
    } catch {
      // Ignored intentionally to avoid terminal output
    }
  }
}

/**
 * BaSui: Get the HTTP 403 error log path.
 */
export function get403LogPath() {
  return ERROR_403_LOG;
}
