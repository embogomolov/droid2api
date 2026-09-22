import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Response } from 'node-fetch';
import { prepareFactoryRequest } from './factory-images.js';
import { digest, canonical, inputItems, itemHashes, outputHashes, outputVariants, itemFingerprint, fingerprintChanges, resetConnection } from './factory-sessions.js';

export function factoryWebSocketUrl(address) {
  const url = new URL(address);
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return url.href;
  if (!['app.factory.ai', 'api.factory.ai', 'api.eu.factory.ai'].includes(url.hostname) ||
      url.pathname !== '/api/llm/o/v1/responses') return null;
  if (url.hostname === 'app.factory.ai') url.hostname = 'api.factory.ai';
  url.protocol = 'wss:';
  url.pathname += '/ws';
  return url.href;
}

// A caller holding the task lock can reuse its socket. Stateless callers remain isolated.
export function fetchFactoryWebSocket(address, { headers, body, signal, handshakeTimeout = 15_000, session, onUsage = () => {}, beforeSend = () => {} }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('Request aborted')); return; }
    const wsHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) =>
      !name.toLowerCase().startsWith('x-stainless-') && !['content-length', 'content-type', 'connection', 'upgrade', 'accept-encoding', 'x-assistant-message-id'].includes(name.toLowerCase())));
    const version = Object.entries(headers).find(([name]) => name.toLowerCase() === 'user-agent')?.[1]?.match(/factory-cli\/([^\s]+)/)?.[1];
    if (version) wsHeaders['X-Client-Version'] = version;
    const assistantId = Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-assistant-message-id')?.[1] || randomUUID();
    let prepared;
    try { prepared = prepareFactoryRequest(body, headers['x-session-id']); }
    catch (error) { resolve(new Response(JSON.stringify({ error: { type: 'image_preparation_error', message: error.message } }), { status: 422, headers: { 'content-type': 'application/json' } })); return; }
    const { stream, ...original } = prepared.body;
    const connectionKey = digest([address, original.model, wsHeaders.authorization, wsHeaders['user-agent']]);
    const connectionReason = !session ? 'no_task_identity' : !session.connectionKey ? 'new_session' :
      session.connectionKey !== connectionKey ? 'connection_settings_changed' :
      session.socket?.readyState !== WebSocket.OPEN ? 'connection_closed' : null;
    if (session && (session.connectionKey !== connectionKey || session.socket?.readyState !== WebSocket.OPEN)) resetConnection(session);
    if (session) clearTimeout(session.idleTimer);
    const hashes = session ? itemHashes(original.input) : null;
    const { input: _input, previous_response_id: _previous, ...settings } = original;
    const settingsFields = session ? Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, digest(canonical(value))])) : {};
    const prefix = session?.context;
    const mismatchIndex = hashes && prefix ? prefix.findIndex((hash, i) => Array.isArray(hash) ? !hash.includes(hashes[i]) : hash !== hashes[i]) : -1;
    const delta = !original.previous_response_id && session?.socket && session.responseId && hashes && prefix &&
      hashes.length >= prefix.length && prefix.every((hash, i) => Array.isArray(hash) ? hash.includes(hashes[i]) : hash === hashes[i]);
    const reuseReason = delta ? 'matched_prefix' : original.previous_response_id ? 'explicit_previous' : connectionReason ||
      (mismatchIndex >= 0 ? 'history_changed' : 'missing_context');
    const changedSettings = session?.settingsFields ? [...new Set([...Object.keys(session.settingsFields), ...Object.keys(settingsFields)])]
      .filter(key => session.settingsFields?.[key] !== settingsFields[key]) : [];
    let historyMismatch = null;
    if (reuseReason === 'history_changed') {
      const outputIndex = mismatchIndex - (session.outputContext?.start ?? Infinity);
      const expected = session.outputContext?.items[outputIndex];
      const actual = itemFingerprint(inputItems(original.input)[mismatchIndex]);
      historyMismatch = { region: outputIndex >= 0 ? 'previous_output' : 'previous_input', outputIndex: outputIndex >= 0 ? outputIndex : null,
        ...(expected ? { candidates: expected.map(candidate => ({ source: candidate.source, differences: fingerprintChanges(candidate.fields, actual) })) } : { detail: 'field_fingerprints_not_retained' }) };
    }
    const request = delta ? { ...original, input: inputItems(original.input).slice(prefix.length), previous_response_id: session.responseId } : original;
    // A changed/edited full history starts a new upstream context.
    if (session?.socket && !delta && !original.previous_response_id) resetConnection(session);
    const fullRequest = { ...request, type: 'response.create',
      _factory: { ...request._factory, assistantMessageId: assistantId } };
    let lastEventType = null, frame, frameRecorded = true, frameSent = false;
    const doneItems = new Map();
    const doneHashes = new Map(); // Routing covers every output, independently of diagnostic caps.
    let doneCount = 0;
    const record = (response, success = false) => {
      if (frameRecorded) return;
      frameRecorded = true;
      onUsage({ usage: response?.usage || null, responseId: response?.id || null, success,
        phase: request.generate === false ? 'warmup' : 'generation',
        contextMode: delta ? 'delta' : request.previous_response_id ? 'explicit_previous' : 'full',
        frameBytes: Buffer.byteLength(frame || ''), batch: 1, images: prepared.images,
        reuseReason, changedSettings, mismatchIndex: reuseReason === 'history_changed' ? mismatchIndex : null,
        inputItems: hashes?.length ?? null, prefixItems: prefix?.length ?? null, historyMismatch,
        outputItemDoneCount: doneCount,
        streamOutputDifferences: (response?.output || []).flatMap((item, index) => {
          const done = doneItems.get(index);
          const differences = done ? fingerprintChanges(done.raw, itemFingerprint(item)) : [];
          return differences.length ? [{ index, differences }] : [];
        }).slice(0, 4) });
    };
    const sendRequest = () => {
      frame = JSON.stringify(fullRequest);
      try { beforeSend(); } catch(error) { fail(error);return; }
      frameRecorded = false; accepted = false;
      frameSent = true; // Even a failed send callback does not prove non-delivery.
      socket.send(frame, error => { if (error) fail(error); });
    };
    const reused = session?.socket;
    const socket = reused || new WebSocket(address, { headers: wsHeaders, handshakeTimeout,
      followRedirects: false, maxPayload: 0, closeTimeout: 2000 });
    if (session) { session.socket = socket; session.connectionKey = connectionKey; }
    let settled = false, accepted = false, terminal = false, finished = false;
    const output = new Readable({
      read() { if (socket.readyState === WebSocket.OPEN) socket.resume(); },
      destroy(error, callback) { if (!finished) fail(error || new Error('Response consumer disconnected')); callback(error); }
    });
    // The consumer attaches after the first event; avoid unhandled early stream errors.
    output.on('error', () => {});
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      socket.off('message', onMessage); socket.off('close', onClose); socket.off('error', fail);
      socket.off('open', onOpen); socket.off('unexpected-response', onUnexpected);
    };
    // Keep an error handler even between turns (terminate can emit asynchronously).
    if (!reused) socket.on('error', () => {});
    const close = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      } else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    };
    const fail = error => {
      if (finished) return;
      error.factoryRequestNotSent = !frameSent;
      record(null);
      finished = true; cleanup();
      if (!settled) { settled = true; reject(error); }
      else output.destroy(error);
      socket.terminate();
      if (session?.socket === socket) resetConnection(session);
    };
    const abort = () => fail(signal.reason || new Error('Request aborted'));
    const finish = (response) => {
      finished = true; cleanup(); output.push(null);
      if (session && ['completed', 'incomplete'].includes(response?.status) && response.id && Array.isArray(response.output) && hashes && !original.previous_response_id) {
        // Streaming Codex records output_item.done, not completed.output. Factory
        // can supply different reasoning ciphertext in these two events.
        session.context = [...hashes, ...response.output.map((item, index) =>
          stream === true && doneHashes.has(index) ? doneHashes.get(index) : outputHashes([item])[0])];
        session.outputContext = { start: hashes.length, items: outputVariants(response.output.slice(0, 128)).map((variants, index) => [
          ...variants.map((item, i) => ({ source: i ? 'completed_codex' : 'completed_raw', fields: itemFingerprint(item) })),
          ...(doneItems.has(index) ? [
            { source: 'output_item_done_raw', fields: doneItems.get(index).raw },
            { source: 'output_item_done_codex', fields: doneItems.get(index).codex }
          ] : [])
        ]) };
        session.responseId = response.id; session.settingsFields = settingsFields;
        socket.resume();
        // Native Droid releases an idle socket after 30 seconds. Reconnection
        // sends one prepared request, never a chain of paid warm-up requests.
        session.idleTimer = setTimeout(() => resetConnection(session), 30_000);
        session.idleTimer.unref();
      } else {
        close();
        if (session?.socket === socket) { session.socket = null; session.context = null; session.outputContext = null; session.responseId = null; }
      }
    };
    const reply = response => { settled = true; resolve(response); };
    const errorResponse = event => {
      const explicit = event.status ?? event.error?.status ?? event.response?.error?.status;
      const status = Number.isInteger(explicit) && explicit >= 400 && explicit <= 599 ? explicit : 502;
      const errorHeaders = { 'content-type': 'application/json' };
      const retryAfter = Object.entries(event.headers || {}).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
      if (retryAfter !== undefined && !/[\r\n]/.test(String(retryAfter))) errorHeaders['retry-after'] = String(retryAfter);
      const response = new Response(JSON.stringify(event), { status, headers: errorHeaders });
      response.factoryRequestAccepted = accepted || event.type === 'response.failed' || explicit === undefined;
      return response;
    };
    signal?.addEventListener('abort', abort, { once: true });
    const onOpen = () => {
      if (signal?.aborted) { abort(); return; }
      sendRequest();
    };
    const onUnexpected = (_request, response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', fail);
      response.on('end', () => {
        if (finished) return;
        const rejectedHandshake = new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers });
        rejectedHandshake.factoryRequestNotSent = true;
        reply(rejectedHandshake);
        finish();
      });
    };
    const onMessage = (data, binary) => {
      if (finished || terminal) return;
      let event;
      try {
        if (binary) throw new Error('Unexpected binary Factory event');
        event = JSON.parse(data.toString('utf8'));
        if (!event || typeof event.type !== 'string' || /[\r\n]/.test(event.type)) throw new Error('Invalid Factory event');
      } catch (error) { fail(error); return; }
      lastEventType = event.type;
      if (event.type === 'response.output_item.done' && event.item && typeof event.item === 'object') {
        const index = Number.isInteger(event.output_index) && event.output_index >= 0 ? event.output_index : doneCount;
        const variants = outputVariants([event.item])[0];
        doneHashes.set(index, variants.map(item => digest(canonical(item))));
        if (doneItems.size < 128) {
          doneItems.set(index, { raw: itemFingerprint(variants[0]), codex: itemFingerprint(variants.at(-1)) });
        }
        doneCount++;
      }
      if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event.type)) record(event.response, event.type === 'response.completed');
      if (delta && !settled && !accepted && event.type === 'error' && event.error?.code === 'previous_response_not_found') {
        // Recover only an explicit rejection of our own chain ID, once, using
        // full client history. Ambiguous disconnects are never replayed.
        finish(); resetConnection(session);
        fetchFactoryWebSocket(address, { headers, body, signal, handshakeTimeout, session, onUsage, beforeSend }).then(resolve, reject);
        return;
      }
      terminal = ['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event.type);
      const failed = event.type === 'error' || event.type === 'response.failed';
      if (failed && !settled) {
        reply(errorResponse(event)); finish(); return;
      }
      if (event.type.startsWith('response.')) accepted = true;
      if (stream === true) {
        if (!settled) reply(new Response(output, { headers: { 'content-type': 'text/event-stream' } }));
        if (!output.push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) socket.pause();
      } else if (terminal) {
        if (!event.response || typeof event.response !== 'object') { fail(new Error('Factory terminal event has no response')); return; }
        reply(new Response(JSON.stringify(event.response), { headers: { 'content-type': 'application/json' } }));
      }
      if (terminal) finish(failed ? null : event.response);
    };
    socket.on('error', fail);
    const onClose = (code, reason) => {
      if (!finished) {
        const error = new Error(`Factory WebSocket closed (code ${code}) before completion; frame_bytes=${Buffer.byteLength(frame || '')}, last_event=${lastEventType || 'none'}`);
        error.code = 'FACTORY_WS_CLOSED'; error.closeCode = code;
        fail(error);
      }
    };
    socket.on('message', onMessage); socket.on('close', onClose);
    socket.on('open', onOpen); socket.on('unexpected-response', onUnexpected);
    if (reused) onOpen();
  });
}
