/**
 * BaSui：测试 403 错误日志记录功能
 * 
 * 使用方法：
 * node tests/test-403-logger.js
 */

import { log403Error } from '../utils/error-403-logger.js';

// 模拟一个 OpenAI 格式的请求
const mockOpenAIRequest = {
  model: "claude-sonnet-4-5-20250929",
  stream: true,
  messages: [
    {
      role: "system",
      content: "You are Droid, an AI software engineering agent built by Factory."
    },
    {
      role: "user",
      content: "Write a function to calculate fibonacci numbers"
    },
    {
      role: "assistant",
      content: "Here's a fibonacci function:\n\n```javascript\nfunction fib(n) {\n  if (n <= 1) return n;\n  return fib(n-1) + fib(n-2);\n}\n```"
    },
    {
      role: "user",
      content: "Can you optimize it with memoization?"
    }
  ],
  temperature: 0.7,
  max_tokens: 2000
};

// 模拟一个 Anthropic 格式的请求
const mockAnthropicRequest = {
  model: "claude-sonnet-4-5-20250929",
  stream: false,
  system: [
    {
      type: "text",
      text: "You are Droid, an AI software engineering agent built by Factory."
    }
  ],
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Explain how binary search works"
        }
      ]
    }
  ],
  max_tokens: 1024,
  thinking: {
    type: "enabled",
    budget_tokens: 12288
  }
};

// 模拟请求头
const mockHeaders = {
  "authorization": "Bearer FAKE-KEY-FOR-TESTING-ONLY",
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
  "x-factory-client": "droid2api/1.4.1",
  "x-session-id": "session-test-12345",
  "user-agent": "droid2api-test"
};

console.log('开始测试 403 错误日志记录功能...\n');

// 测试 1: OpenAI 格式请求的 403 错误
console.log('【测试 1】记录 OpenAI 格式请求的 403 错误');
log403Error({
  requestId: 'req-test-001',
  keyId: 'TEST-KEY-ID-001',
  originalRequest: mockOpenAIRequest,
  transformedRequest: mockAnthropicRequest, // 转换后的格式
  headers: mockHeaders,
  endpoint: 'https://api.factory.ai/v1/messages',
  errorDetails: JSON.stringify({
    error: {
      type: "permission_error",
      message: "Your API key does not have permission to use the specified model."
    }
  }, null, 2)
});

console.log('✓ 测试 1 完成\n');

// 测试 2: Anthropic 格式请求的 403 错误
console.log('【测试 2】记录 Anthropic 格式请求的 403 错误');
log403Error({
  requestId: 'req-test-002',
  keyId: 'TEST-KEY-ID-002',
  originalRequest: mockAnthropicRequest,
  transformedRequest: mockAnthropicRequest,
  headers: mockHeaders,
  endpoint: 'https://api.factory.ai/v1/messages',
  errorDetails: JSON.stringify({
    error: {
      type: "authentication_error",
      message: "Invalid API key or insufficient permissions."
    }
  }, null, 2)
});

console.log('✓ 测试 2 完成\n');

// 测试 3: 复杂消息历史的 403 错误
console.log('【测试 3】记录复杂消息历史的 403 错误');
const complexRequest = {
  model: "claude-sonnet-4-5-20250929",
  stream: true,
  messages: [
    {
      role: "user",
      content: "Hello, can you help me with a coding problem?"
    },
    {
      role: "assistant",
      content: "Of course! I'd be happy to help. What coding problem are you working on?"
    },
    {
      role: "user",
      content: "I need to implement a REST API with rate limiting. Can you show me how?"
    },
    {
      role: "assistant",
      content: "Sure! Here's a simple rate limiting middleware for Express.js:\n\n```javascript\nconst rateLimit = {};\n\nfunction rateLimiter(req, res, next) {\n  const ip = req.ip;\n  const now = Date.now();\n  \n  if (!rateLimit[ip]) {\n    rateLimit[ip] = { count: 1, resetTime: now + 60000 };\n  } else if (now > rateLimit[ip].resetTime) {\n    rateLimit[ip] = { count: 1, resetTime: now + 60000 };\n  } else {\n    rateLimit[ip].count++;\n    if (rateLimit[ip].count > 100) {\n      return res.status(429).json({ error: 'Too many requests' });\n    }\n  }\n  \n  next();\n}\n```"
    },
    {
      role: "user",
      content: "Can you also add Redis support for distributed rate limiting?"
    }
  ],
  temperature: 0.8,
  max_tokens: 4096
};

log403Error({
  requestId: 'req-test-003',
  keyId: 'TEST-KEY-ID-003',
  originalRequest: complexRequest,
  transformedRequest: complexRequest,
  headers: mockHeaders,
  endpoint: 'https://api.factory.ai/v1/messages',
  errorDetails: 'HTTP 403 Forbidden: Model access denied for your organization'
});

console.log('✓ 测试 3 完成\n');

console.log('='.repeat(80));
console.log('所有测试完成！');
console.log('='.repeat(80));
console.log('\n请查看日志文件：logs/403_errors.log\n');
console.log('日志文件包含：');
console.log('  - 请求ID、密钥ID、端点等基本信息');
console.log('  - 系统提示词（从 system 字段或 messages 中提取）');
console.log('  - 用户提示词（所有 user role 的消息）');
console.log('  - 完整消息历史（便于调试）');
console.log('  - 转换后的请求（如果有格式转换）');
console.log('  - 请求头信息（密钥已脱敏）');
console.log('  - 错误详情\n');
