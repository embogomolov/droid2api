/**
 * BaSui: test HTTP 403 error logging
 *
 * Usage:
 * node tests/test-403-logger.js
 */

import { log403Error } from '../utils/error-403-logger.js';

// Mock an OpenAI-format request
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

// Mock an Anthropic-format request
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

// Mock request headers
const mockHeaders = {
  "authorization": "Bearer FAKE-KEY-FOR-TESTING-ONLY",
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
  "x-factory-client": "droid2api/1.4.1",
  "x-session-id": "session-test-12345",
  "user-agent": "droid2api-test"
};

console.log('Start testing HTTP 403 error logging...\n');

// Test 1: HTTP 403 error for an OpenAI-format request
console.log('[Test 1] Log an HTTP 403 error for an OpenAI-format request');
log403Error({
  requestId: 'req-test-001',
  keyId: 'TEST-KEY-ID-001',
  originalRequest: mockOpenAIRequest,
  transformedRequest: mockAnthropicRequest, // Transformed format
  headers: mockHeaders,
  endpoint: 'https://api.factory.ai/v1/messages',
  errorDetails: JSON.stringify({
    error: {
      type: "permission_error",
      message: "Your API key does not have permission to use the specified model."
    }
  }, null, 2)
});

console.log('✓ Test 1 complete\n');

// Test 2: HTTP 403 error for an Anthropic-format request
console.log('[Test 2] Log an HTTP 403 error for an Anthropic-format request');
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

console.log('✓ Test 2 complete\n');

// Test 3: HTTP 403 error with a complex message history
console.log('[Test 3] Log an HTTP 403 error with a complex message history');
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

console.log('✓ Test 3 complete\n');

console.log('='.repeat(80));
console.log('All tests complete!');
console.log('='.repeat(80));
console.log('\nCheck the log file: logs/403_errors.log\n');
console.log('The log file contains:');
console.log('  - Basic information such as request ID, key ID, and endpoint');
console.log('  - System prompt (extracted from the system field or messages)');
console.log('  - User prompts (all messages with the user role)');
console.log('  - Full message history for debugging');
console.log('  - Transformed request, if the format was converted');
console.log('  - Request headers with keys redacted');
console.log('  - Error details\n');
