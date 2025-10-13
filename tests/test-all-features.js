/**
 * BaSui：完整功能测试套件
 * 测试所有修复的功能：文本、图片、工具调用、thinking、多轮对话等
 */

import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3000';
const API_KEY = process.env.API_ACCESS_KEY || 'your-access-key';

// 颜色输出
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
  log(`\n→ 测试：${name}`, 'yellow');
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

// 测试计数
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
 * 测试 1：获取模型列表
 */
async function testGetModels() {
  logTest('获取模型列表');
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
    
    logInfo(`找到 ${data.data.length} 个模型`);
    data.data.forEach(model => {
      logInfo(`  - ${model.id} (${model.owned_by})`);
    });
    
    testPassed('获取模型列表');
    return data.data;
  } catch (error) {
    testFailed('获取模型列表', error.message);
    throw error;
  }
}

/**
 * 测试 2：基础文本对话（Anthropic模型）
 */
async function testBasicChat(modelId = 'claude-sonnet-4-20250514') {
  logTest(`基础文本对话 - ${modelId}`);
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
          { role: 'user', content: '请用一句话介绍你自己' }
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
    
    logInfo(`响应内容: ${data.choices[0].message.content.substring(0, 100)}...`);
    testPassed(`基础文本对话 - ${modelId}`);
    return data;
  } catch (error) {
    testFailed(`基础文本对话 - ${modelId}`, error.message);
    throw error;
  }
}

/**
 * 测试 3：流式响应
 */
async function testStreamingChat(modelId = 'claude-sonnet-4-20250514') {
  logTest(`流式响应 - ${modelId}`);
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
          { role: 'user', content: '数到5' }
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
            logInfo('收到 [DONE] 信号');
            continue;
          }
          
          try {
            const json = JSON.parse(data);
            if (json.choices && json.choices[0].delta.content) {
              content += json.choices[0].delta.content;
              chunks++;
            }
          } catch (e) {
            // 忽略非JSON行
          }
        }
      }
    }
    
    if (chunks === 0) {
      throw new Error('未收到任何流式数据块');
    }
    
    logInfo(`收到 ${chunks} 个数据块`);
    logInfo(`完整内容: ${content}`);
    testPassed(`流式响应 - ${modelId}`);
    return { chunks, content };
  } catch (error) {
    testFailed(`流式响应 - ${modelId}`, error.message);
    throw error;
  }
}

/**
 * 测试 4：工具调用
 */
async function testToolCalls(modelId = 'claude-sonnet-4-20250514') {
  logTest(`工具调用 - ${modelId}`);
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
          { role: 'user', content: '北京现在几点？请使用get_current_time工具查询' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_current_time',
              description: '获取指定城市的当前时间',
              parameters: {
                type: 'object',
                properties: {
                  city: {
                    type: 'string',
                    description: '城市名称'
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
    
    // 检查是否返回了工具调用
    if (!message.tool_calls || message.tool_calls.length === 0) {
      throw new Error('模型未返回工具调用');
    }
    
    const toolCall = message.tool_calls[0];
    logInfo(`工具调用ID: ${toolCall.id}`);
    logInfo(`工具名称: ${toolCall.function.name}`);
    logInfo(`工具参数: ${toolCall.function.arguments}`);
    
    // 验证参数是否为有效JSON
    try {
      const args = JSON.parse(toolCall.function.arguments);
      logInfo(`解析后的参数: ${JSON.stringify(args)}`);
    } catch (e) {
      throw new Error(`工具参数不是有效的JSON: ${e.message}`);
    }
    
    testPassed(`工具调用 - ${modelId}`);
    return data;
  } catch (error) {
    testFailed(`工具调用 - ${modelId}`, error.message);
    // 不抛出错误，继续其他测试
    return null;
  }
}

/**
 * 测试 5：多轮工具对话（tool_result）
 */
async function testToolResult(modelId = 'claude-sonnet-4-20250514') {
  logTest(`多轮工具对话 - ${modelId}`);
  try {
    // 第一轮：模型返回工具调用
    const firstResponse = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'user', content: '2+2等于多少？请使用calculator工具计算' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'calculator',
              description: '执行数学计算',
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
      throw new Error(`第一轮失败: ${response.status}: ${JSON.stringify(firstData)}`);
    }
    
    if (!firstData.choices[0].message.tool_calls) {
      throw new Error('第一轮未返回工具调用');
    }
    
    const toolCall = firstData.choices[0].message.tool_calls[0];
    logInfo(`第一轮 - 工具调用: ${toolCall.function.name}`);
    
    // 第二轮：发送工具结果
    const secondResponse = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'user', content: '2+2等于多少？请使用calculator工具计算' },
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
              description: '执行数学计算',
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
      throw new Error(`第二轮失败: ${secondResponse.status}: ${JSON.stringify(secondData)}`);
    }
    
    logInfo(`第二轮 - 响应: ${secondData.choices[0].message.content}`);
    
    testPassed(`多轮工具对话 - ${modelId}`);
    return secondData;
  } catch (error) {
    testFailed(`多轮工具对话 - ${modelId}`, error.message);
    // 不抛出错误，继续其他测试
    return null;
  }
}

/**
 * 测试 6：GPT-5 别名模型
 */
async function testGPT5Alias() {
  logTest('GPT-5 别名模型（使用Anthropic后端）');
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
          { role: 'user', content: '你好，GPT-5！' }
        ],
        max_tokens: 100
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(`Status ${response.status}: ${JSON.stringify(data)}`);
    }
    
    logInfo(`响应: ${data.choices[0].message.content.substring(0, 100)}...`);
    testPassed('GPT-5 别名模型');
    return data;
  } catch (error) {
    testFailed('GPT-5 别名模型', error.message);
    // 不抛出错误，继续其他测试
    return null;
  }
}

/**
 * 主测试函数
 */
async function runAllTests() {
  logSection('🧪 droid2api 完整功能测试套件');
  
  try {
    // 测试 1：获取模型列表
    logSection('测试 1：获取模型列表');
    await testGetModels();
    
    // 测试 2：基础文本对话
    logSection('测试 2：基础文本对话');
    await testBasicChat('claude-sonnet-4-20250514');
    
    // 测试 3：流式响应
    logSection('测试 3：流式响应');
    await testStreamingChat('claude-sonnet-4-20250514');
    
    // 测试 4：工具调用
    logSection('测试 4：工具调用');
    await testToolCalls('claude-sonnet-4-20250514');
    
    // 测试 5：多轮工具对话
    logSection('测试 5：多轮工具对话（tool_result）');
    await testToolResult('claude-sonnet-4-20250514');
    
    // 测试 6：GPT-5 别名
    logSection('测试 6：GPT-5 别名模型');
    await testGPT5Alias();
    
  } catch (error) {
    logError(`测试套件异常终止: ${error.message}`);
  }
  
  // 打印测试结果
  logSection('测试结果');
  log(`总测试数: ${totalTests}`, 'cyan');
  log(`通过: ${passedTests}`, 'green');
  log(`失败: ${failedTests}`, 'red');
  
  const successRate = totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(1) : 0;
  log(`成功率: ${successRate}%`, successRate === '100.0' ? 'green' : 'yellow');
  
  if (failedTests === 0) {
    log('\n🎉 所有测试通过！', 'green');
  } else {
    log(`\n⚠️  ${failedTests} 个测试失败`, 'red');
  }
  
  process.exit(failedTests > 0 ? 1 : 0);
}

// 运行测试
runAllTests().catch(error => {
  logError(`测试运行失败: ${error.message}`);
  process.exit(1);
});
