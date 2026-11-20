import { ChatCompletionStream } from './chat-completion-stream.js';
import { MAX_TOOL_TURN_BYTES } from './anthropic-tool-history.js';

const finishReasons = new Map([
  ['max_tokens', 'length'], ['model_context_window_exceeded', 'length'],
  ['tool_use', 'tool_calls'], ['refusal', 'content_filter']
]);
const deltaFields = new Map([
  ['text_delta', 'text'], ['thinking_delta', 'thinking'], ['signature_delta', 'signature']
]);

export class AnthropicResponseTransformer extends ChatCompletionStream {
  constructor(model, id, rememberToolTurn, toolNames = null) {
    super(model, id);
    // Tools went upstream under aliases (utils/tool-names.js); show the client its own names.
    this.toolNames = toolNames;
    this.toolInputs = new Map();
    this.stopReason = null;
    this.rememberToolTurn = rememberToolTurn;
    this.blocks = rememberToolTurn ? new Map() : null;
    this.blockBytes = 0;
  }

  capture(type, { index, delta, content_block: block }) {
    if (!this.blocks) return;
    if (type === 'content_block_start' && block) {
      this.blockBytes += Buffer.byteLength(JSON.stringify(block));
      this.blocks.set(index, { block: structuredClone(block), json: '' });
    } else if (type === 'content_block_delta' && delta) {
      const entry = this.blocks.get(index);
      if (!entry) { this.blocks = null; return; }
      const field = deltaFields.get(delta.type);
      if (field && typeof delta[field] === 'string') {
        entry.block[field] = (entry.block[field] ?? '') + delta[field];
        this.blockBytes += Buffer.byteLength(delta[field]);
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        entry.json += delta.partial_json;
        this.blockBytes += Buffer.byteLength(delta.partial_json);
      } else if (delta.type === 'citations_delta' && delta.citation) {
        (entry.block.citations ??= []).push(delta.citation);
        this.blockBytes += Buffer.byteLength(JSON.stringify(delta.citation)) + 1;
      } else {
        this.blocks = null;
      }
    } else if (type === 'content_block_stop') {
      const entry = this.blocks.get(index);
      if (entry?.json) {
        try { entry.block.input = JSON.parse(entry.json); }
        catch { this.blocks = null; }
        entry.json = '';
      }
    }
    if (this.blockBytes > MAX_TOOL_TURN_BYTES) this.blocks = null;
  }

  *transformEvent(type, event) {
    this.capture(type, event);
    const { index, delta, content_block: block } = event;
    switch (type) {
      case 'content_block_start':
        if (block?.type === 'tool_use') {
          this.toolInputs.set(index, block.input ?? {});
          yield this.startTool(index, block.id, this.toolNames ? this.toolNames.original(block.name) : block.name);
        } else if (block?.type === 'text' && block.text) {
          yield this.chunk({ content: block.text });
        }
        break;
      case 'content_block_delta':
        if (delta?.type === 'text_delta' && delta.text) yield this.chunk({ content: delta.text });
        if (delta?.type === 'input_json_delta') yield this.toolInput(index, delta.partial_json);
        break;
      case 'content_block_stop':
        if (this.toolInputs.has(index)) {
          if (!this.tools.get(index).length) yield this.toolInput(index, JSON.stringify(this.toolInputs.get(index)));
          this.toolInputs.delete(index);
        }
        break;
      case 'message_delta':
        this.stopReason = delta?.stop_reason ?? this.stopReason;
        break;
      case 'message_stop':
        this.finishReason = finishReasons.get(this.stopReason) ?? 'stop';
        if (this.stopReason === 'tool_use' && this.blocks) {
          const blocks = [...this.blocks].sort(([a], [b]) => a - b).map(([, entry]) => entry.block);
          this.rememberToolTurn(blocks);
        }
        break;
    }
  }
}
