import { canonical, digest } from '../utils/factory-sessions.js';

export const MAX_TOOL_TURN_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const TTL = 60 * 60_000;
const turns = new Map();
let storedBytes = 0;

function visibleTurn(blocks) {
  const tools = blocks.filter(block => block.type === 'tool_use')
    .map(({ id, name, input }) => ({ id, name, input }));
  if (!tools.length) return null;
  return [blocks.filter(block => block.type === 'text').map(block => block.text).join(''), tools];
}

function withoutCacheControl({ cache_control, ...block }) {
  return block;
}

function restoreCacheControl(blocks, visible) {
  if (!visible.some(block => block.cache_control !== undefined)) return blocks;
  const textBreakpoints = new Map(), toolBreakpoints = new Map();
  let offset = 0;
  for (const block of visible) {
    if (block.type === 'text') {
      offset += block.text.length;
      if (block.cache_control !== undefined) textBreakpoints.set(offset, block.cache_control);
    } else if (block.cache_control !== undefined) {
      toolBreakpoints.set(block.id, block.cache_control);
    }
  }

  offset = 0;
  return blocks.flatMap(block => {
    if (block.type === 'tool_use' && toolBreakpoints.has(block.id)) {
      return { ...block, cache_control: toolBreakpoints.get(block.id) };
    }
    if (block.type !== 'text') return block;
    const start = offset;
    offset += block.text.length;
    let cursor = start;
    const pieces = [];
    for (const [end, cache_control] of textBreakpoints) {
      if (end <= start || end > offset) continue;
      const piece = end === offset ? { ...block } : { type: 'text' };
      pieces.push({ ...piece, text: block.text.slice(cursor - start, end - start), cache_control });
      cursor = end;
    }
    if (cursor === start) return block;
    if (cursor < offset) pieces.push({ ...block, text: block.text.slice(cursor - start) });
    return pieces;
  });
}

function remove(key) {
  const turn = turns.get(key);
  if (turn) storedBytes -= turn.bytes;
  turns.delete(key);
}

// Chat Completions has no field for Claude's signed blocks. Replay the original
// assistant turn only when the input prefix, visible text and tool calls match.
export function prepareAnthropicToolHistory(body, endpoint, scope) {
  // Cache breakpoints may move between requests without changing the signed history.
  let prefix = digest(canonical([endpoint, scope, body.model, body.system?.map(withoutCacheControl),
    body.tools?.map(withoutCacheControl), body.thinking, body.tool_choice]));
  const keyFor = visible => digest(canonical([prefix, visible]));
  body.messages = body.messages.map(message => {
    let blocks = message.content;
    if (message.role === 'assistant' && message.content.every(block => ['text', 'tool_use'].includes(block.type))) {
      const visible = visibleTurn(message.content);
      if (visible) {
        const key = keyFor(visible);
        const saved = turns.get(key);
        if (saved?.expires > Date.now()) {
          blocks = saved.blocks;
          message = { ...message, content: restoreCacheControl(blocks, message.content) };
          saved.expires = Date.now() + TTL;
          turns.delete(key);
          turns.set(key, saved);
        } else if (saved) remove(key);
      }
    }
    prefix = digest([prefix, canonical({ ...message, content: blocks.map(withoutCacheControl) })]);
    return message;
  });
  return blocks => {
    const visible = visibleTurn(blocks);
    if (!visible) return;
    const bytes = Buffer.byteLength(JSON.stringify(blocks));
    if (bytes > MAX_TOOL_TURN_BYTES) return;
    const key = keyFor(visible);
    remove(key);
    while (turns.size >= 128 || storedBytes + bytes > MAX_HISTORY_BYTES) remove(turns.keys().next().value);
    turns.set(key, { blocks, bytes, expires: Date.now() + TTL });
    storedBytes += bytes;
  };
}
