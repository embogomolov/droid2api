import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sessions = new Map();
const MAX_SESSIONS = 128;
export const RETENTION_MS = 30 * 60_000;

// Only client-provided conversation identity, never the random upstream header.
export function getFactorySession(req) {
  const identity = req.headers['thread-id'] || req.headers['session-id'] || req.headers['x-session-id'] || req.headers['x-claude-code-session-id'];
  if (typeof identity !== 'string' || !identity || identity.length > 1024) return null;
  // Claude subagents share a conversation header but have independent turns.
  const agent = req.headers['x-claude-code-agent-id'];
  if (agent !== undefined && (typeof agent !== 'string' || agent.length > 1024)) return null;
  const id = digest([identity, req.body.model, req.headers.authorization || '', process.env.FACTORY_API_KEY || '', ...(agent ? [agent] : [])]);
  for (const [key, session] of sessions) {
    if (!session.users && Date.now() - session.touched > RETENTION_MS) {
      resetConnection(session); sessions.delete(key);
    }
  }
  let session = sessions.get(id);
  if (!session) {
    if (sessions.size >= MAX_SESSIONS) {
      const victim = [...sessions.values()].filter(s => !s.users).sort((a, b) => a.touched - b.touched)[0];
      if (!victim) throw Object.assign(new Error('All Factory session slots are busy'), { status: 503 });
      resetConnection(victim); sessions.delete(victim.id);
    }
    session = { id, identity, touched: Date.now(), users: 0, tail: Promise.resolve() };
    sessions.set(id, session);
  }
  session.touched = Date.now();
  return session;
}

export async function lockSession(session, signal) {
  if (!session) return () => {};
  if (signal.aborted) throw signal.reason;
  if (session.users >= 16) throw Object.assign(new Error('Too many queued requests for this task'), { status: 429 });
  session.users++;
  const previous = session.tail;
  let unlock;
  const gate = new Promise(resolve => { unlock = resolve; });
  session.tail = previous.then(() => gate);
  let abort;
  try {
    await Promise.race([previous, new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })]);
    if (signal.aborted) throw signal.reason;
  } catch (error) {
    previous.then(() => { session.users--; unlock(); });
    throw error;
  } finally { signal.removeEventListener('abort', abort); }
  let released = false;
  return () => {
    if (released) return;
    released = true; session.users--; session.touched = Date.now(); unlock();
  };
}

export function resetConnection(session) {
  clearTimeout(session.idleTimer);
  session.socket?.terminate();
  session.socket = null;
  session.context = null;
  session.outputContext = null;
  session.responseId = null;
  session.connectionKey = null;
}

// Canonical key ordering avoids a false mismatch from JSON object ordering.
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

export function inputItems(input) {
  return typeof input === 'string' ? [{ role: 'user', content: [{ type: 'input_text', text: input }] }] : input;
}

export function itemHashes(input) {
  const items = inputItems(input);
  return Array.isArray(items) ? items.map(item => digest(canonical(item))) : null;
}

export function outputVariants(items) {
  return items.map(item => {
    // Codex deserializes output into ResponseItem, dropping output-only fields.
    // Apply this only to returned output; never discard fields from client input.
    if (!['message', 'function_call', 'custom_tool_call', 'reasoning'].includes(item.type)) return [item];
    const parsed = { ...item };
    if (item.type !== 'custom_tool_call') delete parsed.status;
    // Codex's Option fields use skip_serializing_if=None. In particular,
    // custom_tool_call namespace:null becomes absent on the next request.
    for (const field of ['id', 'phase', 'namespace', 'status']) if (parsed[field] === null) delete parsed[field];
    delete parsed.internal_chat_message_metadata_passthrough;
    delete parsed.metadata; // Factory-only field, absent from Codex ResponseItem.
    if (item.type === 'function_call') delete parsed.encrypted_function_args;
    if (item.type === 'message' && Array.isArray(parsed.content)) {
      parsed.content = parsed.content.map(c => {
        if (c.type !== 'output_text') return c;
        const { annotations, logprobs, ...content } = c;
        return content;
      });
    }
    if (item.type === 'reasoning') {
      parsed.encrypted_content ??= null;
      if (parsed.content === undefined) parsed.content = null;
      else if (Array.isArray(parsed.content) && !parsed.content.some(c => c.type === 'reasoning_text')) delete parsed.content;
    }
    return [item, parsed];
  });
}

export function outputHashes(items) {
  return outputVariants(items).map(variants => variants.map(item => digest(canonical(item))));
}

// Bounded, in-memory field fingerprints: never retain message text or tool arguments.
// Parent hashes still detect changes when a large/deep object exceeds the detail cap.
export function itemFingerprint(item) {
  const fields = {};
  let count = 0;
  const visit = (value, path, depth) => {
    if (count >= 128) return;
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    fields[path] = { kind, hash: digest([kind, canonical(value)]) };
    count++;
    if (value && typeof value === 'object' && depth < 4) {
      for (const key of Object.keys(value).sort()) {
        if (count >= 128) break;
        visit(value[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, depth + 1);
      }
    }
  };
  visit(item, '', 0);
  return fields;
}

export function fingerprintChanges(expected, actual) {
  const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .filter(path => expected[path]?.hash !== actual[path]?.hash);
  return changed.filter(path => !changed.some(other => other.startsWith(`${path}/`))).slice(0, 12)
    .map(path => ({ path: path || '/', expected: expected[path]?.kind || 'absent', actual: actual[path]?.kind || 'absent' }));
}

export function clearFactorySessions() {
  for (const session of sessions.values()) resetConnection(session);
  sessions.clear();
}
