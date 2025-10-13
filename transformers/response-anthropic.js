import { logDebug } from '../logger.js';

export class AnthropicResponseTransformer {
  constructor(model, requestId) {
    this.model = model;
    this.requestId = requestId || `chatcmpl-${Date.now()}`;
    this.created = Math.floor(Date.now() / 1000);
    this.messageId = null;
    this.currentIndex = 0;
    // BaSui：跟踪当前的工具调用状态
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
      
      // BaSui：处理工具调用开始事件
      if (blockType === 'tool_use') {
        const toolUse = eventData.content_block;
        this.currentToolCall = {
          index: this.toolCallIndex++,
          id: toolUse.id || `call_${Date.now()}`,
          type: 'function',
          function: {
            name: toolUse.name || '',
            arguments: '' // 参数会在后续的delta中累积
          }
        };
        
        // 返回工具调用开始的chunk
        return this.createToolCallChunk(this.currentToolCall, true);
      }
      
      // BaSui：处理thinking块开始事件（推理内容）
      // OpenAI没有thinking字段，将thinking内容作为普通文本输出
      // 可以选择：1) 输出thinking内容 2) 隐藏thinking内容
      // 这里选择输出，用特殊标记包裹
      if (blockType === 'thinking') {
        return this.createOpenAIChunk('\n<thinking>\n', null, false);
      }
      
      return null;
    }

    if (eventType === 'content_block_delta') {
      const deltaType = eventData.delta?.type;
      
      // BaSui：处理文本内容增量
      if (deltaType === 'text_delta') {
        const text = eventData.delta?.text || '';
        return this.createOpenAIChunk(text, null, false);
      }
      
      // BaSui：处理thinking内容增量（推理过程）
      if (deltaType === 'thinking_delta') {
        const text = eventData.delta?.thinking || eventData.delta?.text || '';
        return this.createOpenAIChunk(text, null, false);
      }
      
      // BaSui：处理工具调用参数增量
      if (deltaType === 'input_json_delta' && this.currentToolCall) {
        const jsonDelta = eventData.delta?.partial_json || '';
        this.currentToolCall.function.arguments += jsonDelta;
        
        // 返回工具调用参数的增量chunk
        return this.createToolCallChunk(this.currentToolCall, false, jsonDelta);
      }
      
      return null;
    }

    if (eventType === 'content_block_stop') {
      // BaSui：处理thinking块结束（添加结束标记）
      const blockIndex = eventData.index;
      // 简单判断：如果有currentToolCall说明是工具块，否则可能是thinking块
      // 实际应该跟踪blockType，这里简化处理
      if (!this.currentToolCall) {
        // 可能是thinking块结束，添加结束标记
        // 注意：这个判断不够精确，更好的做法是在content_block_start时记录blockType
        // return this.createOpenAIChunk('\n</thinking>\n', null, false);
      }
      
      // BaSui：重置当前工具调用状态
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

  // BaSui：创建工具调用的OpenAI格式chunk
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
      // 工具调用开始：发送完整的tool_calls结构（只有id和function.name）
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
      // 工具调用参数增量：只发送arguments的增量
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
    // BaSui：添加buffer大小保护，防止内存溢出（最大10KB未处理行）
    const MAX_BUFFER_SIZE = 10 * 1024;

    try {
      for await (const chunk of sourceStream) {
        // BaSui：优化 - 避免超大chunk直接toString可能的性能问题
        const chunkStr = chunk.toString();
        buffer += chunkStr;

        // BaSui：内存保护 - 如果buffer过大说明没有换行符，截断并警告
        if (buffer.length > MAX_BUFFER_SIZE) {
          logDebug(`⚠️ Buffer size exceeded ${MAX_BUFFER_SIZE} bytes, truncating`);
          buffer = buffer.slice(-MAX_BUFFER_SIZE); // 保留最后10KB
        }

        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留最后不完整的行

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
              // BaSui：优化 - yield后立即释放引用，帮助GC
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
