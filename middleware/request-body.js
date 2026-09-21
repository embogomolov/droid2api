import express from 'express';
import { logWarning } from '../logger.js';

const limitMiB = Number(process.env.REQUEST_BODY_LIMIT_MB ?? 256);
if (!Number.isSafeInteger(limitMiB) || limitMiB <= 0 || !Number.isSafeInteger(limitMiB * 1024 * 1024)) {
  throw new Error('REQUEST_BODY_LIMIT_MB must be a positive integer in MiB');
}
export const requestBodyLimit = limitMiB * 1024 * 1024;

// Registered after request logging, so parser failures also produce a request event.
export const requestBodyMiddleware = [
  express.json({ limit: requestBodyLimit }),
  express.urlencoded({ extended: true, limit: requestBodyLimit }),
  (error, req, res, next) => {
    if (res.headersSent || !error.type || !Number.isInteger(error.status) || error.status < 400 || error.status >= 500) return next(error);
    const message = error.type === 'entity.too.large'
      ? `Request body exceeds the ${limitMiB} MiB limit${Number.isFinite(error.length) ? ` (${error.length} bytes received)` : ''}. Increase REQUEST_BODY_LIMIT_MB and restart the proxy if needed.`
      : error.type === 'entity.parse.failed' ? 'Request body contains invalid JSON.'
        : `Invalid request body (${error.type}).`;
    res.locals.factoryRequest = { success: false, error: message };
    // Parser errors can contain the entire private body; never log the error object.
    logWarning(`HTTP ${error.status}: ${message}`);
    res.status(error.status).json({ error: { type: 'invalid_request_error', code: error.type, message } });
  }
];
