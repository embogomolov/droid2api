/**
 * Live log streaming routes - SSE (Server-Sent Events)
 *
 * @author BaSui
 * @description Provide live log streaming with filtering and history queries
 */

import { Router } from 'express';
import { logEmitter, getLogBuffer, clearLogBuffer } from '../middleware/log-collector.js';
import { generateUUID } from '../utils/uuid.js';

const router = Router();

// 🔧 SSE Connection management (fix, BaSui: these two variables were previously missing!)
const activeConnections = new Map(); // key: connectionId, value: { req, res, startTime }
let connectionCounter = 0; // Connection counter (for statistics)

/**
 * SSE Log streaming endpoint
 * GET /admin/logs/stream
 *
 * Query parameters:
 * - level: Log level filter (info/warn/error/debug; comma-separated for multiple levels)
 * - keyword: Keyword filter (substring matching against URLs and message text)
 */
router.get('/logs/stream', (req, res) => {
  // 🔒 Set SSE response headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx compatibility
  res.write(': connected\n\n'); // Establish SSE immediately, even with an empty log buffer.

  // 📋 Get filter parameters
  const levelFilter = req.query.level ? req.query.level.split(',') : null;
  const keywordFilter = req.query.keyword ? req.query.keyword.toLowerCase() : null;

  // 🆔 Generate a connection ID (fix, BaSui: give each connection a unique identifier)
  const connectionId = generateUUID();
  connectionCounter++;
  activeConnections.set(connectionId, {
    req,
    res,
    startTime: Date.now(),
    levelFilter,
    keywordFilter,
  });

  console.log(`[SSE] New client connected - ID: ${connectionId}, IP: ${req.ip}, filters: level=${levelFilter}, keyword=${keywordFilter}, active connections: ${activeConnections.size}`);

  /**
   * Log filter function
   */
  function shouldSendLog(logEntry) {
    // Level filter
    if (levelFilter && !levelFilter.includes(logEntry.level)) {
      return false;
    }

    // Keyword filter
    if (keywordFilter) {
      const searchableText = JSON.stringify(logEntry).toLowerCase();
      if (!searchableText.includes(keywordFilter)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Send an SSE event
   */
  function sendSSE(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * Send a heartbeat every 30 seconds
   */
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  /**
   * Log listener
   */
  const logListener = (logEntry) => {
    if (shouldSendLog(logEntry)) {
      sendSSE(logEntry);
    }
  };

  // 🎯 Register the log listener
  logEmitter.on('log', logListener);

  // 📦 Send historical logs (latest 100 entries)
  const historyLogs = getLogBuffer(100).filter(shouldSendLog);
  if (historyLogs.length > 0) {
    sendSSE({
      type: 'history',
      timestamp: new Date().toISOString(),
      logs: historyLogs,
    });
  }

  // 🔌 Clean up when the client disconnects
  
  // 🔌 Clean up when the client disconnects
  const cleanup = () => {
    console.log(`[SSE] Client disconnected - ID: ${connectionId}, remaining connections: ${activeConnections.size - 1}`);
    clearInterval(heartbeatInterval);
    logEmitter.removeListener('log', logListener);
    activeConnections.delete(connectionId);
  };
  
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

});

/**
 * Get historical logs
 * GET /admin/logs/history?limit=100&level=error&keyword=test
 */
router.get('/logs/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const levelFilter = req.query.level ? req.query.level.split(',') : null;
    const keywordFilter = req.query.keyword ? req.query.keyword.toLowerCase() : null;

    let logs = getLogBuffer(Math.min(limit, 500)); // Return at most 500 entries

    // Apply filters
    if (levelFilter || keywordFilter) {
      logs = logs.filter((log) => {
        // Level filter
        if (levelFilter && !levelFilter.includes(log.level)) {
          return false;
        }

        // Keyword filter
        if (keywordFilter) {
          const searchableText = JSON.stringify(log).toLowerCase();
          if (!searchableText.includes(keywordFilter)) {
            return false;
          }
        }

        return true;
      });
    }

    res.json({
      success: true,
      count: logs.length,
      logs,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get historical logs',
      error: error.message,
    });
  }
});

/**
 * Clear the log buffer
 * DELETE /admin/logs/clear
 */
router.delete('/logs/clear', (req, res) => {
  try {
    clearLogBuffer();
    res.json({
      success: true,
      message: 'Logs cleared',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to clear logs',
      error: error.message,
    });
  }
});

/**
 * Get log statistics
 * GET /admin/logs/stats
 */
router.get('/logs/stats', (req, res) => {
  try {
    const logs = getLogBuffer(500);

    const stats = {
      total: logs.length,
      byLevel: {
        info: logs.filter((log) => log.level === 'info').length,
        warn: logs.filter((log) => log.level === 'warn').length,
        error: logs.filter((log) => log.level === 'error').length,
        debug: logs.filter((log) => log.level === 'debug').length,
      },
      byType: {
        request: logs.filter((log) => log.type === 'request').length,
        response: logs.filter((log) => log.type === 'response').length,
        message: logs.filter((log) => log.type === 'message').length,
        error: logs.filter((log) => log.type === 'error').length,
      },
    };

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get log statistics',
      error: error.message,
    });
  }
});

export default router;

console.log('✅ Live log streaming routes loaded - BaSui');
