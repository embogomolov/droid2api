import http from 'http';
import https from 'https';
import fetch from 'node-fetch';
import { setTimeout as wait } from 'node:timers/promises';
import { logWarn, logError } from '../logger.js';

/**
 * HTTP client connection pool manager 🚀
 *
 * Core performance optimizations:
 * - Reuse TCP connections with keep-alive to reduce handshake overhead
 * - Manage the connection pool to prevent connection leaks
 * - Handle timeouts automatically to prevent stalled connections
 */

// BaSui: Tune the HTTP connection pool for your actual concurrency.
const HTTP_AGENT_OPTIONS = {
  keepAlive: true,               // Enable keep-alive
  keepAliveMsecs: 1000,         // Keep-alive probe interval
  maxSockets: 100,              // Maximum concurrent connections per host, per process
  maxFreeSockets: 10,           // Idle connection pool size
  timeout: 60000,               // Socket timeout (60 seconds)
  freeSocketTimeout: 30000      // Idle connection timeout (release after 30 seconds)
};

// BaSui: Global connection pool instances (singletons)
const httpAgent = new http.Agent(HTTP_AGENT_OPTIONS);
const httpsAgent = new https.Agent(HTTP_AGENT_OPTIONS);

/**
 * Fetch wrapper with connection pooling
 * @param {string} url - Request URL
 * @param {object} options - Fetch options
 * @returns {Promise<Response>}
 */
// BaSui: Custom retry error so callers can detect exhausted fetch attempts.
export class FetchRetryError extends Error {
  constructor(url, attempts, lastError = null, lastStatus = null) {
    super(`Request failed after ${attempts} attempts: ${url}`);
    this.name = 'FetchRetryError';
    this.url = url;
    this.attempts = attempts;
    this.lastError = lastError;
    this.lastStatus = lastStatus;
  }
}

function defaultShouldRetry(response) {
  return response.status >= 500;
}

function shouldStopRetry(error, signal) {
  if (error?.name === 'AbortError') {
    return true;
  }
  if (signal?.aborted) {
    return true;
  }
  return false;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Only retry generation when transport evidence proves no model request was sent.
export async function retryUnsentRequest(send, { signal, onRetry = () => {}, retryDelay = 500 } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal?.throwIfAborted();
    try { return await send(); }
    catch (error) {
      const syscall = error.erroredSysCall || error.syscall;
      const beforeConnect = ['connect', 'getaddrinfo'].includes(syscall) &&
        ['ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(error.code);
      const beforeFrame = error.factoryRequestNotSent === true &&
        (['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(error.code) || error.message === 'Opening handshake has timed out');
      if (signal?.aborted || attempt === 3 || !(beforeConnect || beforeFrame)) throw error;
      onRetry({ attempt, code: error.code || 'handshake_timeout', reason: 'request_not_sent' });
      await wait(retryDelay * attempt, undefined, { signal });
    }
  }
}

export async function fetchWithPool(url, options = {}) {
  // BaSui: Select the agent based on the URL scheme.
  const agent = url.startsWith('https') ? httpsAgent : httpAgent;

  const {
    retry = true,
    maxRetries = 3,
    retryDelay = 500,
    shouldRetry = defaultShouldRetry,
    onRetry = null
  } = options;

  const fetchOptions = {
    ...options,
    agent
  };

  // These custom retry options must not be passed to fetch.
  delete fetchOptions.retry;
  delete fetchOptions.maxRetries;
  delete fetchOptions.retryDelay;
  delete fetchOptions.shouldRetry;
  delete fetchOptions.onRetry;

  const attempts = retry ? Math.max(1, maxRetries) : 1;
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, fetchOptions);

      if (!retry) {
        return response;
      }

      if (!shouldRetry(response, attempt) || attempt === attempts) {
        return response;
      }

      lastStatus = response.status;
      response.body?.destroy();

      if (attempt < attempts) {
        if (onRetry) {
          onRetry({ attempt, attempts, url, reason: `HTTP ${lastStatus}` });
        }
        logWarn(`[FetchRetry] Attempt ${attempt} failed (HTTP ${lastStatus}); retrying: ${url}`);
        await delay(retryDelay);
        continue;
      }

      break;
    } catch (error) {
      lastError = error;

      if (shouldStopRetry(error, fetchOptions.signal) || !retry) {
        throw error;
      }

      if (attempt < attempts) {
        if (onRetry) {
          onRetry({ attempt, attempts, url, reason: error.message });
        }
        logWarn(`[FetchRetry] Attempt ${attempt} failed (${error.message}); retrying: ${url}`);
        await delay(retryDelay);
        continue;
      }

      break;
    }
  }

  logError(`[FetchRetry] All ${attempts} attempts failed; giving up: ${url}`, lastError || new Error(`HTTP ${lastStatus}`));
  throw new FetchRetryError(url, attempts, lastError, lastStatus);
}

/**
 * Get connection pool statistics for monitoring.
 */
export function getPoolStats() {
  return {
    http: {
      sockets: Object.keys(httpAgent.sockets).length,
      freeSockets: Object.keys(httpAgent.freeSockets).length,
      requests: Object.keys(httpAgent.requests).length
    },
    https: {
      sockets: Object.keys(httpsAgent.sockets).length,
      freeSockets: Object.keys(httpsAgent.freeSockets).length,
      requests: Object.keys(httpsAgent.requests).length
    }
  };
}

/**
 * Shut down the connection pool gracefully on application exit.
 */
export function destroyPool() {
  httpAgent.destroy();
  httpsAgent.destroy();
}

export default fetchWithPool;
