/**
 * 请求统计 API 路由
 * 提供请求统计数据查询接口
 */

import express from 'express';
import { getStats, getTodayStats, getStatsSummary, get7DaysTrend, resetStats } from '../utils/request-stats.js';
import { logInfo, logError } from '../logger.js';

const router = express.Router();

/**
 * 管理后台鉴权中间件
 */
function adminAuth(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  const expectedKey = process.env.ADMIN_ACCESS_KEY;

  if (!expectedKey || expectedKey === 'your-admin-key-here') {
    return res.status(500).json({
      error: 'Admin key not configured',
      message: 'Please set ADMIN_ACCESS_KEY in .env file'
    });
  }

  if (!adminKey || adminKey !== expectedKey) {
    logError('Unauthorized admin access attempt', {
      ip: req.ip,
      headers: req.headers
    });
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid admin access key'
    });
  }

  next();
}

// 应用鉴权中间件到所有统计路由
router.use(adminAuth);

/**
 * GET /admin/stats/summary
 * 获取统计摘要（用于前端显示）
 * 返回：总Token、总请求、今日Token、今日请求
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
      error: '获取统计摘要失败',
      message: error.message
    });
  }
});

/**
 * GET /admin/stats/full
 * 获取完整统计数据（包括每日历史和按模型统计）
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
      error: '获取完整统计数据失败',
      message: error.message
    });
  }
});

/**
 * GET /admin/stats/today
 * 获取今日统计数据
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
      error: '获取今日统计失败',
      message: error.message
    });
  }
});

/**
 * GET /admin/stats/trend
 * 获取7天使用趋势数据（用于折线图）
 * Query参数：
 *   - days: 天数，默认7天
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
      error: '获取趋势数据失败',
      message: error.message
    });
  }
});

/**
 * POST /admin/stats/reset
 * 重置统计数据（危险操作，需要确认）
 */
router.post('/reset', (req, res) => {
  try {
    const { confirm } = req.body;

    if (confirm !== 'RESET_ALL_STATS') {
      return res.status(400).json({
        success: false,
        error: '需要确认码',
        message: '请在请求体中包含 { "confirm": "RESET_ALL_STATS" }'
      });
    }

    resetStats();
    logInfo('统计数据已重置');

    res.json({
      success: true,
      message: '统计数据已重置'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '重置统计数据失败',
      message: error.message
    });
  }
});

export default router;
