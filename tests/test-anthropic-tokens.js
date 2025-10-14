/**
 * Anthropic (Claude) Token计算测试
 * 验证针对Anthropic模型的token计算准确性
 */

import { 
  countTextTokens, 
  countMessagesTokens,
  estimateRequestTokens
} from '../utils/token-counter.js';

console.log('========================================');
console.log('Anthropic (Claude) Token计算测试');
console.log('========================================\n');

// Claude模型的测试用例
const CLAUDE_TEST_CASES = [
  {
    name: 'Claude简单英文',
    model: 'claude-sonnet-4-5-20250929',
    text: 'Hello, Claude!',
    expectedTokens: 4,
    tolerance: 1
  },
  {
    name: 'Claude中文句子',
    model: 'claude-sonnet-4-20250514',
    text: '请用中文回答我的问题',
    expectedTokens: 12,
    tolerance: 2
  },
  {
    name: 'Claude混合文本',
    model: 'anthropic',
    text: 'Claude是Anthropic开发的AI助手，支持多语言对话',
    expectedTokens: 22,
    tolerance: 4
  },
  {
    name: 'Claude代码分析',
    model: 'claude-sonnet-4-5-20250929',
    text: 'function calculate(x, y) { return x + y; }',
    expectedTokens: 14,
    tolerance: 3
  }
];

// GPT-5（实际是Claude后端）的测试
const GPT5_TEST_CASES = [
  {
    name: 'GPT-5简单测试',
    model: 'gpt-5-2025-08-07',
    text: 'This is GPT-5 model test',
    expectedTokens: 7,
    tolerance: 2
  },
  {
    name: 'GPT-5-Codex代码',
    model: 'gpt-5-codex',
    text: 'def hello(): print("Hello World")',
    expectedTokens: 10,
    tolerance: 2
  }
];

// GLM模型测试
const GLM_TEST_CASES = [
  {
    name: 'GLM-4.6中文',
    model: 'glm-4.6',
    text: '智谱清言是中国的大语言模型',
    expectedTokens: 13,
    tolerance: 3
  }
];

console.log('1. Claude模型文本Token计算测试');
console.log('-'.repeat(50));

let passedTests = 0;
let totalTests = 0;

// 测试Claude模型
for (const test of CLAUDE_TEST_CASES) {
  const tokens = countTextTokens(test.text, test.model);
  const diff = Math.abs(tokens - test.expectedTokens);
  const passed = diff <= test.tolerance;
  
  console.log(`\n测试: ${test.name}`);
  console.log(`模型: ${test.model}`);
  console.log(`文本: "${test.text}"`);
  console.log(`计算tokens: ${tokens}`);
  console.log(`预期tokens: ${test.expectedTokens} (±${test.tolerance})`);
  console.log(`结果: ${passed ? '✅ 通过' : '❌ 失败'} (差异: ${diff})`);
  
  totalTests++;
  if (passed) passedTests++;
}

// 测试GPT-5（Claude后端）
console.log('\n\n2. GPT-5模型（Claude后端）Token计算测试');
console.log('-'.repeat(50));

for (const test of GPT5_TEST_CASES) {
  const tokens = countTextTokens(test.text, test.model);
  const diff = Math.abs(tokens - test.expectedTokens);
  const passed = diff <= test.tolerance;
  
  console.log(`\n测试: ${test.name}`);
  console.log(`模型: ${test.model}`);
  console.log(`文本: "${test.text}"`);
  console.log(`计算tokens: ${tokens}`);
  console.log(`预期tokens: ${test.expectedTokens} (±${test.tolerance})`);
  console.log(`结果: ${passed ? '✅ 通过' : '❌ 失败'} (差异: ${diff})`);
  
  totalTests++;
  if (passed) passedTests++;
}

// 测试GLM模型
console.log('\n\n3. GLM模型Token计算测试');
console.log('-'.repeat(50));

for (const test of GLM_TEST_CASES) {
  const tokens = countTextTokens(test.text, test.model);
  const diff = Math.abs(tokens - test.expectedTokens);
  const passed = diff <= test.tolerance;
  
  console.log(`\n测试: ${test.name}`);
  console.log(`模型: ${test.model}`);
  console.log(`文本: "${test.text}"`);
  console.log(`计算tokens: ${tokens}`);
  console.log(`预期tokens: ${test.expectedTokens} (±${test.tolerance})`);
  console.log(`结果: ${passed ? '✅ 通过' : '❌ 失败'} (差异: ${diff})`);
  
  totalTests++;
  if (passed) passedTests++;
}

// 测试消息格式
console.log('\n\n4. Anthropic Messages格式Token计算测试');
console.log('-'.repeat(50));

const MESSAGE_TESTS = [
  {
    name: 'Claude单条消息',
    model: 'claude-sonnet-4-5-20250929',
    messages: [
      { role: 'user', content: 'Hello Claude!' }
    ],
    expectedTokens: 12,
    tolerance: 3
  },
  {
    name: 'Claude多轮对话',
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
    name: 'Claude带工具使用',
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
  
  console.log(`\n测试: ${test.name}`);
  console.log(`模型: ${test.model}`);
  console.log(`消息数: ${test.messages.length}`);
  console.log(`计算tokens: ${tokens}`);
  console.log(`预期tokens: ${test.expectedTokens} (±${test.tolerance})`);
  console.log(`结果: ${passed ? '✅ 通过' : '❌ 失败'} (差异: ${diff})`);
  
  totalTests++;
  if (passed) passedTests++;
}

// 总结
console.log('\n' + '='.repeat(60));
console.log('测试总结');
console.log('='.repeat(60));
console.log(`总测试数: ${totalTests}`);
console.log(`通过数: ${passedTests}`);
console.log(`通过率: ${(passedTests/totalTests*100).toFixed(1)}%`);
console.log(`状态: ${passedTests/totalTests >= 0.7 ? '✅ Anthropic token计算准确' : '⚠️ 需要调整参数'}`);

// 对比不同模型类型
console.log('\n' + '='.repeat(60));
console.log('模型类型对比');
console.log('='.repeat(60));

const testText = 'Artificial Intelligence and 人工智能 are changing the world!';
console.log(`测试文本: "${testText}"`);
console.log(`文本长度: ${testText.length} 字符\n`);

const models = [
  { name: 'OpenAI (默认)', model: 'openai' },
  { name: 'Anthropic (Claude)', model: 'anthropic' },
  { name: 'GLM (智谱)', model: 'common' },
  { name: 'Claude Sonnet 4', model: 'claude-sonnet-4-20250514' },
  { name: 'GPT-5 (Claude后端)', model: 'gpt-5-2025-08-07' }
];

for (const { name, model } of models) {
  const tokens = countTextTokens(testText, model);
  console.log(`${name}: ${tokens} tokens`);
}

console.log('\n说明：');
console.log('- Anthropic模型对中文的token计算略高（约1.2 tokens/字符）');
console.log('- GPT-5系列使用Claude后端，采用相同的计算方式');
console.log('- GLM等通用模型使用标准计算方式');
console.log('- 图片在Anthropic中消耗更多tokens（约2000/张）');
