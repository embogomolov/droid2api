// Client tool names the usage policy check refuses verbatim never go upstream as-is,
// and the client always gets its own names back.
import assert from 'node:assert/strict';
import { aliasAnthropicTools, aliasOpenAITools, aliasFor, restoreAnthropicContent, restoreAnthropicEventLine, restoreOpenAINames } from '../utils/tool-names.js';
import { AnthropicResponseTransformer } from '../transformers/response-anthropic.js';

const BLOCKED = ['Bash', 'Write', 'Agent', 'NotebookEdit', 'TaskCreate', 'ExitPlanMode', 'read', 'write'];
const schema = { type: 'object', properties: {} };

// Anthropic request: tools, tool_choice, history; server tools untouched.
const anthropic = {
  tools: [...BLOCKED.map(name => ({ name, description: 'x', input_schema: schema })),
    { type: 'web_search_20250305', name: 'web_search' }],
  tool_choice: { type: 'tool', name: 'Bash' },
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Write', input: { a: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
  ],
};
const names = aliasAnthropicTools(anthropic);
const sent = JSON.stringify(anthropic);
for (const name of BLOCKED) assert.ok(!sent.includes(`"name":"${name}"`), `${name} must not be sent`);
assert.equal(anthropic.tools.at(-1).name, 'web_search', 'server tool keeps its fixed name');
assert.equal(anthropic.tool_choice.name, 'fn_Bash');
assert.equal(anthropic.messages[1].content[1].name, 'fn_Write');
assert.equal(anthropic.messages[1].content[0].text, 'ok');
assert.equal(names.original('fn_Write'), 'Write');
assert.equal(names.original('fn_Unknown'), 'Unknown', 'prefix is stripped from names outside the list');
assert.equal(names.original('Plain'), 'Plain');

// Deterministic (prompt cache) and within 64 chars.
const long = 'mcp__plugins__' + 'x'.repeat(60);
assert.equal(aliasFor(long), aliasFor(long));
assert.ok(aliasFor(long).length <= 64);
const longReq = { tools: [{ name: long, input_schema: schema }], messages: [] };
const longNames = aliasAnthropicTools(longReq);
assert.equal(longNames.original(longReq.tools[0].name), long);

// Non-stream answer: tool_use mapped back on a copy.
const answer = { content: [{ type: 'tool_use', id: 'u', name: 'fn_Bash', input: {} }, { type: 'text', text: 't' }] };
assert.equal(restoreAnthropicContent(answer, names).content[0].name, 'Bash');
assert.equal(answer.content[0].name, 'fn_Bash', 'original upstream body untouched (tool history keeps aliases)');

// /v1/messages stream forwarded as-is: content_block_start lines carry the client name, others pass untouched.
const startLine = 'data: ' + JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'u2', name: 'fn_Bash', input: {} } });
assert.equal(JSON.parse(restoreAnthropicEventLine(startLine, names).slice(5)).content_block.name, 'Bash');
const deltaLine = 'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"tool_use\\":1"}}';
assert.equal(restoreAnthropicEventLine(deltaLine, names), deltaLine);
assert.equal(restoreAnthropicEventLine('event: content_block_start', names), 'event: content_block_start');
assert.equal(restoreAnthropicEventLine(startLine, null), startLine);

// Streamed answer (chat completions): the OpenAI chunk carries the client name.
const transformer = new AnthropicResponseTransformer('claude-x', 'id', undefined, names);
const chunks = [...transformer.transformEvent('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'u1', name: 'fn_NotebookEdit', input: {} } })];
assert.ok(chunks.join('').includes('"name":"NotebookEdit"'), chunks.join(''));

// OpenAI / common request.
const openai = {
  tools: BLOCKED.map(name => ({ type: 'function', function: { name, description: 'x', parameters: schema } })),
  tool_choice: { type: 'function', function: { name: 'read' } },
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'write', content: 'ok' },
  ],
};
const original = structuredClone(openai);
const oNames = aliasOpenAITools(openai);
const oSent = JSON.stringify(openai);
for (const name of BLOCKED) assert.ok(!oSent.includes(`"name":"${name}"`), `${name} must not be sent (openai)`);
assert.deepEqual(original.tools[0].function.name, 'Bash');
const chunk = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'fn_write', arguments: '' } }] } }] };
assert.equal(restoreOpenAINames(chunk, oNames).choices[0].delta.tool_calls[0].function.name, 'write');
const full = { choices: [{ message: { tool_calls: [{ function: { name: 'fn_Bash' } }] } }] };
assert.equal(restoreOpenAINames(full, oNames).choices[0].message.tool_calls[0].function.name, 'Bash');

// No tools: nothing changes.
assert.equal(aliasAnthropicTools({ messages: [] }), null);
assert.equal(aliasOpenAITools({ messages: [] }), null);

// Switch off.
process.env.TOOL_NAME_ALIAS = 'off';
const off = { tools: [{ name: 'Bash', input_schema: schema }], messages: [] };
assert.equal(aliasAnthropicTools(off), null);
assert.equal(off.tools[0].name, 'Bash');
delete process.env.TOOL_NAME_ALIAS;

console.log('tool name aliasing: all checks passed');

// Identity lines of other agents are rewritten on every path.
const { transformToAnthropic } = await import('../transformers/request-anthropic.js');
const banners = transformToAnthropic({ model: 'claude-sonnet-5-5', messages: [
  { role: 'system', content: 'You are a general-purpose AI agent called goose, created by AAIF (Agentic AI Foundation).\r\nmore' },
  { role: 'system', content: "You are Cline, an AI coding agent. Your primary goal is to assist users." },
  { role: 'user', content: 'hi' }] });
const bannerText = JSON.stringify(banners);
assert.ok(!bannerText.includes('You are a general-purpose AI agent called goose'), 'goose identity rewritten');
assert.ok(!bannerText.includes('You are Cline, an AI coding agent.'), 'Cline identity rewritten');
assert.ok(bannerText.includes('Agentic AI Foundation (AAIF)') && bannerText.includes('You are Cline, a coding agent.'));
console.log('identity rewrites: passed');

// Stock tool descriptions are refused verbatim; sentences get two spaces.
const { neutralizeDescription } = await import('../utils/tool-names.js');
const W = 'Read context from an embedded interactive widget. Widgets are rendered alongside chat from prior tool calls and can be interacted with by the user. Call this when you need to know the current state of a widget.';
assert.ok(!neutralizeDescription(W).includes(W));
assert.equal(neutralizeDescription(W).replace(/  /g, ' '), W, 'only whitespace changes');
const dreq = { tools: [{ name: 'mcp__x__read_widget_context', description: W, input_schema: schema }], messages: [] };
aliasAnthropicTools(dreq);
assert.ok(!JSON.stringify(dreq).includes(W));
const oreq = { tools: [{ type: 'function', function: { name: 'w', description: W, parameters: schema } }], messages: [] };
aliasOpenAITools(oreq);
assert.ok(!JSON.stringify(oreq).includes(W));
const ds = transformToAnthropic({ model: 'claude-sonnet-5-5', messages: [{ role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.\n\nx' }, { role: 'user', content: 'hi' }] });
assert.ok(!JSON.stringify(ds).includes('You are an AI agent powered by DeepSeek Harness.'));
console.log('description + DeepSeek rewrites: passed');
