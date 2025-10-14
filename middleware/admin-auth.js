/**
 * 管理员认证中间件
 * 统一的管理后台认证逻辑
 */

import { logInfo, logError, logWarn } from '../logger.js';

function extractBearerToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') {
    return null;
  }

  const trimmed = authHeader.trim();
  if (!trimmed) {
    return null;
  }

  const bearerMatch = trimmed.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    const token = bearerMatch[1].trim();
    return token || null;
  }

  return trimmed || null;
}

function normalizeKey(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * 管理员认证中间件
 * @param {Request} req - 请求对象
 * @param {Response} res - 响应对象
 * @param {Function} next - 下一个中间件
 */
export function adminAuth(req, res, next) {
  const headerKey = normalizeKey(req.headers['x-admin-key']);
  const bearerKey = extractBearerToken(req.headers.authorization);
  const queryKey = normalizeKey(req.query.admin_key || req.query.adminKey);
  const adminKey = headerKey || bearerKey || queryKey;
  const configuredKey = process.env.ADMIN_ACCESS_KEY;

  // BaSui：检查是否配置了管理密钥
  if (!configuredKey) {
    logError('管理后台访问失败：未配置ADMIN_ACCESS_KEY环境变量');
    return res.status(500).json({
      error: '管理后台未正确配置',
      message: '请设置ADMIN_ACCESS_KEY环境变量'
    });
  }

  // BaSui：验证管理密钥
  if (!adminKey) {
    logWarn(`管理后台访问失败：缺少认证密钥 [IP: ${req.ip}]`);
    return res.status(401).json({
      error: '需要管理员认证',
      message: '请提供x-admin-key头、Authorization: Bearer密钥或admin_key参数'
    });
  }

  if (adminKey !== configuredKey) {
    logWarn(`管理后台访问失败：密钥错误 [IP: ${req.ip}, Key: ${adminKey.substring(0, 4)}...]`);
    return res.status(403).json({
      error: '认证失败',
      message: '管理员密钥无效'
    });
  }

  // BaSui：记录成功的管理访问
  logInfo(`管理后台访问成功 [IP: ${req.ip}, Path: ${req.path}]`);
  next();
}

export default adminAuth;
