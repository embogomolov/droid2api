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

function remove(key) {
  const turn = turns.get(key);
  if (turn) storedBytes -= turn.bytes;
  turns.delete(key);
}

// Chat Completions has no field for Claude's signed blocks. Replay the original
// assistant turn only when the input prefix, visible text and tool calls match.
export function prepareAnthropicToolHistory(body, endpoint, scope) {
  let prefix = digest(canonical([endpoint, scope, body.model, body.system, body.tools, body.thinking, body.tool_choice]));
  const keyFor = visible => digest(canonical([prefix, visible]));
  body.messages = body.messages.map(message => {
    if (message.role === 'assistant' && message.content.every(block => ['text', 'tool_use'].includes(block.type))) {
      const visible = visibleTurn(message.content);
      if (visible) {
        const key = keyFor(visible);
        const saved = turns.get(key);
        if (saved?.expires > Date.now()) {
          message = { ...message, content: saved.blocks };
          saved.expires = Date.now() + TTL;
          turns.delete(key);
          turns.set(key, saved);
        } else if (saved) remove(key);
      }
    }
    prefix = digest([prefix, canonical(message)]);
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
