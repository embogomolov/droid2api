/**
 * Token counting accuracy tests
 *
 * Check whether the new token counting algorithm is more accurate than the old one
 * Compare the token counts reported by the API with our calculated counts
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { 
  countTextTokens, 
  countMessagesTokens,
  estimateRequestTokens 
} from '../utils/token-counter.js';
import { logInfo, logDebug, logError } from '../logger.js';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const API_ACCESS_KEY = process.env.API_ACCESS_KEY;

// Test case
const TEST_CASES = [
  {
    name: 'Simple English text',
    messages: [
      { role: 'user', content: 'Hello, how are you today?' }
    ],
    model: 'gpt-3.5-turbo'
  },
  {
    name: 'Chinese text',
    messages: [
      { role: 'user', content: '\u4f60\u597d\uff0c\u4eca\u5929\u5929\u6c14\u600e\u4e48\u6837\uff1f\u8bf7\u8be6\u7ec6\u63cf\u8ff0\u4e00\u4e0b\u3002' }
    ],
    model: 'gpt-3.5-turbo'
  },
  {
    name: 'Long mixed Chinese and English text',
    messages: [
      {
        role: 'system',
        content: '\u4f60\u662f\u4e00\u4e2ahelpful assistant\uff0c\u8bf7\u7528\u4e2d\u6587\u56de\u7b54\u7528\u6237\u7684\u95ee\u9898\u3002'
      },
      {
        role: 'user',
        content: `Please explain the concept of machine learning in Chinese. 
        \u673a\u5668\u5b66\u4e60\u662f\u4eba\u5de5\u667a\u80fd\u7684\u4e00\u4e2a\u5206\u652f\uff0c\u5b83\u4f7f\u8ba1\u7b97\u673a\u7cfb\u7edf\u80fd\u591f\u4ece\u6570\u636e\u4e2d\u5b66\u4e60\u548c\u6539\u8fdb\uff0c
        \u800c\u65e0\u9700\u8fdb\u884c\u660e\u786e\u7684\u7f16\u7a0b\u3002Machine learning algorithms build a model based on sample data,
        known as training data, in order to make predictions or decisions.`
      }
    ],
    model: 'gpt-4'
  },
  {
    name: 'Message containing code',
    messages: [
      {
        role: 'user',
        content: `\u8bf7\u89e3\u91ca\u8fd9\u6bb5\u4ee3\u7801\uff1a
\`\`\`javascript
function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
console.log(fibonacci(10));
\`\`\`
\u8fd9\u662f\u4e00\u4e2a\u9012\u5f52\u5b9e\u73b0\u7684\u6590\u6ce2\u90a3\u5951\u6570\u5217\u51fd\u6570\u3002`
      }
    ],
    model: 'gpt-4'
  },
  {
    name: 'Multi-turn conversation',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is artificial intelligence?' },
      { role: 'assistant', content: 'Artificial Intelligence (AI) refers to the simulation of human intelligence in machines that are programmed to think and learn.' },
      { role: 'user', content: 'Can you give me some examples?' },
      { role: 'assistant', content: 'Sure! Examples include virtual assistants like Siri, recommendation systems on Netflix, self-driving cars, and ChatGPT.' },
      { role: 'user', content: 'How does machine learning relate to AI?' }
    ],
    model: 'gpt-3.5-turbo'
  }
];

/**
 * Call the API to get the actual token usage
 */
async function getActualTokenCount(messages, model) {
  try {
    const response = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_ACCESS_KEY}`
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 10, // Keep max_tokens low to reduce usage
        temperature: 0
      })
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    return data.usage || null;
  } catch (error) {
    logError('API call failed', error);
    return null;
  }
}

/**
 * Run tests
 */
async function runTests() {
  logInfo('========================================');
  logInfo('Token counting accuracy tests');
  logInfo('========================================\n');

  if (!API_ACCESS_KEY) {
    logError('Set the API_ACCESS_KEY environment variable');
    process.exit(1);
  }

  const results = [];
  
  for (const testCase of TEST_CASES) {
    logInfo(`\nTest case: ${testCase.name}`);
    logInfo(`Model: ${testCase.model}`);
    logInfo('-'.repeat(40));

    // Calculate tokens with the new algorithm
    const calculatedTokens = countMessagesTokens(testCase.messages, testCase.model);
    logInfo(`Calculated input tokens: ${calculatedTokens}`);

    // Get the actual token count if available
    const actualUsage = await getActualTokenCount(testCase.messages, testCase.model);
    
    if (actualUsage) {
      const actualInputTokens = actualUsage.prompt_tokens;
      const difference = Math.abs(actualInputTokens - calculatedTokens);
      const percentDiff = actualInputTokens > 0 
        ? (difference / actualInputTokens * 100).toFixed(1)
        : 0;

      logInfo(`Actual input tokens: ${actualInputTokens}`);
      logInfo(`Difference: ${difference} tokens (${percentDiff}%)`);
      
      // Assess accuracy
      const isAccurate = percentDiff <= 10; // Consider an error of 10% or less accurate
      logInfo(`Accuracy: ${isAccurate ? '✅ Passed' : '❌ Inaccurate'}`);

      results.push({
        testCase: testCase.name,
        model: testCase.model,
        calculated: calculatedTokens,
        actual: actualInputTokens,
        difference,
        percentDiff: parseFloat(percentDiff),
        accurate: isAccurate
      });
    } else {
      logInfo('⚠️ Actual token count unavailable (API call failed or did not return usage)');
      
      // Record only the calculated count
      results.push({
        testCase: testCase.name,
        model: testCase.model,
        calculated: calculatedTokens,
        actual: null,
        difference: null,
        percentDiff: null,
        accurate: null
      });
    }
  }

  // Print the summary
  logInfo('\n========================================');
  logInfo('Test summary');
  logInfo('========================================\n');

  const validResults = results.filter(r => r.actual !== null);
  
  if (validResults.length > 0) {
    const accurateCount = validResults.filter(r => r.accurate).length;
    const avgDiff = validResults.reduce((sum, r) => sum + r.percentDiff, 0) / validResults.length;
    
    logInfo(`Total tests: ${results.length}`);
    logInfo(`Tests with actual usage data: ${validResults.length}`);
    logInfo(`Accurate estimates: ${accurateCount}/${validResults.length}`);
    logInfo(`Average error: ${avgDiff.toFixed(1)}%`);
    logInfo(`Accuracy rate: ${(accurateCount / validResults.length * 100).toFixed(1)}%`);
  } else {
    logInfo('No test returned an actual token count, so accuracy cannot be calculated');
  }

  // Test other features
  logInfo('\n========================================');
  logInfo('Other feature tests');
  logInfo('========================================\n');

  // Test plain-text token counting
  const testTexts = [
    { text: 'Hello world', expected: 2 },
    { text: '\u4f60\u597d\u4e16\u754c', expected: 4 },
    { text: 'AI and \u673a\u5668\u5b66\u4e60 are fascinating!', expected: 8 }
  ];

  for (const test of testTexts) {
    const tokens = countTextTokens(test.text);
    logInfo(`Text: "${test.text}"`);
    logInfo(`Calculated tokens: ${tokens}, Expected range: ${test.expected - 2} ~ ${test.expected + 2}`);
  }

  // Test request token estimation
  const sampleRequest = {
    messages: [
      { role: 'user', content: 'Write a short story about AI.' }
    ],
    max_tokens: 500
  };

  const estimate = estimateRequestTokens(sampleRequest, 'gpt-3.5-turbo');
  logInfo('\nRequest token estimate:');
  logInfo(`Estimated input tokens: ${estimate.estimated_prompt_tokens}`);
  logInfo(`Estimated output tokens: ${estimate.estimated_completion_tokens}`);
  logInfo(`Estimated total tokens: ${estimate.estimated_total_tokens}`);
}

// Run tests
runTests().catch(error => {
  logError('Test failed', error);
  process.exit(1);
});
