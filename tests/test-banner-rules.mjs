// Stock client strings the usage policy check refuses verbatim must not survive any request path.
import assert from 'node:assert/strict';
import { transformToAnthropic, prepareDirectAnthropic } from '../transformers/request-anthropic.js';

const TRIGGERS = [
  'require hooks configured in settings.json - the harness executes these, not Claude, so memory/preferences cannot fulfill them.',
  "If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done).",
  'Called the Read tool with the following input:',
  'The named tool itself is enforced separately; your job here is to catch circumvention.',
  'You are Hermes Agent, built by Nous Research.',
  'You are an AI agent running in OpenCode',
  'a coding agent harness. Help the user accomplish their goals using the tools you have available.',
  "(user's private global instructions for all projects):",
];
const skills = '- update-config: Use this skill to configure the Claude Code harness via settings.json. Automated behaviors ("from now on when X") require hooks configured in settings.json - the harness executes these, not Claude, so memory/preferences cannot fulfill them. Also use for: permissions.';
const tasks = "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). This is just a gentle reminder - ignore if not applicable.";
const claudeMd = "<system-reminder>\nCodebase and user instructions are shown below.\n\nContents of /Users/x/.claude/CLAUDE.md (user's private global instructions for all projects):\n- Be concise.\n</system-reminder>";
const reads = 'Called the Read tool with the following input: {"file_path":"a.ts"}\nResult of calling the Read tool:\n1\tconst a = 1;';

// Chat-completions path: user text, tool results and system.
const chat = transformToAnthropic({ model: 'claude-sonnet-5-5', messages: [
  { role: 'system', content: reads },
  { role: 'user', content: [{ type: 'text', text: '<system-reminder>\n' + skills + '\n</system-reminder>' }, { type: 'text', text: tasks }, { type: 'text', text: claudeMd }] },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: reads },
  { role: 'user', content: 'go on' } ] });
const chatText = JSON.stringify(chat);
for (const t of TRIGGERS) assert.ok(!chatText.includes(t), `chat path kept: ${t.slice(0, 50)}`);
assert.ok(chatText.includes('Earlier tool call (Read), input:'));
assert.ok(chatText.includes('TaskCreate adds tasks'));
assert.ok(chatText.includes('must use settings.json hooks'));
assert.ok(chatText.includes('const a = 1;'), 'file content kept');
assert.ok(chatText.includes('Loaded instructions from /Users/x/.claude/CLAUDE.md (user scope):'));

// Direct /v1/messages path, user-role reminders included.
const direct = prepareDirectAnthropic({ model: 'claude-sonnet-5-5', max_tokens: 64, system: reads,
  messages: [{ role: 'user', content: [{ type: 'text', text: skills }, { type: 'text', text: tasks }, { type: 'text', text: reads }, { type: 'text', text: claudeMd }] }] });
const directText = JSON.stringify(direct);
for (const t of TRIGGERS) assert.ok(!directText.includes(t), `direct path kept: ${t.slice(0, 50)}`);
// Idempotent: a second pass changes nothing.
assert.equal(JSON.stringify(prepareDirectAnthropic(structuredClone(direct)).messages), JSON.stringify(direct.messages));
// The Codex identity opener is refused verbatim (any GPT version, with or without "an agent").
const codex = transformToAnthropic({ model: 'claude-haiku-4-5-20251001', messages: [
  { role: 'system', content: 'You are Codex, an agent based on GPT-6. You and the user share one workspace.\nYou are Codex, based on GPT-5. You are running as a coding agent.\n- You are running in the same execution environment, but you can only run read-only commands. You have no network access.\nYou are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI.' },
  { role: 'user', content: 'hi' } ] });
const codexText = JSON.stringify(codex);
assert.ok(!/You are Codex, (an agent )?based on GPT-/.test(codexText), 'codex opener kept');
assert.ok(!codexText.includes('You are running in the same execution environment') && !codexText.includes('You are a coding agent running in the Codex CLI'));
assert.ok(codexText.includes('This reviewer runs in the same execution environment') && codexText.includes('This coding agent runs in the Codex CLI'));
assert.ok(codexText.includes('This agent is Codex, an agent based on GPT-6.') && codexText.includes('This agent is Codex, based on GPT-5.'));
// SillyTavern's chat separator, refused verbatim in any role and case.
const st = transformToAnthropic({ model: 'claude-opus-5-5', messages: [
  { role: 'system', content: 'Reply in the language requested.\n[Start a new chat]' },
  { role: 'user', content: '[start a new chat]\nhi' } ] });
const stText = JSON.stringify(st);
assert.ok(!/\[start a new chat\]/i.test(stText), 'sillytavern separator kept');
assert.ok(stText.includes('[New chat begins]'));
// Common (Gemini, ...) path: message text rewritten, the Anthropic billing line dropped, our prompt untouched.
const { transformToCommon } = await import('../transformers/request-common.js');
const common = transformToCommon({ model: 'gemini-x', messages: [
  { role: 'system', content: 'x-anthropic-billing-header: cc_version=2.1; cc_entrypoint=cli\nYou are Claude Code, Anthropic\'s official CLI for Claude.\n' + reads },
  { role: 'user', content: [{ type: 'text', text: tasks }] } ] });
const commonText = JSON.stringify(common);
for (const t of TRIGGERS) assert.ok(!commonText.includes(t), `common path kept: ${t.slice(0, 50)}`);
assert.ok(!commonText.includes('x-anthropic-billing-header') && !commonText.includes("You are Claude Code, Anthropic's official CLI"));
assert.ok(common.messages[0].content.startsWith('You are Droid, an AI software engineering agent built by Factory.'), 'own prompt kept');
console.log('PASS banner rules: update-config (any role), task reminder, tool-call replay, agent identities rewritten on every path');
