/**
 * BaSui: comprehensive feature test suite
 * Test all repaired features: text, images, tool calls, thinking, multi-turn conversations, and more
 */

import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3000';
const API_KEY = process.env.API_ACCESS_KEY || 'your-access-key';

// Colored output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log(title, 'cyan');
  console.log('='.repeat(60));
}

function logTest(name) {
  log(`\n→ Test: ${name}`, 'yellow');
}

function logSuccess(message) {
  log(`  ✓ ${message}`, 'green');
}

function logError(message) {
  log(`  ✗ ${message}`, 'red');
}

function logInfo(message) {
  log(`  ℹ ${message}`, 'blue');
}

// Test counters
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function testPassed(name) {
  totalTests++;
  passedTests++;
  logSuccess(`${name} - PASSED`);
}

function testFailed(name, error) {
  totalTests++;
  failedTests++;
  logError(`${name} - FAILED: ${error}`);
}

/**
 * Test 1: Get the model list
 */
async function testGetModels() {
  logTest('Get the model list');
  try {
    const response = await fetch(`${BASE_URL}/v1/models`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      }
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(`Status ${response.status}: ${JSON.stringify(data)}`);
    }
    
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Invalid response format');
    }
    
    logInfo(`Found ${data.data.length} models`);
    data.data.forEach(model => {
      logInfo(`  - ${model.id} (${model.owned_by})`);
    });
    
    testPassed('Get the model list');
    return data.data;
  } catch (error) {
    testFailed('Get the model list', error.message);
    throw error;
  }
}

/**
 * Test 2: Basic text chat (Anthropic model)
 */
async function testBasicChat(modelId = 'claude-sonnet-4-20250514') {
  logTest(`Basic text chat - ${modelId}`);
  try {
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'user', content: 'Introduce yourself in one sentence' }
        ],
        max_tokens: 100
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(`Status ${response.status}: ${JSON.stringify(data)}`);
    }
    
    if (!data.choices || !data.choices[0].message.content) {
      throw new Error('Invalid response format');
    }
    
    logInfo(`Response content: ${data.choices[0].message.content.substring(0, 100)}...`);
    testPassed(`Basic text chat - ${modelId}`);
    return data;
  } catch (error) {
    testFailed(`Basic text chat - ${modelId}`, error.message);
    throw error;
  }
}

/**
 * Test 3: Streaming response
 */
async function testStreamingChat(modelId = 'claude-sonnet-4-20250514') {
  logTest(`Streaming response - ${modelId}`);
  try {
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'user', content: 'Count to 5' }
        ],
        stream: true,
        max_tokens: 50
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Status ${response.status}: ${errorText}`);
    }
    
    let chunks = 0;
    let content = '';
    
    const reader = response.body;
    let buffer = '';
    
    for await (const chunk of reader) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            logInfo('Received the [DONE] marker');
            continue;
          }
          
          try {
            const json = JSON.parse(data);
            if (json.choices && json.choices[0].delta.content) {
              content += json.choices[0].delta.content;
             chunks++;
            }
          } catch (e) {
            // Ignore non-JSON lines
          }
        }
      }
    }
    
    if (chunks === 0) {
      throw new Error('No streaming chunks received');
    }
    
    logInfo(`Received ${chunks} chunks`);
    logInfo(`Full content: ${content}`);
    testPassed(`Streaming response - ${modelId}`);
    return { chunks, content };
  } catch (error) {
    testFailed(`Streaming response - ${modelId}`, error.message);
    throw error;
  }
}

/**
 * Test 4: Tool call
 */
async function testToolCalls(modelId = 'claude-sonnet-4-20250514') {
  logTest(`Tool call - ${modelId}`);
  try {
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'user', content: 'What time is it in Beijing? Use the get_current_time tool to check' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_current_time',
              description: 'Get the current time in the specified city',
              parameters: {
                type: 'object',
                properties: {
                  city: {
                    type: 'string',
                    description: 'City name'
                  }
                },
                required: ['city']
              }
            }
          }
        ],
        max_tokens: 200
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(`Status ${response.status}: ${JSON.stringify(data)}`);
    }
    
    if (!data.choices || !data.choices[0].message) {
      throw new Error('Invalid response format');
    }
    
    const message = data.choices[0].message;
    
    // Check that a tool call was returned
    if (!message.tool_calls || message.tool_calls.length === 0) {
      throw new Error('The model did not return a tool call');
    }
    
    const toolCall = message.tool_calls[0];
    logInfo(`Tool call ID: ${toolCall.id}`);
    logInfo(`Tool name: ${toolCall.function.name}`);
    logInfo(`Tool arguments: ${toolCall.function.arguments}`);
    
    // Verify that the arguments are valid JSON
    try {
      const args = JSON.parse(toolCall.function.arguments);
      logInfo(`Parsed arguments: ${JSON.stringify(args)}`);
    } catch (e) {
      throw new Error(`Tool arguments are not valid JSON: ${e.message}`);
    }
    
    testPassed(`Tool call - ${modelId}`);
    return data;
  } catch (error) {
    testFailed(`Tool call - ${modelId}`, error.message);
    // Do not rethrow; continue with the remaining tests
    return null;
  }
}

/**
 * Test 5: Multi-turn tool conversation (tool_result)
 */
async function testToolResult(modelId = 'claude-sonnet-4-20250514') {
  logTest(`Multi-turn tool conversation - ${modelId}`);
  try {
    // First turn: the model returns a tool call
    const firstResponse = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'user', content: 'What is 2+2? Use the calculator tool' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'calculator',
              description: 'Perform a mathematical calculation',
              parameters: {
                type: 'object',
                properties: {
                  expression: { type: 'string' }
                },
                required: ['expression']
              }
            }
          }
        ],
        max_tokens: 200
      })
    });
    
    const firstData = await firstResponse.json();
    
    if (!firstResponse.ok) {
      throw new Error(`First turn failed: ${response.status}: ${JSON.stringify(firstData)}`);
    }
    
    if (!firstData.choices[0].message.tool_calls) {
      throw new Error('No tool call returned in the first turn');
    }
    
    const toolCall = firstData.choices[0].message.tool_calls[0];
    logInfo(`First turn - Tool call: ${toolCall.function.name}`);
    
    // Second turn: send the tool result
    const secondResponse = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'user', content: 'What is 2+2? Use the calculator tool' },
          {
            role: 'assistant',
            tool_calls: [toolCall]
          },
          {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: '4'
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'calculator',
              description: 'Perform a mathematical calculation',
              parameters: {
                type: 'object',
                properties: {
                  expression: { type: 'string' }
                }
              }
            }
          }
        ],
        max_tokens: 200
      })
    });
    
    const secondData = await secondResponse.json();
    
    if (!secondResponse.ok) {
      throw new Error(`Second turn failed: ${secondResponse.status}: ${JSON.stringify(secondData)}`);
    }
    
    logInfo(`Second turn - Response: ${secondData.choices[0].message.content}`);
    
    testPassed(`Multi-turn tool conversation - ${modelId}`);
    return secondData;
  } catch (error) {
    testFailed(`Multi-turn tool conversation - ${modelId}`, error.message);
    // Do not rethrow; continue with the remaining tests
    return null;
  }
}

/**
 * Test 6: GPT-5 alias model
 */
async function testGPT5Alias() {
  logTest('GPT-5 alias model (using the Anthropic backend)');
  try {
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-5-2025-08-07',
        messages: [
          { role: 'user', content: 'Hello, GPT-5!' }
        ],
        max_tokens: 100
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(`Status ${response.status}: ${JSON.stringify(data)}`);
    }
    
    logInfo(`Response: ${data.choices[0].message.content.substring(0, 100)}...`);
    testPassed('GPT-5 alias model');
    return data;
  } catch (error) {
    testFailed('GPT-5 alias model', error.message);
    // Do not rethrow; continue with the remaining tests
    return null;
  }
}

/**
 * Main test function
 */
async function runAllTests() {
  logSection('🧪 droid2api comprehensive feature test suite');
  
  try {
    // Test 1: Get the model list
    logSection('Test 1: Get the model list');
    await testGetModels();
    
    // Test 2: Basic text chat
    logSection('Test 2: Basic text chat');
    await testBasicChat('claude-sonnet-4-20250514');
    
    // Test 3: Streaming response
    logSection('Test 3: Streaming response');
    await testStreamingChat('claude-sonnet-4-20250514');
    
    // Test 4: Tool call
    logSection('Test 4: Tool call');
    await testToolCalls('claude-sonnet-4-20250514');
    
    // Test 5: Multi-turn tool conversation
    logSection('Test 5: Multi-turn tool conversation (tool_result)');
    await testToolResult('claude-sonnet-4-20250514');
    
    // Test 6: GPT-5 alias
    logSection('Test 6: GPT-5 alias model');
    await testGPT5Alias();
    
  } catch (error) {
    logError(`Test suite terminated unexpectedly: ${error.message}`);
  }
  
  // Print test results
  logSection('Test results');
  log(`Total tests: ${totalTests}`, 'cyan');
  log(`Passed: ${passedTests}`, 'green');
  log(`Failed: ${failedTests}`, 'red');
  
  const successRate = totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(1) : 0;
  log(`Success rate: ${successRate}%`, successRate === '100.0' ? 'green' : 'yellow');
  
  if (failedTests === 0) {
    log('\n🎉 All tests passed!', 'green');
  } else {
    log(`\n⚠️  ${failedTests} tests failed`, 'red');
  }
  
  process.exit(failedTests > 0 ? 1 : 0);
}

// Run tests
runAllTests().catch(error => {
  logError(`Test run failed: ${error.message}`);
  process.exit(1);
});
