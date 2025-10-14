import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isDevMode, getMaxJsonLogSize } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 日志目录配置
const LOG_DIR = path.join(__dirname, 'logs');

// BaSui：确保日志目录存在
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

// BaSui：获取当前日期的日志文件名
function getLogFileName() {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(LOG_DIR, `droid2api_${date}.log`);
}

// BaSui：格式化时间戳
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * BaSui：智能JSON序列化 - 大对象截断，小对象美化
 * 避免疯狂序列化大对象导致性能下降！
 */
function smartStringify(data, isConsole = false) {
  if (!data) return '';

  try {
    const jsonStr = JSON.stringify(data);
    const maxSize = getMaxJsonLogSize();
    
    // 控制台输出时使用更小的限制
    const consoleMaxSize = isConsole ? Math.min(maxSize, 500) : maxSize;

    // 如果对象太大，只输出摘要
    if (jsonStr.length > consoleMaxSize) {
      const summary = {
        _truncated: true,
        _original_size: jsonStr.length,
        _preview: jsonStr.substring(0, consoleMaxSize) + '...',
        _hint: isConsole ? '完整内容已写入日志文件' : undefined
      };
      return JSON.stringify(summary, null, 2);
    }

    // 正常大小的对象，美化输出
    return JSON.stringify(data, null, 2);
  } catch (error) {
    return `[JSON序列化失败: ${error.message}]`;
  }
}

/**
 * BaSui：写入日志文件
 * 使用追加模式，避免覆盖已有日志
 */
function writeToFile(level, message, data = null) {
  // BaSui：开发模式也写文件，保留完整日志！

  try {
    ensureLogDir();
    const logFile = getLogFileName();
    const timestamp = getTimestamp();

    let logLine = `[${timestamp}] [${level}] ${message}\n`;

    if (data) {
      logLine += `${smartStringify(data)}\n`;
    }

    logLine += '\n'; // BaSui：每条日志之间空一行，方便阅读

    fs.appendFileSync(logFile, logLine, 'utf-8');
  } catch (error) {
    // BaSui：文件写入失败不应该影响主程序！只在控制台报个错
    console.error(`[文件日志写入失败] ${error.message}`);
  }
}

export function logInfo(message, data = null) {
  const isDev = isDevMode();

  // BaSui：控制台输出
  if (isDev) {
    // 开发模式：详细输出（但缩短过长内容）
    console.log(`\x1b[36m[INFO]\x1b[0m ${message}`);
    if (data) {
      console.log(smartStringify(data, true));
    }
  }
  // 生产模式：不输出到控制台，只写入文件

  // BaSui：写文件（完整内容）
  writeToFile('INFO', message, data);
}

export function logWarn(message, data = null) {
  const isDev = isDevMode();

  // BaSui：警告日志始终输出到控制台
  console.warn(`\x1b[33m[WARN]\x1b[0m ${message}`);
  
  if (data && isDev) {
    console.warn(smartStringify(data, true));
  }

  // BaSui：警告日志需要写文件，方便追踪潜在问题
  writeToFile('WARN', message, data);
}

export function logDebug(message, data = null) {
  const isDev = isDevMode();

  // BaSui：DEBUG日志只在开发模式输出到控制台
  if (isDev) {
    console.log(`\x1b[90m[DEBUG]\x1b[0m ${message}`);
    if (data) {
      console.log(smartStringify(data, true));
    }
  }

  // BaSui：生产模式也要写文件，方便排查问题
  writeToFile('DEBUG', message, data);
}

export function logError(message, error = null) {
  const isDev = isDevMode();

  // BaSui：错误日志始终输出到控制台
  console.error(`\x1b[31m[ERROR]\x1b[0m ${message}`);

  if (error) {
    if (isDev) {
      // 开发模式：完整错误堆栈（但过长时截断）
      if (error instanceof Error) {
        const stack = error.stack || error.message;
        // 堆栈太长时截断
        if (stack && stack.length > 1000) {
          console.error(stack.substring(0, 1000) + '\n... [堆栈已截断，完整内容见日志文件]');
        } else {
          console.error(error);
        }
      } else {
        console.error(smartStringify(error, true));
      }
    } else {
      // 生产模式：简单错误信息
      console.error(error.message || error);
    }
  }

  // BaSui：错误日志必须写文件！方便排查生产问题！
  writeToFile('ERROR', message, error);
}

export function logRequest(method, url, headers = null, body = null) {
  const isDev = isDevMode();

  if (isDev) {
    // 开发模式：详细的请求日志
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[REQUEST] ${method} ${url}`);
    if (headers) {
      console.log('[HEADERS]', smartStringify(headers));
    }
    if (body) {
      console.log('[BODY]', smartStringify(body));
    }
    console.log('='.repeat(80) + '\n');
  }
  // 生产模式：不输出到控制台，只写入文件

  // BaSui：生产模式写详细的请求日志到文件
  const requestData = { method, url, headers, body };
  writeToFile('REQUEST', `${method} ${url}`, requestData);
}

export function logResponse(status, headers = null, body = null) {
  const isDev = isDevMode();

  if (isDev) {
    // 开发模式：详细的响应日志
    console.log(`\n${'-'.repeat(80)}`);
    console.log(`[RESPONSE] Status: ${status}`);
    if (headers) {
      console.log('[HEADERS]', smartStringify(headers));
    }
    if (body) {
      console.log('[BODY]', smartStringify(body));
    }
    console.log('-'.repeat(80) + '\n');
  }
  // 生产模式：不输出到控制台，只写入文件

  // BaSui：生产模式写详细的响应日志到文件
  const responseData = { status, headers, body };
  writeToFile('RESPONSE', `Status: ${status}`, responseData);
}

// BaSui：别名导出，兼容旧代码
export const logWarning = logWarn;
