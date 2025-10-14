/**
 * Token计算准确性测试
 * 
 * 验证新的token计算算法是否比旧算法更准确
 * 对比实际API返回的token数量和我们计算的token数量
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

// 加载环境变量
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const API_ACCESS_KEY = process.env.API_ACCESS_KEY;

// 测试用例
const TEST_CASES = [
  {
    name: '简单英文文本',
    messages: [
      { role: 'user', content: 'Hello, how are you today?' }
    ],
    model: 'gpt-3.5-turbo'
  },
  {
    name: '中文文本',
    messages: [
      { role: 'user', content: '你好，今天天气怎么样？请详细描述一下。' }
    ],
    model: 'gpt-3.5-turbo'
  },
  {
    name: '混合中英文长文本',
    messages: [
      {
        role: 'system',
        content: '你是一个helpful assistant，请用中文回答用户的问题。'
      },
      {
        role: 'user',
        content: `Please explain the concept of machine learning in Chinese. 
        机器学习是人工智能的一个分支，它使计算机系统能够从数据中学习和改进，
        而无需进行明确的编程。Machine learning algorithms build a model based on sample data,
        known as training data, in order to make predictions or decisions.`
      }
    ],
    model: 'gpt-4'
  },
  {
    name: '包含代码的消息',
    messages: [
      {
        role: 'user',
        content: `请解释这段代码：
\`\`\`javascript
function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
console.log(fibonacci(10));
\`\`\`
这是一个递归实现的斐波那契数列函数。`
      }
    ],
    model: 'gpt-4'
  },
  {
    name: '多轮对话',
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
 * 调用实际API获取真实的token使用量
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
        max_tokens: 10, // 设置很小的max_tokens以减少消耗
        temperature: 0
      })
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    return data.usage || null;
  } catch (error) {
    logError('调用API失败', error);
    return null;
  }
}

/**
 * 运行测试
 */
async function runTests() {
  logInfo('========================================');
  logInfo('Token计算准确性测试');
  logInfo('========================================\n');

  if (!API_ACCESS_KEY) {
    logError('请设置 API_ACCESS_KEY 环境变量');
    process.exit(1);
  }

  const results = [];
  
  for (const testCase of TEST_CASES) {
    logInfo(`\n测试用例: ${testCase.name}`);
    logInfo(`模型: ${testCase.model}`);
    logInfo('-'.repeat(40));

    // 使用新算法计算tokens
    const calculatedTokens = countMessagesTokens(testCase.messages, testCase.model);
    logInfo(`计算的input tokens: ${calculatedTokens}`);

    // 获取实际的token数量（如果可能）
    const actualUsage = await getActualTokenCount(testCase.messages, testCase.model);
    
    if (actualUsage) {
      const actualInputTokens = actualUsage.prompt_tokens;
      const difference = Math.abs(actualInputTokens - calculatedTokens);
      const percentDiff = actualInputTokens > 0 
        ? (difference / actualInputTokens * 100).toFixed(1)
        : 0;

      logInfo(`实际的input tokens: ${actualInputTokens}`);
      logInfo(`差异: ${difference} tokens (${percentDiff}%)`);
      
      // 判断准确性
      const isAccurate = percentDiff <= 10; // 10%以内认为准确
      logInfo(`准确性: ${isAccurate ? '✅ 通过' : '❌ 不准确'}`);

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
      logInfo('⚠️ 无法获取实际token数量（API调用失败或未返回usage）');
      
      // 仅记录计算值
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

  // 输出总结
  logInfo('\n========================================');
  logInfo('测试总结');
  logInfo('========================================\n');

  const validResults = results.filter(r => r.actual !== null);
  
  if (validResults.length > 0) {
    const accurateCount = validResults.filter(r => r.accurate).length;
    const avgDiff = validResults.reduce((sum, r) => sum + r.percentDiff, 0) / validResults.length;
    
    logInfo(`总测试数: ${results.length}`);
    logInfo(`有效测试数: ${validResults.length}`);
    logInfo(`准确测试数: ${accurateCount}/${validResults.length}`);
    logInfo(`平均误差: ${avgDiff.toFixed(1)}%`);
    logInfo(`准确率: ${(accurateCount / validResults.length * 100).toFixed(1)}%`);
  } else {
    logInfo('所有测试都无法获取实际token数量，无法计算准确率');
  }

  // 测试其他功能
  logInfo('\n========================================');
  logInfo('其他功能测试');
  logInfo('========================================\n');

  // 测试纯文本token计算
  const testTexts = [
    { text: 'Hello world', expected: 2 },
    { text: '你好世界', expected: 4 },
    { text: 'AI and 机器学习 are fascinating!', expected: 8 }
  ];

  for (const test of testTexts) {
    const tokens = countTextTokens(test.text);
    logInfo(`文本: "${test.text}"`);
    logInfo(`计算tokens: ${tokens}, 预期范围: ${test.expected - 2} ~ ${test.expected + 2}`);
  }

  // 测试请求预估
  const sampleRequest = {
    messages: [
      { role: 'user', content: 'Write a short story about AI.' }
    ],
    max_tokens: 500
  };

  const estimate = estimateRequestTokens(sampleRequest, 'gpt-3.5-turbo');
  logInfo('\n请求token预估:');
  logInfo(`输入tokens预估: ${estimate.estimated_prompt_tokens}`);
  logInfo(`输出tokens预估: ${estimate.estimated_completion_tokens}`);
  logInfo(`总tokens预估: ${estimate.estimated_total_tokens}`);
}

// 运行测试
runTests().catch(error => {
  logError('测试失败', error);
  process.exit(1);
});
