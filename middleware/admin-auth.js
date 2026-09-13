/**
 * Admin authentication middleware
 * Shared admin authentication logic
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
 * Admin authentication middleware
 * @param {Request} req - Request object
 * @param {Response} res - Response object
 * @param {Function} next - Next middleware
 */
export function adminAuth(req, res, next) {
  const headerKey = normalizeKey(req.headers['x-admin-key']);
  const bearerKey = extractBearerToken(req.headers.authorization);
  const queryKey = normalizeKey(req.query.admin_key || req.query.adminKey);
  const adminKey = headerKey || bearerKey || queryKey;
  const configuredKey = process.env.ADMIN_ACCESS_KEY;

  // BaSui: Check whether the admin key is configured
  if (!configuredKey) {
    logError('Admin access failed: ADMIN_ACCESS_KEY environment variable is not configured');
    return res.status(500).json({
      error: 'Admin access is not configured correctly',
      message: 'Set the ADMIN_ACCESS_KEY environment variable'
    });
  }

  // BaSui: Validate the admin key
  if (!adminKey) {
    logWarn(`Admin access failed: authentication key missing [IP: ${req.ip}]`);
    return res.status(401).json({
      error: 'Admin authentication required',
      message: 'Provide the x-admin-key header, an Authorization: Bearer token, or the admin_key parameter'
    });
  }

  if (adminKey !== configuredKey) {
    logWarn(`Admin access failed: incorrect key [IP: ${req.ip}, Key: ${adminKey.substring(0, 4)}...]`);
    return res.status(403).json({
      error: 'Authentication failed',
      message: 'Invalid admin key'
    });
  }

  // BaSui: Log successful admin access
  logInfo(`Admin access successful [IP: ${req.ip}, Path: ${req.path}]`);
  next();
}

export default adminAuth;
