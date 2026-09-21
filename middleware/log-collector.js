/**
 * Log collection middleware: live log streaming
 *
 * @author BaSui
 * @description Intercept requests and responses, collect logs, and push them to SSE clients
 */

import { EventEmitter } from 'events';

// Global log event emitter (singleton)
export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50); // Support up to 50 concurrent SSE connections

// Log buffer (keeps at most the latest 500 entries)
const LOG_BUFFER = [];
const MAX_BUFFER_SIZE = 500;

/**
 * Add a log entry to the buffer
 */
function addLogToBuffer(logEntry) {
  LOG_BUFFER.push(logEntry);

  // Remove the oldest entries when capacity is exceeded
  if (LOG_BUFFER.length > MAX_BUFFER_SIZE) {
    LOG_BUFFER.shift();
  }

  // Emit a log event to all SSE clients
  logEmitter.emit('log', logEntry);
}

/**
 * Get historical logs from the buffer
 */
export function getLogBuffer(limit = 100) {
  return LOG_BUFFER.slice(-limit); // Return the latest N log entries
}

/**
 * Clear the log buffer
 */
export function clearLogBuffer() {
  LOG_BUFFER.length = 0;
}

/**
 * Format a timestamp
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * Truncate large objects to keep logs manageable
 */
function truncateData(data, maxLength = 500) {
  if (!data) return null;

  try {
    const jsonStr = JSON.stringify(data);
    if (jsonStr.length > maxLength) {
      return jsonStr.substring(0, maxLength) + '... (truncated)';
    }
    return jsonStr;
  } catch (error) {
    return '[JSON Serialization failed]';
  }
}

/**
 * Log collection middleware: record request information
 */
export function logCollectorMiddleware(req, res, next) {
  const startTime = Date.now();
  const timestamp = getTimestamp();
  // UI polling and key administration are not generation traffic; never buffer key payloads.
  if ((req.originalUrl || req.url).startsWith('/admin')) return next();
  if (req.method === 'POST' && /^\/v1\/(responses|messages|chat\/completions)\/?$/.test(req.path || req.url)) {
    let recorded = false;
    const complete = () => {
      if (recorded) return;
      recorded = true;
      const report = res.locals?.factoryRequest || {};
      const failed = !res.writableFinished || res.statusCode >= 400 || report.success === false;
      addLogToBuffer({ type: 'generation', url: req.path, timestamp: getTimestamp(), level: failed ? 'error' : 'info',
        summary: { model: report.model || req.body?.model || null, keyId: report.keyId || null,
          elapsedMs: Date.now() - startTime, usage: report.usage || null,
          outcome: !res.writableFinished ? 'Disconnected' : res.statusCode >= 400 ? `HTTP ${res.statusCode}` : report.success === false ? 'Stream failed' : 'Completed',
          error: report.error || null, upstreamError: report.upstreamError || null } });
    };
    res.once('finish', complete); res.once('close', complete);
    return next();
  }


  // 🔍 Record the request log
  const requestLog = {
    type: 'request',
    level: 'info',
    timestamp,
    method: req.method,
    url: req.originalUrl || req.url,
    ip: req.ip || req.connection.remoteAddress,
    headers: {
      'user-agent': req.headers['user-agent'],
      'content-type': req.headers['content-type'],
      'authorization': req.headers['authorization'] ? '[REDACTED]' : undefined,
      'x-api-key': req.headers['x-api-key'] ? '[REDACTED]' : undefined,
    },
    body: req.method !== 'GET' ? truncateData(req.body, 300) : undefined,
  };

  addLogToBuffer(requestLog);

  // 🎯 Intercept the response to record its log
  const originalSend = res.send;
  const originalJson = res.json;

  res.send = function(data) {
    const duration = Date.now() - startTime;

    // 📊 Record the response log
    const responseLog = {
      type: 'response',
      level: res.statusCode >= 400 ? 'error' : res.statusCode >= 300 ? 'warn' : 'info',
      timestamp: getTimestamp(),
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      body: truncateData(data, 300),
    };

    addLogToBuffer(responseLog);

    // Call the original send method
    return originalSend.call(this, data);
  };

  res.json = function(data) {
    const duration = Date.now() - startTime;

    // 📊 Record the response log
    const responseLog = {
      type: 'response',
      level: res.statusCode >= 400 ? 'error' : res.statusCode >= 300 ? 'warn' : 'info',
      timestamp: getTimestamp(),
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      body: truncateData(data, 300),
    };

    addLogToBuffer(responseLog);

    // Call the original json method
    return originalJson.call(this, data);
  };

  next();
}

/**
 * Record logs manually (for use by other modules)
 */
export function logMessage(level, message, data = null) {
  const logEntry = {
    type: 'message',
    level,
    timestamp: getTimestamp(),
    message,
    data: truncateData(data, 500),
  };

  addLogToBuffer(logEntry);
}

/**
 * Record an error log
 */
export function logError(message, error = null) {
  const logEntry = {
    type: 'error',
    level: 'error',
    timestamp: getTimestamp(),
    message,
    error: error ? {
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join('\n'), // Keep only the first 3 stack lines
    } : null,
  };

  addLogToBuffer(logEntry);
}

console.log('✅ Log collection middleware loaded - BaSui');
