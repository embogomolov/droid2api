/**
 * Request statistics API routes
 * Provide endpoints for querying request statistics
 */

import express from 'express';
import { adminAuth } from '../middleware/admin-auth.js'; // 🔧 Optimization: use shared authentication middleware
import { getStats, getTodayStats, getStatsSummary, get7DaysTrend, resetStats } from '../utils/request-stats.js';
import { logInfo, logError } from '../logger.js';

const router = express.Router();

// Apply authentication middleware to all statistics routes
router.use(adminAuth);

/**
 * GET /admin/stats/summary
 * Get the statistics summary for display in the UI
 * Returns total tokens, total requests, tokens today, and requests today
 */
router.get('/summary', (req, res) => {
  try {
    const summary = getStatsSummary();
    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get the statistics summary',
      message: error.message
    });
  }
});

/**
 * GET /admin/stats/full
 * Get full statistics (including daily history and per-model statistics)
 */
router.get('/full', (req, res) => {
  try {
    const stats = getStats();
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get full statistics',
      message: error.message
    });
  }
});

/**
 * GET /admin/stats/today
 * Get statistics for today
 */
router.get('/today', (req, res) => {
  try {
    const todayStats = getTodayStats();
    res.json({
      success: true,
      data: todayStats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get statistics for today',
      message: error.message
    });
  }
});

/**
 * GET /admin/stats/trend
 * Get 7-day usage trends for the line chart
 * Query parameters:
 *   - days: Number of days; default 7
 */
router.get('/trend', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const trendData = get7DaysTrend(days);
    res.json({
      success: true,
      data: trendData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get trend data',
      message: error.message
    });
  }
});

/**
 * POST /admin/stats/reset
 * Reset statistics (destructive operation; confirmation required)
 */
router.post('/reset', (req, res) => {
  try {
    const { confirm } = req.body;

    if (confirm !== 'RESET_ALL_STATS') {
      return res.status(400).json({
        success: false,
        error: 'Confirmation code required',
        message: 'Include the following in the request body { "confirm": "RESET_ALL_STATS" }'
      });
    }

    resetStats();
    logInfo('Statistics reset');

    res.json({
      success: true,
      message: 'Statistics reset'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to reset statistics',
      message: error.message
    });
  }
});

export default router;
