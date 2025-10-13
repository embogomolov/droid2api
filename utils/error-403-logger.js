import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 403 错误日志目录
const LOG_DIR = path.join(__dirname, '..', 'logs');
const ERROR_403_LOG = path.join(LOG_DIR, '403_errors.log');

/**
 * BaSui：确保日志目录存在
 */
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * BaSui：格式化时间戳
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * BaSui：脱敏密钥ID - 只显示前6位和后4位
 * @param {string} keyId - 完整的密钥ID
 * @returns {string} 脱敏后的密钥ID
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
 * BaSui：脱敏完整密钥 - 只显示前8位
 * @param {string} key - 完整的密钥（如 fk-xxx）
 * @returns {string} 脱敏后的密钥
 */
function maskApiKey(key) {
  if (!key || key.length <= 10) {
    return '***MASKED***';
  }
  return `${key.substring(0, 8)}...`;
}

/**
 * BaSui：智能JSON格式化，美化输出
 */
function formatJson(data, indent = 2) {
  if (!data) return 'null';
  
  try {
    return JSON.stringify(data, null, indent);
  } catch (error) {
    return `[JSON序列化失败: ${error.message}]`;
  }
}

/**
 * BaSui：从请求中提取系统提示词
 */
function extractSystemPrompt(request) {
  if (!request) return null;

  // Anthropic 格式：system 字段
  if (request.system) {
    return request.system;
  }

  // OpenAI 格式：messages 数组中的 system role
  if (request.messages && Array.isArray(request.messages)) {
    const systemMsg = request.messages.find(msg => msg.role === 'system');
    if (systemMsg) {
      return systemMsg.content;
    }
  }

  return null;
}

/**
 * BaSui：从请求中提取用户提示词
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
 * BaSui：格式化请求信息，便于阅读
 */
function formatRequestInfo(request) {
  const sections = [];

  sections.push('【请求模型】');
  sections.push(`  Model: ${request.model || 'N/A'}`);
  sections.push(`  Stream: ${request.stream || false}`);
  sections.push('');

  // 系统提示词
  const systemPrompt = extractSystemPrompt(request);
  if (systemPrompt) {
    sections.push('【系统提示词】');
    if (typeof systemPrompt === 'string') {
      sections.push(`  ${systemPrompt}`);
    } else {
      sections.push(formatJson(systemPrompt, 2).split('\n').map(line => `  ${line}`).join('\n'));
    }
    sections.push('');
  }

  // 用户提示词
  const userPrompts = extractUserPrompts(request);
  if (userPrompts.length > 0) {
    sections.push('【用户提示词】');
    userPrompts.forEach((prompt, index) => {
      sections.push(`  [消息 ${index + 1}]`);
      if (typeof prompt === 'string') {
        sections.push(`  ${prompt}`);
      } else {
        sections.push(formatJson(prompt, 2).split('\n').map(line => `  ${line}`).join('\n'));
      }
      sections.push('');
    });
  }

  // 完整消息历史
  if (request.messages && Array.isArray(request.messages)) {
    sections.push('【完整消息历史】');
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

  // 其他参数
  sections.push('【其他参数】');
  const otherParams = { ...request };
  delete otherParams.model;
  delete otherParams.stream;
  delete otherParams.messages;
  delete otherParams.system;
  
  if (Object.keys(otherParams).length > 0) {
    sections.push(formatJson(otherParams, 2).split('\n').map(line => `  ${line}`).join('\n'));
  } else {
    sections.push('  (无)');
  }
  sections.push('');

  return sections.join('\n');
}

/**
 * BaSui：记录 403 错误的详细日志
 * @param {Object} options - 日志选项
 * @param {string} options.requestId - 请求ID
 * @param {string} options.keyId - 密钥ID
 * @param {Object} options.originalRequest - 原始请求（OpenAI 格式）
 * @param {Object} options.transformedRequest - 转换后的请求（实际发送给上游的）
 * @param {Object} options.headers - 请求头
 * @param {string} options.endpoint - 上游端点
 * @param {string} options.errorDetails - 错误详情
 * 
 * 环境变量配置：
 * - LOG_403_MASK_KEYS=false - 完全隐藏密钥ID（显示为 ***HIDDEN***）
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
    
    // 检查是否完全隐藏密钥ID
    const maskKeys = process.env.LOG_403_MASK_KEYS !== 'false';
    const displayKeyId = maskKeys ? maskKeyId(keyId) : '***HIDDEN***';

    const timestamp = getTimestamp();
    
    // 构建日志内容
    const logLines = [];
    logLines.push('');
    logLines.push('═'.repeat(100));
    logLines.push(`403 FORBIDDEN ERROR - ${timestamp}`);
    logLines.push('═'.repeat(100));
    logLines.push('');

    // 基本信息
    logLines.push('【基本信息】');
    logLines.push(`  Request ID: ${requestId}`);
    logLines.push(`  Key ID: ${displayKeyId}${maskKeys ? ' (已脱敏)' : ' (已隐藏)'}`);
    logLines.push(`  Endpoint: ${endpoint}`);
    logLines.push(`  Timestamp: ${timestamp}`);
    logLines.push('');

    // 错误详情
    logLines.push('【错误详情】');
    logLines.push(`  ${errorDetails}`);
    logLines.push('');

    // 原始请求信息（OpenAI 格式）
    logLines.push('┌─────────────────────────────────────────────────────────────────────────┐');
    logLines.push('│  原始请求（OpenAI 格式）                                                  │');
    logLines.push('└─────────────────────────────────────────────────────────────────────────┘');
    logLines.push('');
    logLines.push(formatRequestInfo(originalRequest));

    // 转换后的请求（实际发送的）
    if (JSON.stringify(transformedRequest) !== JSON.stringify(originalRequest)) {
      logLines.push('┌─────────────────────────────────────────────────────────────────────────┐');
      logLines.push('│  转换后的请求（实际发送）                                                │');
      logLines.push('└─────────────────────────────────────────────────────────────────────────┘');
      logLines.push('');
      logLines.push(formatJson(transformedRequest, 2));
      logLines.push('');
    }

    // 请求头信息
    logLines.push('┌─────────────────────────────────────────────────────────────────────────┐');
    logLines.push('│  请求头信息                                                              │');
    logLines.push('└─────────────────────────────────────────────────────────────────────────┘');
    logLines.push('');
    
    // 脱敏处理：隐藏密钥和敏感信息
    const sanitizedHeaders = { ...headers };
    
    // 脱敏 Authorization 头
    if (sanitizedHeaders.authorization) {
      sanitizedHeaders.authorization = sanitizedHeaders.authorization.replace(
        /Bearer\s+(.+)/i,
        (match, key) => `Bearer ${maskApiKey(key)} (已脱敏)`
      );
    }
    
    // 脱敏其他可能包含密钥的头
    ['x-api-key', 'api-key', 'apikey'].forEach(headerName => {
      if (sanitizedHeaders[headerName]) {
        sanitizedHeaders[headerName] = maskApiKey(sanitizedHeaders[headerName]);
      }
    });
    
    logLines.push(formatJson(sanitizedHeaders, 2));
    logLines.push('');

    logLines.push('═'.repeat(100));
    logLines.push('');

    // 写入文件
    const logContent = logLines.join('\n');
    fs.appendFileSync(ERROR_403_LOG, logContent, 'utf-8');

  } catch (error) {
    try {
      ensureLogDir();
      const fallbackMessage = `[${getTimestamp()}] 403日志写入失败: ${error.message}\n`;
      fs.appendFileSync(ERROR_403_LOG, fallbackMessage, 'utf-8');
    } catch {
      // Ignored intentionally to avoid terminal output
    }
  }
}

/**
 * BaSui：获取 403 错误日志文件路径
 */
export function get403LogPath() {
  return ERROR_403_LOG;
}
