/**
 * Anthropic (Claude) Token counting tests
 * Verify token counting accuracy for Anthropic models
 */

import { 
  countTextTokens, 
  countMessagesTokens,
  estimateRequestTokens
} from '../utils/token-counter.js';

console.log('========================================');
console.log('Anthropic (Claude) Token counting tests');
console.log('========================================\n');

// Claude model test cases
const CLAUDE_TEST_CASES = [
  {
    name: 'Claude: simple English',
    model: 'claude-sonnet-4-5-20250929',
    text: 'Hello, Claude!',
    expectedTokens: 4,
    tolerance: 1
  },
  {
    name: 'Claude: Chinese sentence',
    model: 'claude-sonnet-4-20250514',
    text: '\u8bf7\u7528\u4e2d\u6587\u56de\u7b54\u6211\u7684\u95ee\u9898',
    expectedTokens: 12,
    tolerance: 2
  },
  {
    name: 'Claude: mixed-language text',
    model: 'anthropic',
    text: 'Claude\u662fAnthropic\u5f00\u53d1\u7684AI\u52a9\u624b\uff0c\u652f\u6301\u591a\u8bed\u8a00\u5bf9\u8bdd',
    expectedTokens: 22,
    tolerance: 4
  },
  {
    name: 'Claude: code analysis',
    model: 'claude-sonnet-4-5-20250929',
    text: 'function calculate(x, y) { return x + y; }',
    expectedTokens: 14,
    tolerance: 3
  }
];

// GPT-5 tests (actually routed to the Claude backend)
const GPT5_TEST_CASES = [
  {
    name: 'GPT-5: simple test',
    model: 'gpt-5-2025-08-07',
    text: 'This is GPT-5 model test',
    expectedTokens: 7,
    tolerance: 2
  },
  {
    name: 'GPT-5-Codex code',
    model: 'gpt-5-codex',
    text: 'def hello(): print("Hello World")',
    expectedTokens: 10,
    tolerance: 2
  }
];

// GLM model tests
const GLM_TEST_CASES = [
  {
    name: 'GLM-4.6 Chinese text',
    model: 'glm-4.6',
    text: '\u667a\u8c31\u6e05\u8a00\u662f\u4e2d\u56fd\u7684\u5927\u8bed\u8a00\u6a21\u578b',
    expectedTokens: 13,
    tolerance: 3
  }
];

console.log('1. Claude model text token counting tests');
console.log('-'.repeat(50));

let passedTests = 0;
let totalTests = 0;

// Test Claude models
for (const test of CLAUDE_TEST_CASES) {
  const tokens = countTextTokens(test.text, test.model);
  const diff = Math.abs(tokens - test.expectedTokens);
  const passed = diff <= test.tolerance;
  
  console.log(`\nTest: ${test.name}`);
  console.log(`Model: ${test.model}`);
  console.log(`Text: "${test.text}"`);
  console.log(`Calculated tokens: ${tokens}`);
  console.log(`Expected tokens: ${test.expectedTokens} (±${test.tolerance})`);
  console.log(`Result: ${passed ? '✅ Passed' : '❌ Failed'} (Difference: ${diff})`);
  
  totalTests++;
  if (passed) passedTests++;
}

// Test GPT-5 (Claude backend)
console.log('\n\n2. GPT-5 model token counting tests (Claude backend)');
console.log('-'.repeat(50));

for (const test of GPT5_TEST_CASES) {
  const tokens = countTextTokens(test.text, test.model);
  const diff = Math.abs(tokens - test.expectedTokens);
  const passed = diff <= test.tolerance;
  
  console.log(`\nTest: ${test.name}`);
  console.log(`Model: ${test.model}`);
  console.log(`Text: "${test.text}"`);
  console.log(`Calculated tokens: ${tokens}`);
  console.log(`Expected tokens: ${test.expectedTokens} (±${test.tolerance})`);
  console.log(`Result: ${passed ? '✅ Passed' : '❌ Failed'} (Difference: ${diff})`);
  
  totalTests++;
  if (passed) passedTests++;
}

// Test GLM models
console.log('\n\n3. GLM model token counting tests');
console.log('-'.repeat(50));

for (const test of GLM_TEST_CASES) {
  const tokens = countTextTokens(test.text, test.model);
  const diff = Math.abs(tokens - test.expectedTokens);
  const passed = diff <= test.tolerance;
  
  console.log(`\nTest: ${test.name}`);
  console.log(`Model: ${test.model}`);
  console.log(`Text: "${test.text}"`);
  console.log(`Calculated tokens: ${tokens}`);
  console.log(`Expected tokens: ${test.expectedTokens} (±${test.tolerance})`);
  console.log(`Result: ${passed ? '✅ Passed' : '❌ Failed'} (Difference: ${diff})`);
  
  totalTests++;
  if (passed) passedTests++;
}

// Test message formats
console.log('\n\n4. Anthropic Messages token counting tests');
console.log('-'.repeat(50));

const MESSAGE_TESTS = [
  {
    name: 'Claude: single message',
    model: 'claude-sonnet-4-5-20250929',
    messages: [
      { role: 'user', content: 'Hello Claude!' }
    ],
    expectedTokens: 12,
    tolerance: 3
  },
  {
    name: 'Claude: multi-turn conversation',
    model: 'anthropic',
    messages: [
      { role: 'user', content: 'What is AI?' },
      { role: 'assistant', content: 'AI is artificial intelligence.' },
      { role: 'user', content: 'Tell me more.' }
    ],
    expectedTokens: 35,
    tolerance: 5
  },
  {
    name: 'Claude with tool use',
    model: 'claude-sonnet-4-20250514',
    messages: [
      { 
        role: 'user', 
        content: [
          { type: 'text', text: 'Calculate 2+2' },
          { 
            type: 'tool_use',
            name: 'calculator',
            input: { expression: '2+2' }
          }
        ]
      }
    ],
    expectedTokens: 25,
    tolerance: 5
  }
];

for (const test of MESSAGE_TESTS) {
  const tokens = countMessagesTokens(test.messages, test.model);
  const diff = Math.abs(tokens - test.expectedTokens);
  const passed = diff <= test.tolerance;
  
  console.log(`\nTest: ${test.name}`);
  console.log(`Model: ${test.model}`);
  console.log(`Message count: ${test.messages.length}`);
  console.log(`Calculated tokens: ${tokens}`);
  console.log(`Expected tokens: ${test.expectedTokens} (±${test.tolerance})`);
  console.log(`Result: ${passed ? '✅ Passed' : '❌ Failed'} (Difference: ${diff})`);
  
  totalTests++;
  if (passed) passedTests++;
}

// Summary
console.log('\n' + '='.repeat(60));
console.log('Test summary');
console.log('='.repeat(60));
console.log(`Total tests: ${totalTests}`);
console.log(`Passed: ${passedTests}`);
console.log(`Pass rate: ${(passedTests/totalTests*100).toFixed(1)}%`);
console.log(`Status: ${passedTests/totalTests >= 0.7 ? '✅ Anthropic token counts are accurate' : '⚠️ Parameters need adjustment'}`);

// Compare different model types
console.log('\n' + '='.repeat(60));
console.log('Model type comparison');
console.log('='.repeat(60));

const testText = 'Artificial Intelligence and \u4eba\u5de5\u667a\u80fd are changing the world!';
console.log(`Test text: "${testText}"`);
console.log(`Text length: ${testText.length} characters\n`);

const models = [
  { name: 'OpenAI (default)', model: 'openai' },
  { name: 'Anthropic (Claude)', model: 'anthropic' },
  { name: 'GLM (Zhipu)', model: 'common' },
  { name: 'Claude Sonnet 4', model: 'claude-sonnet-4-20250514' },
  { name: 'GPT-5 (Claude backend)', model: 'gpt-5-2025-08-07' }
];

for (const { name, model } of models) {
  const tokens = countTextTokens(testText, model);
  console.log(`${name}: ${tokens} tokens`);
}

console.log('\nNotes:');
console.log('- Anthropic estimates slightly more tokens for Chinese text (about 1.2 tokens per character)');
console.log('- The GPT-5 family uses the Claude backend and the same counting method');
console.log('- General-purpose models such as GLM use the standard counting method');
console.log('- Images use more tokens with Anthropic (about 2,000 per image)');
