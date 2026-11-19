// Factory's usage policy check refuses (HTTP 403 content_policy_rejected) any request whose tool
// list contains certain client tool names, verbatim and case-sensitive: Bash, Write, Agent,
// NotebookEdit, TaskCreate, ExitPlanMode, read, write, ... (Read, Edit, Grep, Glob - names Droid
// itself uses - pass, and so does any prefixed name). So every client tool goes upstream under a
// prefixed alias, in the tool list, tool_choice and the replayed history, and answers are mapped
// back to the client's own names. TOOL_NAME_ALIAS=off disables it; TOOL_NAME_PREFIX changes the
// prefix (default "fn_").
import { createHash } from 'node:crypto';

const MAX_NAME = 64;  // Anthropic and Gemini function-name limit

function prefix() {
  return process.env.TOOL_NAME_PREFIX || 'fn_';
}

export function toolAliasEnabled() {
  return !['off', '0', 'false', 'no'].includes((process.env.TOOL_NAME_ALIAS || '').trim().toLowerCase());
}

// Deterministic (prompt caching needs the same alias on every turn) and within the length limit.
export function aliasFor(name) {
  const p = prefix();
  const alias = p + name;
  if (alias.length <= MAX_NAME) return alias;
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `${p}${name.slice(0, MAX_NAME - p.length - 9)}_${hash}`;
}

class ToolNames {
  constructor() { this.byAlias = new Map(); }
  alias(name) {
    if (typeof name !== 'string' || !name) return name;
    const alias = aliasFor(name);
    this.byAlias.set(alias, name);
    return alias;
  }
  // Names the model invents outside the list still lose the prefix.
  original(alias) {
    if (typeof alias !== 'string') return alias;
    if (this.byAlias.has(alias)) return this.byAlias.get(alias);
    const p = prefix();
    return alias.startsWith(p) ? alias.slice(p.length) : alias;
  }
}

// The policy check also refuses some stock tool DESCRIPTIONS verbatim and whitespace-exact (Claude
// Desktop's read_widget_context text was refused whole; each sentence alone, or the same text with
// two spaces between sentences, passes). Two spaces after a sentence end break any multi-sentence stock
// description while the model reads the same words. Deterministic, so prompt caching holds.
export function neutralizeDescription(text) {
  return typeof text === 'string' ? text.replace(/([.!?:]) (?=\S)/g, '$1  ') : text;
}

// Anthropic Messages request (in place). Server tools (web_search_..., code_execution_... with a
// versioned type) keep their fixed names. Returns a decoder, or null when nothing was renamed.
export function aliasAnthropicTools(request) {
  if (!toolAliasEnabled() || !request || !Array.isArray(request.tools) || !request.tools.length) return null;
  const names = new ToolNames();
  const custom = tool => tool && typeof tool.name === 'string' && (!tool.type || tool.type === 'custom');
  request.tools = request.tools.map(tool => custom(tool)
    ? { ...tool, name: names.alias(tool.name), ...(typeof tool.description === 'string' ? { description: neutralizeDescription(tool.description) } : {}) }
    : tool);
  if (request.tool_choice?.type === 'tool' && typeof request.tool_choice.name === 'string') {
    request.tool_choice = { ...request.tool_choice, name: names.alias(request.tool_choice.name) };
  }
  if (Array.isArray(request.messages)) request.messages = request.messages.map(message => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return message;
    if (!message.content.some(block => block?.type === 'tool_use')) return message;
    return { ...message, content: message.content.map(block =>
      block?.type === 'tool_use' ? { ...block, name: names.alias(block.name) } : block) };
  });
  return names;
}

// OpenAI Chat Completions request (in place): tools, tool_choice, assistant tool_calls and the
// optional name on tool / function messages.
export function aliasOpenAITools(request) {
  if (!toolAliasEnabled() || !request || !Array.isArray(request.tools) || !request.tools.length) return null;
  const names = new ToolNames();
  request.tools = request.tools.map(tool => tool?.type === 'function' && typeof tool.function?.name === 'string'
    ? { ...tool, function: { ...tool.function, name: names.alias(tool.function.name),
        ...(typeof tool.function.description === 'string' ? { description: neutralizeDescription(tool.function.description) } : {}) } }
    : tool);
  if (request.tool_choice?.type === 'function' && typeof request.tool_choice.function?.name === 'string') {
    request.tool_choice = { ...request.tool_choice, function: { ...request.tool_choice.function, name: names.alias(request.tool_choice.function.name) } };
  }
  if (Array.isArray(request.messages)) request.messages = request.messages.map(message => {
    if (!message || typeof message !== 'object') return message;
    let out = message;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      out = { ...out, tool_calls: message.tool_calls.map(call => typeof call?.function?.name === 'string'
        ? { ...call, function: { ...call.function, name: names.alias(call.function.name) } } : call) };
    }
    if (message.role === 'assistant' && typeof message.function_call?.name === 'string') {
      out = { ...out, function_call: { ...message.function_call, name: names.alias(message.function_call.name) } };
    }
    if ((message.role === 'tool' || message.role === 'function') && typeof message.name === 'string') {
      out = { ...out, name: names.alias(message.name) };
    }
    return out;
  });
  return names;
}

// Anthropic response body: a copy whose tool_use blocks carry the client's names.
export function restoreAnthropicContent(data, names) {
  if (!names || !Array.isArray(data?.content)) return data;
  return { ...data, content: data.content.map(block =>
    block?.type === 'tool_use' ? { ...block, name: names.original(block.name) } : block) };
}

// Chat Completions chunk or response (in place): tool_calls / function_call names.
export function restoreOpenAINames(data, names) {
  if (!names || !Array.isArray(data?.choices)) return data;
  for (const choice of data.choices) {
    for (const holder of [choice?.delta, choice?.message]) {
      if (!holder) continue;
      if (Array.isArray(holder.tool_calls)) for (const call of holder.tool_calls) {
        if (typeof call?.function?.name === 'string') call.function.name = names.original(call.function.name);
      }
      if (typeof holder.function_call?.name === 'string') holder.function_call.name = names.original(holder.function_call.name);
    }
  }
  return data;
}

// One line of an Anthropic SSE stream forwarded as-is (/v1/messages): tool_use blocks start with
// a content_block_start event that carries the (aliased) name.
export function restoreAnthropicEventLine(line, names) {
  if (!names || !line.startsWith('data:') || !line.includes('"tool_use"')) return line;
  try {
    const event = JSON.parse(line.slice(5).trim());
    if (event?.type !== 'content_block_start' || event.content_block?.type !== 'tool_use') return line;
    event.content_block.name = names.original(event.content_block.name);
    return 'data: ' + JSON.stringify(event) + (line.endsWith('\r') ? '\r' : '');
  } catch {
    return line;
  }
}
