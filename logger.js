import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isDevMode, getMaxJsonLogSize } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Log directory configuration
const LOG_DIR = path.join(__dirname, 'logs');

// BaSui: Ensure the log directory exists
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

// BaSui: Get the log filename for the current date
function getLogFileName() {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(LOG_DIR, `droid2api_${date}.log`);
}

// BaSui: Format a timestamp
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * BaSui: Smart JSON serialization: truncate large objects and pretty-print small ones
 * Avoid performance degradation from repeatedly serializing large objects!
 */
function smartStringify(data, isConsole = false) {
  if (!data) return '';

  try {
    const jsonStr = JSON.stringify(data);
    const maxSize = getMaxJsonLogSize();
    
    // Use a smaller limit for console output
    const consoleMaxSize = isConsole ? Math.min(maxSize, 500) : maxSize;

    // Output only a summary when the object is too large
    if (jsonStr.length > consoleMaxSize) {
      const summary = {
        _truncated: true,
        _original_size: jsonStr.length,
        _preview: jsonStr.substring(0, consoleMaxSize) + '...',
        _hint: isConsole ? 'Full content has been written to the log file' : undefined
      };
      return JSON.stringify(summary, null, 2);
    }

    // Pretty-print objects of normal size
    return JSON.stringify(data, null, 2);
  } catch (error) {
    return `[JSON serialization failed: ${error.message}]`;
  }
}

/**
 * BaSui: Write to the log file
 * Append to avoid overwriting existing logs
 */
function writeToFile(level, message, data = null) {
  // BaSui: Also write files in development mode to retain full logs!

  try {
    ensureLogDir();
    const logFile = getLogFileName();
    const timestamp = getTimestamp();

    let logLine = `[${timestamp}] [${level}] ${message}\n`;

    if (data) {
      logLine += `${smartStringify(data)}\n`;
    }

    logLine += '\n'; // BaSui: Separate entries with a blank line for readability

    fs.appendFileSync(logFile, logLine, 'utf-8');
  } catch (error) {
    // BaSui: File logging failures must not disrupt the application; report them to the console only
    console.error(`[Failed to write to the log file] ${error.message}`);
  }
}

export function logInfo(message, data = null) {
  const isDev = isDevMode();

  // BaSui: Console output
  if (isDev) {
    // Development mode: detailed output (with long content truncated)
    console.log(`\x1b[36m[INFO]\x1b[0m ${message}`);
    if (data) {
      console.log(smartStringify(data, true));
    }
  }
  // Production mode: write to files only, without console output

  // BaSui: Write to a file (full content)
  writeToFile('INFO', message, data);
}

export function logWarn(message, data = null) {
  const isDev = isDevMode();

  // BaSui: Always output warnings to the console
  console.warn(`\x1b[33m[WARN]\x1b[0m ${message}`);
  
  if (data && isDev) {
    console.warn(smartStringify(data, true));
  }

  // BaSui: Write warnings to a file to help investigate potential issues
  writeToFile('WARN', message, data);
}

export function logDebug(message, data = null) {
  const isDev = isDevMode();

  // BaSui: DEBUG logs are output to the console only in development mode
  if (isDev) {
    console.log(`\x1b[90m[DEBUG]\x1b[0m ${message}`);
    if (data) {
      console.log(smartStringify(data, true));
    }
  }

  // BaSui: Also write files in production mode for troubleshooting
  writeToFile('DEBUG', message, data);
}

export function logError(message, error = null) {
  const isDev = isDevMode();

  // BaSui: Always output errors to the console
  console.error(`\x1b[31m[ERROR]\x1b[0m ${message}`);

  if (error) {
    if (isDev) {
      // Development mode: full error stack (truncated if too long)
      if (error instanceof Error) {
        const stack = error.stack || error.message;
        // Truncate excessively long stacks
        if (stack && stack.length > 1000) {
          console.error(stack.substring(0, 1000) + '\n... [Stack truncated; see the log file for full details]');
        } else {
          console.error(error);
        }
      } else {
        console.error(smartStringify(error, true));
      }
    } else {
      // Production mode: concise error messages
      console.error(error.message || error);
    }
  }

  // BaSui: Always write error logs to files for production troubleshooting!
  writeToFile('ERROR', message, error);
}

export function logRequest(method, url, headers = null, body = null) {
  const isDev = isDevMode();

  if (isDev) {
    // Development mode: detailed request logs
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
  // Production mode: write to files only, without console output

  // BaSui: Write detailed request logs to files in production mode
  const requestData = { method, url, headers, body };
  writeToFile('REQUEST', `${method} ${url}`, requestData);
}

export function logResponse(status, headers = null, body = null) {
  const isDev = isDevMode();

  if (isDev) {
    // Development mode: detailed response logs
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
  // Production mode: write to files only, without console output

  // BaSui: Write detailed response logs to files in production mode
  const responseData = { status, headers, body };
  writeToFile('RESPONSE', `Status: ${status}`, responseData);
}

// BaSui: Export an alias for compatibility with legacy code
export const logWarning = logWarn;
