import { logInfo, logError, logDebug } from '../logger.js';

/**
 * 客户端认证中间件
 *
 * BaSui：这个SB中间件用来验证客户端的访问权限，别tm让随便谁都能用咱们的代理！
 *
 * 支持三种认证方式（按优先级）：
 * 1. FACTORY_API_KEY - 固定API密钥（最高优先级，跳过客户端验证）
 * 2. API_ACCESS_KEY - 服务端配置的客户端访问密钥
 * 3. 无验证模式 - 如果没配置任何密钥，允许所有请求通过（开发模式）
 */
export function validateClientAuth(req, res, next) {
  // BaSui：如果配置了FACTORY_API_KEY，说明是单用户模式，跳过客户端验证
  const factoryKey = process.env.FACTORY_API_KEY;
  if (factoryKey) {
    logDebug('FACTORY_API_KEY configured, skipping client auth');
    // 删除客户端的 authorization 头，防止误转发
    delete req.headers.authorization;
    return next();
  }

  // BaSui：检查是否配置了API_ACCESS_KEY（服务端访问密钥）
  const apiAccessKey = process.env.API_ACCESS_KEY;

  // 如果没配置API_ACCESS_KEY，进入开发模式（允许所有请求）
  if (!apiAccessKey) {
    logDebug('No API_ACCESS_KEY configured, allowing all requests (dev mode)');
    // 删除客户端的 authorization 头，防止误转发
    delete req.headers.authorization;
    return next();
  }

  // BaSui：从请求头中提取客户端提供的密钥
  // 支持两种格式：
  // 1. x-api-key: your_access_key
  // 2. authorization: Bearer your_access_key
  const clientKey = req.headers['x-api-key'] || extractBearerToken(req.headers.authorization);

  if (!clientKey) {
    logError('客户端认证失败：未提供 API 密钥');
    return res.status(401).json({
      error: '未授权',
      message: '需要 API 密钥。请提供 x-api-key 头或 Authorization: Bearer <key>'
    });
  }

  // BaSui：验证客户端密钥是否匹配
  if (clientKey !== apiAccessKey) {
    logError('客户端认证失败：无效的 API 密钥');
    return res.status(401).json({
      error: '未授权',
      message: '无效的 API 密钥'
    });
  }

  // 验证通过！删除原始 authorization 头，防止转发给上游
  delete req.headers.authorization;
  delete req.headers['x-api-key'];

  logDebug('Client authentication successful');
  next();
}

/**
 * 从 Authorization 头中提取 Bearer token
 * @param {string} authHeader - Authorization 头的值
 * @returns {string|null} - 提取出的 token，如果格式不对返回 null
 */
function extractBearerToken(authHeader) {
  if (!authHeader) return null;

  // Authorization: Bearer <token>
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * 管理后台认证中间件
 *
 * BaSui：管理后台要用更严格的密钥验证，别让憨批随便进来改密钥池！
 */
export function validateAdminAuth(req, res, next) {
  const adminKey = process.env.ADMIN_ACCESS_KEY;

  // 如果没配置管理密钥，拒绝访问
  if (!adminKey) {
    logError('管理员认证失败：未配置 ADMIN_ACCESS_KEY');
    return res.status(503).json({
      error: '服务不可用',
      message: '管理面板未配置。请设置 ADMIN_ACCESS_KEY 环境变量。'
    });
  }

  // 从请求头中提取管理密钥
  const clientAdminKey = req.headers['x-admin-key'];

  if (!clientAdminKey) {
    logError('管理员认证失败：未提供管理密钥');
    return res.status(401).json({
      error: '未授权',
      message: '需要管理密钥。请提供 x-admin-key 头。'
    });
  }

  // 验证管理密钥
  if (clientAdminKey !== adminKey) {
    logError('管理员认证失败：无效的管理密钥');
    return res.status(401).json({
      error: '未授权',
      message: '无效的管理密钥'
    });
  }

  logDebug('Admin authentication successful');
  next();
}
