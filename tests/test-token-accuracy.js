/**
 * Token counting algorithm accuracy tests
 * Test the new token counting algorithm without making API calls
 */

import { 
  countTextTokens, 
  countMessagesTokens
} from '../utils/token-counter.js';

console.log('========================================');
console.log('Token counting algorithm accuracy tests');
console.log('========================================\n');

// Test cases and expected values (estimates based on the OpenAI documentation)
const TEST_CASES = [
  {
    name: 'Simple English',
    text: 'Hello world',
    expectedTokens: 2,
    tolerance: 1
  },
  {
    name: 'Short Chinese phrase',
    text: '\u4f60\u597d\u4e16\u754c',
    expectedTokens: 4,
    tolerance: 1
  },
  {
    name: 'English sentence',
    text: 'The quick brown fox jumps over the lazy dog',
    expectedTokens: 9,
    tolerance: 2
  },
  {
    name: 'Chinese sentence',
    text: '\u4eba\u5de5\u667a\u80fd\u662f\u8ba1\u7b97\u673a\u79d1\u5b66\u7684\u4e00\u4e2a\u5206\u652f',
    expectedTokens: 15,
    tolerance: 3
  },
  {
    name: 'Mixed-language text',
    text: 'AI\uff08\u4eba\u5de5\u667a\u80fd\uff09is changing the world \u6539\u53d8\u4e16\u754c',
    expectedTokens: 12,
    tolerance: 3
  },
  {
    name: 'Code snippet',
    text: 'function hello() { console.log("Hello World"); }',
    expectedTokens: 12,
    tolerance: 3
  },
  {
    name: 'Long English paragraph',
    text: `Artificial Intelligence (AI) refers to the simulation of human intelligence in machines 
    that are programmed to think and learn like humans. The term may also be applied to any machine 
    that exhibits traits associated with a human mind such as learning and problem-solving.`,
    expectedTokens: 50,
    tolerance: 10
  },
  {
    name: 'Long Chinese paragraph',
    text: `\u4eba\u5de5\u667a\u80fd\u662f\u8ba1\u7b97\u673a\u79d1\u5b66\u7684\u4e00\u4e2a\u5206\u652f\uff0c\u5b83\u4f01\u56fe\u4e86\u89e3\u667a\u80fd\u7684\u5b9e\u8d28\uff0c\u5e76\u751f\u4ea7\u51fa\u4e00\u79cd\u65b0\u7684\u80fd\u4ee5\u4eba\u7c7b\u667a\u80fd\u76f8\u4f3c\u7684\u65b9\u5f0f
    \u505a\u51fa\u53cd\u5e94\u7684\u667a\u80fd\u673a\u5668\u3002\u8be5\u9886\u57df\u7684\u7814\u7a76\u5305\u62ec\u673a\u5668\u4eba\u3001\u8bed\u8a00\u8bc6\u522b\u3001\u56fe\u50cf\u8bc6\u522b\u3001\u81ea\u7136\u8bed\u8a00\u5904\u7406\u548c\u4e13\u5bb6\u7cfb\u7edf\u7b49\u3002`,
    expectedTokens: 90,
    tolerance: 15
  }
];

console.log('Plain-text token counting tests:');
console.log('-'.repeat(60));

let passedTests = 0;
let totalTests = TEST_CASES.length;

for (const testCase of TEST_CASES) {
  const calculatedTokens = countTextTokens(testCase.text, 'gpt-3.5-turbo');
  const difference = Math.abs(calculatedTokens - testCase.expectedTokens);
  const passed = difference <= testCase.tolerance;
  
  console.log(`\nTest: ${testCase.name}`);
  console.log(`Text length: ${testCase.text.length} characters`);
  console.log(`Calculated tokens: ${calculatedTokens}`);
  console.log(`Expected tokens: ${testCase.expectedTokens} (±${testCase.tolerance})`);
  console.log(`Result: ${passed ? '✅ Passed' : '❌ Failed'} (Difference: ${difference})`);
  
  if (passed) passedTests++;
}

console.log('\n' + '='.repeat(60));
console.log(`Test results: ${passedTests}/${totalTests} Passed (${(passedTests/totalTests*100).toFixed(1)}%)`);

// Test message lists
console.log('\n\nMessage-list token counting tests:');
console.log('-'.repeat(60));

const MESSAGE_TESTS = [
  {
    name: 'Single message',
    messages: [
      { role: 'user', content: 'Hello, how are you?' }
    ],
    expectedTokens: 12,  // Includes message formatting overhead
    tolerance: 3
  },
  {
    name: 'System and user messages',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is AI?' }
    ],
    expectedTokens: 20,
    tolerance: 5
  },
  {
    name: 'Multi-turn conversation',
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello! How can I help you today?' },
      { role: 'user', content: 'Tell me about machine learning' }
    ],
    expectedTokens: 30,
    tolerance: 8
  },
  {
    name: 'Chinese conversation',
    messages: [
      { role: 'system', content: '\u4f60\u662f\u4e00\u4e2a\u6709\u5e2e\u52a9\u7684\u52a9\u624b' },
      { role: 'user', content: '\u4ec0\u4e48\u662f\u673a\u5668\u5b66\u4e60\uff1f' }
    ],
    expectedTokens: 25,
    tolerance: 5
  }
];

let passedMessageTests = 0;
let totalMessageTests = MESSAGE_TESTS.length;

for (const test of MESSAGE_TESTS) {
  const calculatedTokens = countMessagesTokens(test.messages, 'gpt-3.5-turbo');
  const difference = Math.abs(calculatedTokens - test.expectedTokens);
  const passed = difference <= test.tolerance;
  
  console.log(`\nTest: ${test.name}`);
  console.log(`Message count: ${test.messages.length}`);
  console.log(`Calculated tokens: ${calculatedTokens}`);
  console.log(`Expected tokens: ${test.expectedTokens} (±${test.tolerance})`);
  console.log(`Result: ${passed ? '✅ Passed' : '❌ Failed'} (Difference: ${difference})`);
  
  if (passed) passedMessageTests++;
}

console.log('\n' + '='.repeat(60));
console.log(`Message test results: ${passedMessageTests}/${totalMessageTests} Passed (${(passedMessageTests/totalMessageTests*100).toFixed(1)}%)`);

// Overall results
const totalPassed = passedTests + passedMessageTests;
const totalCount = totalTests + totalMessageTests;

console.log('\n' + '='.repeat(60));
console.log('Overall test results');
console.log('='.repeat(60));
console.log(`Passed: ${totalPassed}/${totalCount}`);
console.log(`Pass rate: ${(totalPassed/totalCount*100).toFixed(1)}%`);
console.log(`Status: ${totalPassed/totalCount >= 0.8 ? '✅ Algorithm accuracy is satisfactory' : '⚠️ Algorithm needs improvement'}`);

// Comparison notes
console.log('\n' + '='.repeat(60));
console.log('Algorithm improvements');
console.log('='.repeat(60));
console.log('Improvements in the new algorithm:');
console.log('1. Distinguishes Chinese and English characters; estimates about 2 tokens per Chinese character');
console.log('2. Counts English words at about 1.3 tokens per word');
console.log('3. Adds message formatting overhead (4 tokens per message)');
console.log('4. Supports multimodal content (images, tool calls, etc.)');
console.log('5. Adds a 5% buffer to avoid underestimating');
console.log('\nCompared with the old algorithm:');
console.log('- Old algorithm: simple character counting with larger errors');
console.log('- New algorithm: accounts for language and formatting overhead for a closer estimate');
