import { StringDecoder } from 'node:string_decoder';

// Bound a single SSE event, not the lifetime or total size of the stream.
const MAX_EVENT_LENGTH = 16 * 1024 * 1024;

async function* readEvents(source) {
  const decoder = new StringDecoder('utf8');
  let line = '', event = '', data = null, skipLF = false, first = true;
  for await (const chunk of source) {
    let text = decoder.write(chunk);
    if (!text) continue;
    if (first) { text = text.replace(/^\uFEFF/, ''); first = false; }
    if (skipLF && text.startsWith('\n')) text = text.slice(1);
    skipLF = false;
    let offset = 0;
    for (const match of text.matchAll(/\r\n|\r|\n/g)) {
      line += text.slice(offset, match.index);
      offset = match.index + match[0].length;
      skipLF = match[0] === '\r' && offset === text.length;
      if ((data?.length ?? 0) + line.length > MAX_EVENT_LENGTH) throw new Error('Upstream SSE event exceeds size limit');
      if (!line) {
        if (data && data !== '[DONE]') {
          const payload = JSON.parse(data);
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid upstream SSE payload');
          yield payload.type || !event ? payload : { ...payload, type: event };
        }
        event = ''; data = null;
      } else if (line === 'data' || line.startsWith('data:')) {
        const value = line.slice(5).replace(/^ /, '');
        data = data === null ? value : data + '\n' + value;
      } else if (line.startsWith('event:')) {
        event = line.slice(6).replace(/^ /, '');
      }
      line = '';
    }
    line += text.slice(offset);
    if ((data?.length ?? 0) + line.length > MAX_EVENT_LENGTH) throw new Error('Upstream SSE event exceeds size limit');
  }
}

const encode = value => 'data: ' + JSON.stringify(value) + '\n\n';

export class ChatCompletionStream {
  constructor(model, id) {
    this.model = model;
    this.id = id ?? `chatcmpl-${Date.now()}`;
    this.created = Math.floor(Date.now() / 1000);
    this.tools = new Map();
    this.finishReason = null;
  }

  chunk(delta, finishReason = null) {
    return encode({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }] });
  }

  startTool(key, id, name, type = 'function') {
    if (this.tools.has(key)) return null;
    const field = type === 'function' ? 'arguments' : 'input';
    const index = this.tools.size;
    this.tools.set(key, { index, type, field, length: 0 });
    return this.chunk({ tool_calls: [{ index, id, type, [type]: { name, [field]: '' } }] });
  }

  toolInput(key, value, complete = false) {
    const tool = this.tools.get(key);
    if (!tool || typeof value !== 'string') return null;
    const delta = complete ? value.slice(tool.length) : value;
    if (!delta) return null;
    tool.length += delta.length;
    return this.chunk({ tool_calls: [{ index: tool.index, [tool.type]: { [tool.field]: delta } }] });
  }

  async *transformStream(source, observe) {
    let started = false;
    for await (const payload of readEvents(source)) {
      const { type } = payload;
      observe?.(payload);
      const error = payload.response?.error ?? payload.error;
      if (type === 'error' || type === 'response.failed' || error) {
        yield encode({ error: error ?? {
          type: 'upstream_error', code: payload.code, param: payload.param,
          message: payload.message ?? 'Upstream generation failed'
        } });
        return;
      }
      for (const chunk of this.transformEvent(type, payload)) {
        if (!chunk) continue;
        if (!started) {
          started = true;
          yield this.chunk({ role: 'assistant' });
        }
        yield chunk;
      }
      if (this.finishReason) break;
    }
    if (!this.finishReason) throw new Error('Upstream SSE stream did not finish generation');
    if (!started) yield this.chunk({ role: 'assistant' });
    yield this.chunk({}, this.finishReason);
    yield 'data: [DONE]\n\n';
  }
}
