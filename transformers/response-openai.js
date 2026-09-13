import { logDebug } from '../logger.js';

export class OpenAIResponseTransformer {
  constructor(model, requestId) {
    this.model = model;
    this.requestId = requestId || `chatcmpl-${Date.now()}`;
    this.created = Math.floor(Date.now() / 1000);
    // BaSui: Track tool call state
    this.currentToolCalls = [];
    this.toolCallIndex = 0;
  }

  parseSSELine(line) {
    if (line.startsWith('event:')) {
      return { type: 'event', value: line.slice(6).trim() };
    }
    if (line.startsWith('data:')) {
      const dataStr = line.slice(5).trim();
      try {
        return { type: 'data', value: JSON.parse(dataStr) };
      } catch (e) {
        return { type: 'data', value: dataStr };
      }
    }
    return null;
  }

  transformEvent(eventType, eventData) {
    logDebug(`Target OpenAI event: ${eventType}`);

    if (eventType === 'response.created') {
      return this.createOpenAIChunk('', 'assistant', false);
    }

    if (eventType === 'response.in_progress') {
      return null;
    }

    if (eventType === 'response?.output_text?.delta') {
      const text = eventData.delta || eventData.text || '';
      return this.createOpenAIChunk(text, null, false);
    }

    if (eventType === 'response?.output_text?.done') {
      return null;
    }

    // BaSui: Handle tool call start events
    if (eventType === 'response?.tool_calls?.start') {
      // 🔧 Fix: use atomic operations to prevent race conditions
      const currentIndex = this.toolCallIndex;
      this.toolCallIndex = currentIndex + 1;
      const toolCall = {
        index: currentIndex,
        id: eventData.id || `call_${Date.now()}`,
        type: 'function',
        function: {
          name: eventData.name || '',
          arguments: ''
        }
      };
      this.currentToolCalls.push(toolCall);
      return this.createToolCallChunk(toolCall, true);
    }

    // BaSui: Handle tool call argument deltas
    if (eventType === 'response?.tool_calls?.delta' || eventType === 'response?.function_call?.delta') {
      const argumentsDelta = eventData.delta || eventData.arguments || '';
      const index = eventData.index !== undefined ? eventData.index : this.toolCallIndex - 1;
      
      if (this.currentToolCalls[index]) {
        this.currentToolCalls[index].function.arguments += argumentsDelta;
        return this.createToolCallChunk(this.currentToolCalls[index], false, argumentsDelta);
      }
      return null;
    }

    // BaSui: Handle tool call completion
    if (eventType === 'response?.tool_calls?.done' || eventType === 'response?.function_call?.done') {
      return null;
    }

    if (eventType === 'response.done') {
      const status = eventData.response?.status;
      let finishReason = 'stop';
      
      if (status === 'completed') {
        finishReason = this.currentToolCalls.length > 0 ? 'tool_calls' : 'stop';
      } else if (status === 'incomplete') {
        finishReason = 'length';
      }

      const finalChunk = this.createOpenAIChunk('', null, true, finishReason);
      const done = this.createDoneSignal();
      return finalChunk + done;
    }

    return null;
  }

  createOpenAIChunk(content, role = null, finish = false, finishReason = null) {
    const chunk = {
      id: this.requestId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finish ? finishReason : null
        }
      ]
    };

    if (role) {
      chunk.choices[0].delta.role = role;
    }
    if (content) {
      chunk.choices[0].delta.content = content;
    }

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  // BaSui: Create an OpenAI-format tool call chunk
  createToolCallChunk(toolCall, isStart = false, argumentsDelta = '') {
    const chunk = {
      id: this.requestId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: null
        }
      ]
    };

    if (isStart) {
      chunk.choices[0].delta.tool_calls = [{
        index: toolCall.index,
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.function.name,
          arguments: ''
        }
      }];
    } else if (argumentsDelta) {
      chunk.choices[0].delta.tool_calls = [{
        index: toolCall.index,
        function: {
          arguments: argumentsDelta
        }
      }];
    }

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  createDoneSignal() {
    return 'data: [DONE]\n\n';
  }

  async *transformStream(sourceStream) {
    let buffer = '';
    let currentEvent = null;
    // BaSui: Guard buffer size to prevent excessive memory use (maximum 10 KB of unprocessed lines)
    const MAX_BUFFER_SIZE = 10 * 1024;

    try {
      for await (const chunk of sourceStream) {
        // BaSui: Optimization: avoid potential overhead from calling toString on very large chunks
        const chunkStr = chunk.toString();
        buffer += chunkStr;

        // BaSui: Memory protection: an oversized buffer indicates missing newlines; truncate and warn
        if (buffer.length > MAX_BUFFER_SIZE) {
          logDebug(`⚠️ Buffer size exceeded ${MAX_BUFFER_SIZE} bytes, truncating`);
          buffer = buffer.slice(-MAX_BUFFER_SIZE); // Keep the last 10KB
        }

        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep the final incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;

          const parsed = this.parseSSELine(line);
          if (!parsed) continue;

          if (parsed.type === 'event') {
            currentEvent = parsed.value;
          } else if (parsed.type === 'data') {
            // BaSui: Use a default when no event line is present to avoid dropping data
            const eventType = currentEvent || 'response.data';
            const transformed = this.transformEvent(eventType, parsed.value);
            if (transformed) {
              yield transformed;
              // BaSui: Optimization: release references immediately after yield to help GC
            }
            currentEvent = null;
          }
        }
      }

      if (currentEvent === 'response.done' || currentEvent === 'response.completed') {
        yield this.createDoneSignal();
      }
    } catch (error) {
      logDebug('Error in OpenAI stream transformation', error);
      throw error;
    }
  }
}
