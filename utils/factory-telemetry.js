import fetch from 'node-fetch';
import { setTimeout as delay } from 'node:timers/promises';
import { logWarn } from '../logger.js';

// GET only: retries here cannot generate another paid answer.
export async function fetchFactoryJSON(url, { headers, signal, timeout = 10000, fetchImpl = fetch, retryDelay = 500 } = {}) {
  const endpoint = new URL(url).pathname;
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const attemptSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let response, wait = retryDelay * attempt;
    try {
      response = await fetchImpl(url, { method: 'GET', headers, signal: attemptSignal, redirect: 'error' });
      if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
        const hint = response.headers.get('retry-after');
        if (hint !== null) {
          const seconds = Number(hint);
          const until = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(hint);
          if (Number.isFinite(until)) wait = Math.max(wait, until - Date.now());
        }
        // Do not block routing for a long Retry-After, or retry sooner than requested.
        if (wait <= 5000 && attempt < 3) {
          response.body?.destroy();
          logWarn(`Factory telemetry ${endpoint}: HTTP ${response.status}; retry ${attempt}/2 in ${wait}ms`);
          clearTimeout(timer);
          await delay(wait, undefined, { signal });
          continue;
        }
        response.body?.destroy();
        return { response, data: { message: `HTTP ${response.status}` } };
      }
      const data = await response.json(); // Timeout also covers a stalled response body.
      return { response, data };
    } catch (error) {
      response?.body?.destroy();
      if (signal?.aborted) throw signal.reason;
      const timedOut = controller.signal.aborted;
      const transient = timedOut || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code);
      const reason = timedOut ? `timeout after ${timeout}ms` : error.code || error.name;
      if (!transient || attempt === 3) throw new Error(`Factory telemetry ${endpoint}: ${reason} (attempt ${attempt}/3)`, { cause: error });
      logWarn(`Factory telemetry ${endpoint}: ${reason}; retry ${attempt}/2 in ${wait}ms`);
    } finally { clearTimeout(timer); }
    await delay(wait, undefined, { signal });
  }
}

export function preserveUsageOnFailure(previous, error, now = new Date().toISOString()) {
  return { ...(previous || { success: false }), stale: true, last_error: error, last_attempt: now };
}
