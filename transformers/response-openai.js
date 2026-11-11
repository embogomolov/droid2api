import { ChatCompletionStream } from './chat-completion-stream.js';

export class OpenAIResponseTransformer extends ChatCompletionStream {
  constructor(model, id) {
    super(model, id);
    this.contentLengths = new Map();
    this.refused = false;
  }

  content(output, index, type, value, complete = false) {
    if (typeof value !== 'string') return null;
    const key = `${output}:${index}:${type}`;
    const length = this.contentLengths.get(key) ?? 0;
    const delta = complete ? value.slice(length) : value;
    if (!delta) return null;
    this.contentLengths.set(key, length + delta.length);
    if (type === 'refusal') this.refused = true;
    return this.chunk({ [type]: delta });
  }

  *part(output, index, part) {
    if (part?.type === 'output_text') yield this.content(output, index, 'content', part.text, true);
    if (part?.type === 'refusal') {
      this.refused = true;
      yield this.content(output, index, 'refusal', part.refusal, true);
    }
  }

  *item(index, item) {
    if (item?.type === 'function_call') {
      yield this.startTool(index, item.call_id, item.name);
      yield this.toolInput(index, item.arguments, true);
    } else if (item?.type === 'custom_tool_call') {
      yield this.startTool(index, item.call_id, item.name, 'custom');
      yield this.toolInput(index, item.input, true);
    } else if (item?.type === 'message') {
      for (const [partIndex, part] of (item.content ?? []).entries()) yield* this.part(index, partIndex, part);
    }
  }

  *transformEvent(type, event) {
    const { output_index: output, content_index: index, response, delta } = event;
    switch (type) {
      case 'response.output_text.delta':
        yield this.content(output, index, 'content', delta);
        break;
      case 'response.output_text.done':
        yield this.content(output, index, 'content', event.text, true);
        break;
      case 'response.refusal.delta':
        this.refused = true;
        yield this.content(output, index, 'refusal', delta);
        break;
      case 'response.refusal.done':
        this.refused = true;
        yield this.content(output, index, 'refusal', event.refusal, true);
        break;
      case 'response.content_part.added':
      case 'response.content_part.done':
        yield* this.part(output, index, event.part);
        break;
      case 'response.output_item.added':
      case 'response.output_item.done':
        yield* this.item(output, event.item);
        break;
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta':
        yield this.toolInput(output, delta);
        break;
      case 'response.function_call_arguments.done':
        yield this.toolInput(output, event.arguments, true);
        break;
      case 'response.custom_tool_call_input.done':
        yield this.toolInput(output, event.input, true);
        break;
      case 'response.completed':
      case 'response.incomplete':
      case 'response.done': {
        if (['failed', 'cancelled'].includes(response?.status)) throw new Error('Upstream Responses generation failed');
        for (const [itemIndex, item] of (response?.output ?? []).entries()) yield* this.item(itemIndex, item);
        const reason = response?.incomplete_details?.reason;
        if (reason === 'content_filter' || this.refused) this.finishReason = 'content_filter';
        else if (type === 'response.incomplete' || response?.status === 'incomplete') {
          if (reason && reason !== 'max_output_tokens' && reason !== 'max_messages') throw new Error('Upstream Responses generation incomplete');
          this.finishReason = 'length';
        }
        else this.finishReason = this.tools.size ? 'tool_calls' : 'stop';
        break;
      }
    }
  }
}
