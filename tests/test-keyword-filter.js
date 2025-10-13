import keywordFilter from '../utils/keyword-filter.js';

console.log('=== 关键词过滤器测试 ===\n');

// 测试1：基本文本过滤
console.log('测试1：基本文本过滤');
const text1 = '这是一个包含xx关键词的测试文本';
const filtered1 = keywordFilter.filterText(text1, 'test');
console.log(`原文: ${text1}`);
console.log(`过滤后: ${filtered1}\n`);

// 测试2：system 消息过滤
console.log('测试2：system 消息过滤');
const messages = [
  { role: 'system', content: '你是一个助手，不要提到xx' },
  { role: 'user', content: '请帮我处理xx相关的问题' }
];
const filteredMessages = keywordFilter.filterMessages(messages);
console.log('原始消息:');
console.log(JSON.stringify(messages, null, 2));
console.log('过滤后消息:');
console.log(JSON.stringify(filteredMessages, null, 2));
console.log();

// 测试3：请求体过滤
console.log('测试3：完整请求体过滤');
const request = {
  model: 'claude-sonnet-4',
  system: '你是一个AI助手，不要提到xx',
  messages: [
    { role: 'user', content: '告诉我关于xx的信息' },
    { role: 'assistant', content: '我会帮你处理' },
    { role: 'user', content: '这里有xx关键词' }
  ],
  max_tokens: 4096
};
const filteredRequest = keywordFilter.filterRequest(request);
console.log('原始请求:');
console.log(JSON.stringify(request, null, 2));
console.log('过滤后请求:');
console.log(JSON.stringify(filteredRequest, null, 2));
console.log();

// 测试4：统计信息
console.log('测试4：过滤器统计信息');
const stats = keywordFilter.getStats();
console.log(JSON.stringify(stats, null, 2));
console.log();

// 测试5：复杂内容块过滤
console.log('测试5：复杂内容块过滤');
const complexMessages = [
  {
    role: 'system',
    content: [
      { type: 'text', text: '系统提示：不要讨论xx' },
      { type: 'text', text: '这里还有xx相关内容' }
    ]
  },
  {
    role: 'user',
    content: [
      { type: 'text', text: '用户问题包含xx' },
      { type: 'image', source: { url: 'https://example.com/image.jpg' } }
    ]
  }
];
const filteredComplexMessages = keywordFilter.filterMessages(complexMessages);
console.log('原始复杂消息:');
console.log(JSON.stringify(complexMessages, null, 2));
console.log('过滤后复杂消息:');
console.log(JSON.stringify(filteredComplexMessages, null, 2));
console.log();

console.log('=== 测试完成 ===');
