import { logInfo, logError, logDebug } from '../logger.js';

/**
 * Client authentication middleware
 *
 * BaSui: Validate client access permissions to prevent unauthorized use of the proxy!
 *
 * Supports three authentication modes (in priority order):
 * 1. FACTORY_API_KEY - Fixed API key (highest priority; skips client authentication)
 * 2. API_ACCESS_KEY - Server-configured client access key
 * 3. No-authentication mode: allow all requests when no keys are configured (development mode)
 */
export function validateClientAuth(req, res, next) {
  // BaSui: FACTORY_API_KEY indicates single-user mode; skip client authentication
  const factoryKey = process.env.FACTORY_API_KEY;
  if (factoryKey) {
    logDebug('FACTORY_API_KEY configured, skipping client auth');
    // Remove the client authorization header to prevent accidental forwarding
    delete req.headers.authorization;
    return next();
  }

  // BaSui: Check whether API_ACCESS_KEY (the client access key) is configured
  const apiAccessKey = process.env.API_ACCESS_KEY;

  // If API_ACCESS_KEY is absent, enter development mode and allow all requests
  if (!apiAccessKey) {
    logDebug('No API_ACCESS_KEY configured, allowing all requests (dev mode)');
    // Remove the client authorization header to prevent accidental forwarding
    delete req.headers.authorization;
    return next();
  }

  // BaSui: Extract the client-supplied key from request headers
  // Supports two formats:
  // 1. x-api-key: your_access_key
  // 2. authorization: Bearer your_access_key
  const clientKey = req.headers['x-api-key'] || extractBearerToken(req.headers.authorization);

  if (!clientKey) {
    logError('Client authentication failed: no API key provided');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API key required. Provide an x-api-key header or Authorization: Bearer <key>'
    });
  }

  // BaSui: Check whether the client key matches
  if (clientKey !== apiAccessKey) {
    logError('Client authentication failed: invalid API key');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key'
    });
  }

  // Authentication succeeded; remove the original authorization header to avoid forwarding it upstream
  delete req.headers.authorization;
  delete req.headers['x-api-key'];

  logDebug('Client authentication successful');
  next();
}

/**
 * Extract a Bearer token from the Authorization header
 * @param {string} authHeader - Authorization header value
 * @returns {string|null} - Extracted token, or null if the format is invalid
 */
function extractBearerToken(authHeader) {
  if (!authHeader) return null;

  // Authorization: Bearer <token>
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Admin authentication middleware
 *
 * BaSui: Use stricter authentication for the admin panel to prevent unauthorized changes to the key pool!
 */
export function validateAdminAuth(req, res, next) {
  const adminKey = process.env.ADMIN_ACCESS_KEY;

  // Deny access if the admin key is not configured
  if (!adminKey) {
    logError('Admin authentication failed: missing ADMIN_ACCESS_KEY');
    return res.status(503).json({
      error: 'Service unavailable',
      message: 'Admin panel is not configured. Set the ADMIN_ACCESS_KEY environment variable.'
    });
  }

  // Extract the admin key from request headers
  const clientAdminKey = req.headers['x-admin-key'];

  if (!clientAdminKey) {
    logError('Admin authentication failed: no admin key provided');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Admin key required. Provide the x-admin-key header.'
    });
  }

  // Validate the admin key
  if (clientAdminKey !== adminKey) {
    logError('Admin authentication failed: invalid admin key');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid admin key'
    });
  }

  logDebug('Admin authentication successful');
  next();
}
