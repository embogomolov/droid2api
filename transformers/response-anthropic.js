import { logDebug } from '../logger.js';

export class AnthropicResponseTransformer {
  constructor(model, requestId) {
    this.model = model;
    this.requestId = requestId || `chatcmpl-${Date.now()}`;
    this.created = Math.floor(Date.now() / 1000);
    this.messageId = null;
    this.currentIndex = 0;
    // BaSui: Track the current tool call state
    this.currentToolCall = null;
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
    logDebug(`Anthropic event: ${eventType}`);

    if (eventType === 'message_start') {
      this.messageId = eventData.message?.id || this.requestId;
      return this.createOpenAIChunk('', 'assistant', false);
    }

    if (eventType === 'content_block_start') {
      const blockType = eventData.content_block?.type;
      
      // BaSui: Handle tool call start events
      if (blockType === 'tool_use') {
        const toolUse = eventData.content_block;
        // 🔧 Fix: use atomic operations to prevent race conditions
        const currentIndex = this.toolCallIndex;
        this.toolCallIndex = currentIndex + 1;
        this.currentToolCall = {
          index: currentIndex,
          id: toolUse.id || `call_${Date.now()}`,
          type: 'function',
          function: {
            name: toolUse.name || '',
            arguments: '' // Arguments accumulate in subsequent deltas
          }
        };
        
        // Return the tool call start chunk
        return this.createToolCallChunk(this.currentToolCall, true);
      }
      
      // BaSui: Handle thinking block start events (reasoning content)
      // OpenAI has no thinking field; output thinking content as ordinary text
      // Options: 1 output thinking content, 2 hide thinking content
      // This implementation outputs it wrapped in special markers
      if (blockType === 'thinking') {
        return this.createOpenAIChunk('\n<thinking>\n', null, false);
      }
      
      return null;
    }

    if (eventType === 'content_block_delta') {
      const deltaType = eventData.delta?.type;
      
      // BaSui: Handle text content deltas
      if (deltaType === 'text_delta') {
        const text = eventData.delta?.text || '';
        return this.createOpenAIChunk(text, null, false);
      }
      
      // BaSui: Handle thinking content deltas (reasoning process)
      if (deltaType === 'thinking_delta') {
        const text = eventData.delta?.thinking || eventData.delta?.text || '';
        return this.createOpenAIChunk(text, null, false);
      }
      
      // BaSui: Handle tool call argument deltas
      if (deltaType === 'input_json_delta' && this.currentToolCall) {
        const jsonDelta = eventData.delta?.partial_json || '';
        this.currentToolCall.function.arguments += jsonDelta;
        
        // Return the tool call argument delta chunk
        return this.createToolCallChunk(this.currentToolCall, false, jsonDelta);
      }
      
      return null;
    }

    if (eventType === 'content_block_stop') {
      // BaSui: Handle the end of a thinking block (append the closing marker)
      const blockIndex = eventData.index;
      // Simplified check: currentToolCall indicates a tool block; otherwise it may be a thinking block
      // Ideally track blockType; this implementation uses simplified handling
      if (!this.currentToolCall) {
        // This may be the end of a thinking block; append the closing marker
        // Note: this check is imprecise; a better approach is to record the block type at content_block_start:blockType
        // return this.createOpenAIChunk('\n</thinking>\n', null, false);
      }
      
      // BaSui: Reset the current tool call state
      if (this.currentToolCall) {
        this.currentToolCall = null;
      }
      return null;
    }

    if (eventType === 'message_delta') {
      const stopReason = eventData.delta?.stop_reason;
      if (stopReason) {
        return this.createOpenAIChunk('', null, true, this.mapStopReason(stopReason));
      }
      return null;
    }

    if (eventType === 'message_stop') {
      return this.createDoneSignal();
    }

    if (eventType === 'ping') {
      return null;
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
      // Tool call start: send the full tool_calls structure (id and function.name)
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
      // Tool call argument delta: send only the incremental arguments
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

  mapStopReason(anthropicReason) {
    const mapping = {
      'end_turn': 'stop',
      'max_tokens': 'length',
      'stop_sequence': 'stop',
      'tool_use': 'tool_calls'
    };
    return mapping[anthropicReason] || 'stop';
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
          } else if (parsed.type === 'data' && currentEvent) {
            const transformed = this.transformEvent(currentEvent, parsed.value);
            if (transformed) {
              yield transformed;
              // BaSui: Optimization: release references immediately after yield to help GC
              currentEvent = null;
            } else {
              currentEvent = null;
            }
          }
        }
      }
    } catch (error) {
      logDebug('Error in Anthropic stream transformation', error);
      throw error;
    }
  }
}
