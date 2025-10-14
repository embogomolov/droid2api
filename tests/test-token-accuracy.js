/**
 * Token计算算法准确性测试
 * 测试新的token计算算法的准确性（不依赖API）
 */

import { 
  countTextTokens, 
  countMessagesTokens
} from '../utils/token-counter.js';

console.log('========================================');
console.log('Token计算算法准确性测试');
console.log('========================================\n');

// 测试用例和预期值（基于OpenAI官方文档的估算）
const TEST_CASES = [
  {
    name: '简单英文',
    text: 'Hello world',
    expectedTokens: 2,
    tolerance: 1
  },
  {
    name: '中文短句',
    text: '你好世界',
    expectedTokens: 4,
    tolerance: 1
  },
  {
    name: '英文句子',
    text: 'The quick brown fox jumps over the lazy dog',
    expectedTokens: 9,
    tolerance: 2
  },
  {
    name: '中文句子',
    text: '人工智能是计算机科学的一个分支',
    expectedTokens: 15,
    tolerance: 3
  },
  {
    name: '混合文本',
    text: 'AI（人工智能）is changing the world 改变世界',
    expectedTokens: 12,
    tolerance: 3
  },
  {
    name: '代码片段',
    text: 'function hello() { console.log("Hello World"); }',
    expectedTokens: 12,
    tolerance: 3
  },
  {
    name: '长英文段落',
    text: `Artificial Intelligence (AI) refers to the simulation of human intelligence in machines 
    that are programmed to think and learn like humans. The term may also be applied to any machine 
    that exhibits traits associated with a human mind such as learning and problem-solving.`,
    expectedTokens: 50,
    tolerance: 10
  },
  {
    name: '长中文段落',
    text: `人工智能是计算机科学的一个分支，它企图了解智能的实质，并生产出一种新的能以人类智能相似的方式
    做出反应的智能机器。该领域的研究包括机器人、语言识别、图像识别、自然语言处理和专家系统等。`,
    expectedTokens: 90,
    tolerance: 15
  }
];

console.log('纯文本Token计算测试：');
console.log('-'.repeat(60));

let passedTests = 0;
let totalTests = TEST_CASES.length;

for (const testCase of TEST_CASES) {
  const calculatedTokens = countTextTokens(testCase.text, 'gpt-3.5-turbo');
  const difference = Math.abs(calculatedTokens - testCase.expectedTokens);
  const passed = difference <= testCase.tolerance;
  
  console.log(`\n测试: ${testCase.name}`);
  console.log(`文本长度: ${testCase.text.length} 字符`);
  console.log(`计算tokens: ${calculatedTokens}`);
  console.log(`预期tokens: ${testCase.expectedTokens} (±${testCase.tolerance})`);
  console.log(`结果: ${passed ? '✅ 通过' : '❌ 失败'} (差异: ${difference})`);
  
  if (passed) passedTests++;
}

console.log('\n' + '='.repeat(60));
console.log(`测试结果: ${passedTests}/${totalTests} 通过 (${(passedTests/totalTests*100).toFixed(1)}%)`);

// 测试消息列表
console.log('\n\n消息列表Token计算测试：');
console.log('-'.repeat(60));

const MESSAGE_TESTS = [
  {
    name: '单条消息',
    messages: [
      { role: 'user', content: 'Hello, how are you?' }
    ],
    expectedTokens: 12,  // 包括格式开销
    tolerance: 3
  },
  {
    name: '系统消息+用户消息',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is AI?' }
    ],
    expectedTokens: 20,
    tolerance: 5
  },
  {
    name: '多轮对话',
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello! How can I help you today?' },
      { role: 'user', content: 'Tell me about machine learning' }
    ],
    expectedTokens: 30,
    tolerance: 8
  },
  {
    name: '中文对话',
    messages: [
      { role: 'system', content: '你是一个有帮助的助手' },
      { role: 'user', content: '什么是机器学习？' }
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
  
  console.log(`\n测试: ${test.name}`);
  console.log(`消息数: ${test.messages.length}`);
  console.log(`计算tokens: ${calculatedTokens}`);
  console.log(`预期tokens: ${test.expectedTokens} (±${test.tolerance})`);
  console.log(`结果: ${passed ? '✅ 通过' : '❌ 失败'} (差异: ${difference})`);
  
  if (passed) passedMessageTests++;
}

console.log('\n' + '='.repeat(60));
console.log(`消息测试结果: ${passedMessageTests}/${totalMessageTests} 通过 (${(passedMessageTests/totalMessageTests*100).toFixed(1)}%)`);

// 总体结果
const totalPassed = passedTests + passedMessageTests;
const totalCount = totalTests + totalMessageTests;

console.log('\n' + '='.repeat(60));
console.log('总体测试结果');
console.log('='.repeat(60));
console.log(`通过: ${totalPassed}/${totalCount}`);
console.log(`通过率: ${(totalPassed/totalCount*100).toFixed(1)}%`);
console.log(`状态: ${totalPassed/totalCount >= 0.8 ? '✅ 算法准确性良好' : '⚠️ 算法需要改进'}`);

// 对比说明
console.log('\n' + '='.repeat(60));
console.log('算法改进说明');
console.log('='.repeat(60));
console.log('新算法的改进点：');
console.log('1. 区分中英文字符，中文字符约2 tokens/字符');
console.log('2. 英文按单词计算，约1.3 tokens/单词');
console.log('3. 添加消息格式开销（每条消息4 tokens）');
console.log('4. 支持多模态内容（图片、工具调用等）');
console.log('5. 添加5%缓冲区确保不低估');
console.log('\n相比原算法：');
console.log('- 原算法：简单的字符数计算，误差较大');
console.log('- 新算法：考虑语言特性和格式开销，更接近实际值');
