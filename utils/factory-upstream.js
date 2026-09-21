import { factoryWebSocketUrl, fetchFactoryWebSocket } from './factory-websocket.js';
import { getFactorySession, lockSession } from './factory-sessions.js';
import { recordRequest } from './request-stats.js';
import { prepareFactoryRequest, prepareAnthropicImages } from './factory-images.js';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Response } from 'node-fetch';
import keyPoolManager from '../auth.js';
import fetchWithPool, { retryUnsentRequest } from './http-client.js';
import { logRequest, logError, logInfo, logWarn } from '../logger.js';
import { quotaProfile } from './quota-aware.js';

// Keep every original SSE byte. An EOF without a terminal event is a failure,
// never a completed answer and never a reason to replay an already-started turn.
export async function* checkedSSE(body, outcome = {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', data = [], terminal = false, messageStopped = false;
  const checkEvent = () => {
    if (!data.length) return;
    const text = data.join('\n');
    data = [];
    if (text === '[DONE]') { terminal = true; return; }
    let event;
    try { event = JSON.parse(text); } catch { return; }
    outcome.onEvent?.(event);
    if (['response.completed', 'response.done', 'response.incomplete', 'response.failed', 'message_stop', 'error'].includes(event.type)) terminal = true;
    if (event.type === 'response.failed' || event.type === 'error' || event.error) outcome.failed = true;
    if (event.type === 'message_stop' || event.type === 'error') messageStopped = true;
    if (terminal) outcome.onTerminal?.(event.response, !outcome.failed);
  };
  try {
    for await (const chunk of body) {
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) checkEvent();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      yield chunk;
      if (messageStopped) return;
    }
    if (!terminal) throw new Error('Upstream stream ended before a terminal event');
  } finally {
    body.destroy();
  }
}

// Only bounded error metadata belongs in diagnostics, never the response or request payload.
export function upstreamEventError(event) {
  const source = event.response?.error ?? event.error ?? event;
  const text = value => typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/fk-[\w-]+/g, '[key hidden]').replace(/Bearer\s+[^\s"'\\]+/gi, 'Bearer [hidden]').slice(0, 2000) : null;
  return { eventType: text(event.type), code: text(source?.code ?? (source === event ? null : source?.type) ?? source?.status),
    type: text(source === event ? null : source?.type), message: text(typeof source === 'string' ? source : source?.message ?? source?.detail) };
}

export async function requestWithFailover(req, res, makeRequest, manager = keyPoolManager) {
  const requestId = randomUUID(), started = Date.now();
  res.setHeader('x-proxy-request-id', requestId);
  (res.locals ||= {}).factoryRequest = { model: req.body.model };
  logInfo(`Factory request ${requestId}: received`, { model: req.body.model, streaming: req.body.stream === true });
  let phase = 'account_selection', failureReason, diagnosticWritten = false;
  const diagnose = (reason, error) => {
    if (diagnosticWritten) return;
    diagnosticWritten = true;
    res.locals.factoryRequest.error = reason;
    const details = error ? (error.eventType ? error : upstreamEventError({ type: reason, error })) : null;
    if (details) res.locals.factoryRequest.upstreamError = details;
    logWarn(`Factory request ${requestId}: ${reason}`, {
      requestId, phase, elapsedMs: Date.now() - started, code: error?.code || null,
      closeCode: error?.closeCode || null,
      ...(details ? { upstreamError: details } : {})
    });
  };
  const controller = new AbortController();
  const abort = reason => {
    if (controller.signal.aborted) return;
    failureReason = reason;
    diagnose(reason);
    controller.abort(new Error(reason));
  };
  const clientClosed = () => { if (!res.writableFinished) abort('client_disconnected'); };
  req.once('aborted', clientClosed);
  res.once('close', clientClosed);
  let timer, release = () => {}, session, quotaReservation;
  const cleanup = () => {
    clearTimeout(timer); release();
    if (res.writableFinished && res.statusCode < 400 && !res.locals.factoryRequest.error && res.locals.factoryRequest.success !== false) quotaReservation?.complete();
    quotaReservation?.release(); req.off('aborted', clientClosed); res.off('close', clientClosed);
  };
  res.once('finish', cleanup);
  res.once('close', cleanup);
  try {
    session = getFactorySession(req);
    release = await lockSession(session, controller.signal);
    if (res.destroyed || controller.signal.aborted) { cleanup(); return null; }
  } catch (error) {
    cleanup();
    if (!res.destroyed) res.status(error?.status || 503).json({ error: { type: 'session_unavailable', message: error?.message || 'Request aborted' } });
    return null;
  }
  const attempted = new Set();
  let lastResponse;
  const sendError = async response => {
    if (res.destroyed) return null;
    const body = await response.text();
    let error; try { error = JSON.parse(body); } catch { error = { message: body }; }
    diagnose(`upstream_http_${response.status}`, upstreamEventError({ type: 'http_error', error: error?.error ?? error }));
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) res.setHeader('Retry-After', retryAfter);
    res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(body);
    return null;
  };
  const suppliedAuth = req.headers.authorization;
  const fixedAuth = process.env.FACTORY_API_KEY ? `Bearer ${process.env.FACTORY_API_KEY.trim()}` : suppliedAuth;
  const count = fixedAuth ? 1 : manager.keys.length;
  const quotaWorkload = !fixedAuth && manager.config?.algorithm === 'quota-aware' ? quotaProfile(req.body.model, req.body) : 'unclassified';
  for (let attempt = 0; attempt < count; attempt++) {
    quotaReservation?.release(); quotaReservation = null;
    if (controller.signal.aborted) return null;
    let key;
    try {
      key = fixedAuth ? null : await manager.getNextKey({ excluded: attempted, model: req.body.model, signal: controller.signal, reserveQuota: true, quotaWorkload });
      quotaReservation = key?.quotaReservation;
      if (controller.signal.aborted || res.destroyed) { quotaReservation?.release(); return null; }
    } catch (error) {
      if (controller.signal.aborted) return null;
      if (lastResponse) return sendError(lastResponse);
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      res.status(error.status || 503).json({ error: { type: 'account_unavailable', message: error.message } });
      return null;
    }
    const keyId = key?.keyId || null;
    res.locals.factoryRequest.keyId = keyId;
    if (keyId) attempted.add(keyId);
    if (manager.keys.some(item => item.excluded && (item.id === keyId || fixedAuth === `Bearer ${item.key}`))) {
      if (!fixedAuth) continue;
      res.status(403).json({ error: { type: 'key_excluded', message: 'This Factory key is excluded from the pool' } });
      return null;
    }
    const selectedAccount = manager.keys.find(item => item.id === keyId || fixedAuth === `Bearer ${item.key}`);
    const hold = selectedAccount && manager.windowSync?.routingBlock(selectedAccount, req.body.model);
    if (hold) { if (!fixedAuth) continue; res.setHeader('Retry-After', '5'); res.status(503).json({ error: { type: 'window_sync_wait', message: hold } }); return null; }
    const { url, headers, body } = makeRequest(fixedAuth || `Bearer ${key.key}`);
    if (session) headers['x-session-id'] = session.identity;
    logRequest('POST', url, headers, body);
    // Header timeout and later stream idle timeout; client disconnect cancels upstream.
    clearTimeout(timer);
    const anthropic = headers['x-api-provider'] === 'anthropic';
    const counting = new URL(url).pathname.endsWith('/count_tokens');
    if (counting) quotaReservation?.release(true); // Token counting is not generation work.
    const idleTimeout = anthropic ? 240_000 : 120_000; // Native Droid Anthropic stream idle timeout.
    phase = 'waiting_for_response';
    timer = setTimeout(() => abort('upstream_response_timeout'), anthropic ? 600_000 : 120_000);
    let response, usageRecorded = false, usingWebSocket = false, observeHTTP, observeEvent;
    const accountUsage = report => {
      const usage = report.usage;
      const cacheReadTokens = anthropic ? usage?.cache_read_input_tokens ?? 0 : usage?.input_tokens_details?.cached_tokens ?? 0;
      const cacheCreationTokens = anthropic ? usage?.cache_creation_input_tokens ?? 0 : usage?.input_tokens_details?.cache_write_tokens ?? 0;
      const inputTokens = (usage?.input_tokens ?? 0) + (anthropic ? cacheReadTokens + cacheCreationTokens : 0);
      const accounting = { ...report, keyId, task: session?.id || null, model: body.model };
      Object.assign(res.locals.factoryRequest, { model: body.model, success: report.success,
        usage: usage ? { input: Number.isFinite(usage.input_tokens) ? inputTokens : null, output: usage.output_tokens ?? null,
          cacheRead: (anthropic ? usage.cache_read_input_tokens : usage.input_tokens_details?.cached_tokens) ?? null,
          cacheWrite: (anthropic ? usage.cache_creation_input_tokens : usage.input_tokens_details?.cache_write_tokens) ?? null } : null });
      logInfo('Factory transport usage', accounting);
      recordRequest({ inputTokens, outputTokens: usage?.output_tokens ?? 0, cacheReadTokens,
        cacheCreationTokens,
        model: body.model, success: report.success, factoryTransport: accounting });
    };
    try {
      const websocketUrl = factoryWebSocketUrl(url);
      usingWebSocket = Boolean(websocketUrl && body.background !== true && !session?.wsDisabled);
      usageRecorded = Boolean(websocketUrl && body.background !== true);
      let httpBody = body, httpUrl = url;
      if (anthropic) {
        let prepared;
        try { prepared = prepareAnthropicImages(body); }
        catch (error) { res.status(422).json({ error: { type: 'image_preparation_error', message: error.message } }); return null; }
        httpBody = prepared.body;
        usageRecorded = !counting;
        let recorded = false, result;
        observeHTTP = (message, success = false) => {
          if (recorded || !usageRecorded) return;
          recorded = true;
          accountUsage({ usage: message?.usage ?? result?.usage ?? null, responseId: message?.id ?? result?.id ?? null,
            success, phase: 'generation', contextMode: 'full', frameBytes: Buffer.byteLength(JSON.stringify(httpBody)),
            batch: 1, images: prepared.images, protocol: 'anthropic' });
        };
        observeEvent = event => {
          if (event.type === 'message_start') result = event.message;
          if (event.type === 'message_delta' && result && event.usage) result = { ...result, usage: { ...result.usage, ...event.usage } };
        };
      }
      if (websocketUrl && !usingWebSocket) {
        let prepared;
        try { prepared = prepareFactoryRequest(body, headers['x-session-id']); }
        catch (error) { res.status(422).json({ error: { type: 'image_preparation_error', message: error.message } }); return null; }
        httpBody = prepared.body;
        const target = new URL(websocketUrl); target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
        target.pathname = target.pathname.replace(/\/ws$/, ''); httpUrl = target.href;
        let recorded = false;
        observeHTTP = (result, success = false) => {
          if (recorded || !usageRecorded) return;
          recorded = true;
          accountUsage({ usage: result?.usage || null, responseId: result?.id || null, success,
            phase: 'generation', contextMode: 'full', frameBytes: Buffer.byteLength(JSON.stringify(httpBody)), batch: 1,
            images: prepared.images, reuseReason: 'native_http_fallback' });
        };
      }
      response = await retryUnsentRequest(() => {
        if (selectedAccount && (selectedAccount.excluded || manager.windowSync?.routingBlock(selectedAccount, req.body.model))) throw new Error('Account held before dispatch');
        quotaReservation?.sent();
        return usingWebSocket
        ? fetchFactoryWebSocket(websocketUrl, { headers, body, signal: controller.signal, session,
          onUsage: accountUsage })
        : fetchWithPool(httpUrl, {
          method: 'POST', headers, body: JSON.stringify(httpBody), retry: false,
          signal: controller.signal, redirect: 'error'
        }); }, { signal: controller.signal, onRetry: details => logWarn(`Factory request ${requestId}: retry before send`, details) });
    } catch (error) {
      clearTimeout(timer);
      if (error.factoryRequestNotSent === true || ['connect', 'getaddrinfo'].includes(error.erroredSysCall || error.syscall)) quotaReservation?.release(true);
      observeHTTP?.(null);
      if (session && usingWebSocket && !controller.signal.aborted) {
        session.wsFailures = (session.wsFailures || 0) + 1;
        session.wsDisabled = session.wsFailures >= 2;
      }
      if (res.destroyed || req.aborted) return null;
      diagnose(failureReason || 'upstream_connection_failed', error);
      // A network failure can occur after the upstream accepted the request.
      // Do not replay ambiguous requests; let the client decide what to do.
      res.status(controller.signal.aborted ? 504 : 502).json({ error: {
        type: 'upstream_connection_error', message: 'Factory connection failed before a response was received; request was not replayed',
        detail: failureReason || 'upstream_connection_failed', code: error.code || null, request_id: requestId
      } });
      return null;
    }
    clearTimeout(timer);
    phase = 'response_body';
    timer = setTimeout(() => abort('upstream_body_timeout'), idleTimeout);
    if (response.ok && req.body.stream !== true) {
      const original = response;
      response = new Response(Readable.from((async function* () {
        try { yield* original.body; }
        catch (error) { diagnose(failureReason || 'upstream_body_interrupted', error); throw error; }
      })()), { status: original.status, headers: original.headers });
    }
    if (response.ok) {
      for (const [name, value] of response.headers) {
        if (/^(anthropic-|request-id$|x-request-id$|retry-after$)/i.test(name)) res.setHeader(name, value);
      }
      const outcome = { onTerminal: observeHTTP, onEvent: event => {
        observeEvent?.(event);
        if (event.type === 'error' || event.type === 'response.failed') {
          const error = upstreamEventError(event);
          res.locals.factoryRequest.upstreamError = error;
          diagnose('upstream_error_event', error);
        }
      } };
      if (req.body.stream === true) {
        const original = response;
        const monitored = async function* () {
          phase = 'streaming';
          clearTimeout(timer);
          timer = setTimeout(() => abort('upstream_stream_idle_timeout'), idleTimeout);
          try {
            for await (const chunk of checkedSSE(original.body, outcome)) {
              clearTimeout(timer);
              timer = setTimeout(() => abort('upstream_stream_idle_timeout'), idleTimeout);
              yield chunk;
            }
          } catch (error) {
            diagnose(failureReason || 'upstream_stream_interrupted', error);
            if (session && usingWebSocket && !controller.signal.aborted) {
              session.wsFailures = (session.wsFailures || 0) + 1;
              session.wsDisabled = session.wsFailures >= 2;
            }
            throw error;
          } finally { clearTimeout(timer); observeHTTP?.(null); }
        };
        response = new Response(Readable.from(monitored()), { status: response.status, headers: response.headers });
      } else if (observeHTTP && usageRecorded) {
        const result = await response.json();
        if (result.error || result.status === 'failed') diagnose('upstream_error_event', upstreamEventError({ type: result.status === 'failed' ? 'response.failed' : 'error', response: result }));
        observeHTTP(result, !result.error && result.status !== 'failed');
        response = new Response(JSON.stringify(result), { status: response.status, headers: response.headers });
      }
      return { response, currentKeyId: keyId, outcome, usageRecorded };
    }
    observeHTTP?.(null);
    if ([401, 402, 403, 429].includes(response.status) || response.factoryRequestNotSent) quotaReservation?.release(true);
    const retryable = [401, 402, 429].includes(response.status) || (response.factoryRequestNotSent && response.status >= 500);
    if (!retryable || fixedAuth || response.factoryRequestAccepted) return sendError(response);
    await manager.recordUpstreamFailure(keyId, response.status, response.headers.get('retry-after'), req.body.model);
    // Consume each rejection before releasing the connection and changing accounts.
    lastResponse = new Response(await response.text(), { status: response.status, headers: response.headers });
  }
  if (lastResponse) return sendError(lastResponse);
  if (!res.destroyed) res.status(503).json({ error: { type: 'account_unavailable', message: 'No keys configured' } });
  return null;
}
