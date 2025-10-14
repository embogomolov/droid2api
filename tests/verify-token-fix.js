/**
 * Token 计算修复验证脚本
 *
 * 功能：
 * 1. 发起多次 Anthropic 流式请求
 * 2. 获取本地统计数据（GET /admin/token/summary）
 * 3. 获取 Factory API 真实用量（GET /admin/balance/factory/{keyId}）
 * 4. 对比两边数据，验证修复效果
 *
 * 使用方法：
 *   node tests/verify-token-fix.js
 */

import fetch from 'node-fetch';
import { config } from 'dotenv';

// 加载环境变量
config();

// 配置
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const ACCESS_KEY = process.env.API_ACCESS_KEY || 'your-access-key';
const ADMIN_KEY = process.env.ADMIN_ACCESS_KEY || 'your-admin-key';
const TEST_REQUESTS_COUNT = 5; // 发起5次测试请求

// 测试提示词（简短，节约Token）
const TEST_PROMPTS = [
  '你好，请用一句话介绍你自己。',
  '用一句话解释什么是人工智能。',
  '推荐一本编程书籍，一句话说明理由。',
  '用一句话描述你最喜欢的编程语言。',
  '给初学者一个编程建议，一句话。'
];

// 颜色输出辅助函数
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * 发起单个流式请求
 */
async function sendStreamingRequest(prompt, index) {
  log(`\n📤 [请求 ${index + 1}/${TEST_REQUESTS_COUNT}] 发起流式请求...`, 'blue');
  log(`   提示词: "${prompt}"`, 'cyan');

  try {
    const response = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ACCESS_KEY}`
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        max_tokens: 150 // 限制输出长度，节约Token
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`   ❌ 请求失败: ${response.status} ${errorText}`, 'red');
      return { success: false, error: errorText };
    }

    let fullResponse = '';
    let chunkCount = 0;

    // 读取流式响应
    const reader = response.body;
    for await (const chunk of reader) {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
          try {
            const json = JSON.parse(line.slice(6));
            const content = json.choices?.[0]?.delta?.content || '';
            if (content) {
              fullResponse += content;
              chunkCount++;
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    log(`   ✅ 请求成功！收到 ${chunkCount} 个数据块`, 'green');
    log(`   响应内容: "${fullResponse.substring(0, 100)}..."`, 'cyan');
    return { success: true, response: fullResponse, chunkCount };

  } catch (error) {
    log(`   ❌ 请求异常: ${error.message}`, 'red');
    return { success: false, error: error.message };
  }
}

/**
 * 获取本地统计数据（使用 request-stats.js 模块）
 */
async function getLocalStats() {
  log('\n📊 获取本地统计数据...', 'blue');

  try {
    const response = await fetch(`${API_BASE}/admin/stats/summary`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || '获取统计数据失败');
    }

    log('   ✅ 本地统计数据获取成功', 'green');
    return result.data;

  } catch (error) {
    log(`   ❌ 获取本地统计失败: ${error.message}`, 'red');
    throw error;
  }
}

/**
 * 获取密钥列表
 */
async function getKeyList() {
  try {
    const response = await fetch(`${API_BASE}/admin/keys`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || '获取密钥列表失败');
    }

    return result.data?.keys || [];

  } catch (error) {
    log(`   ❌ 获取密钥列表失败: ${error.message}`, 'red');
    throw error;
  }
}

/**
 * 获取 Factory API 真实用量（通过 /admin/token/usage/:keyId?forceRefresh=true）
 */
async function getFactoryUsage(keyId) {
  log(`\n🌐 获取 Factory API 真实用量 (keyId: ${keyId})...`, 'blue');

  try {
    const response = await fetch(`${API_BASE}/admin/token/usage/${keyId}?forceRefresh=true`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || 'Factory API 查询失败');
    }

    log('   ✅ Factory API 数据获取成功', 'green');
    return result.data;

  } catch (error) {
    log(`   ❌ 获取 Factory API 数据失败: ${error.message}`, 'red');
    throw error;
  }
}

/**
 * 对比分析两边数据
 */
function compareData(localStats, factoryUsage) {
  log('\n📋 ========== 数据对比分析 ==========', 'bright');

  log('\n【本地统计】', 'yellow');
  log(`  总请求数: ${localStats.total_requests}`);
  log(`  总 Token 数: ${localStats.total_tokens}`);
  log(`  今日请求数: ${localStats.today_requests}`);
  log(`  今日 Token 数: ${localStats.today_tokens}`);
  log(`  今日输入 Token: ${localStats.today_input_tokens}`);
  log(`  今日输出 Token: ${localStats.today_output_tokens}`);

  log('\n【Factory API 真实用量】', 'yellow');
  if (factoryUsage.success && factoryUsage.standard) {
    const std = factoryUsage.standard;
    log(`  总配额: ${std.totalAllowance.toLocaleString()} tokens`);
    log(`  已使用: ${std.orgTotalTokensUsed.toLocaleString()} tokens`);
    log(`  剩余: ${std.remaining.toLocaleString()} tokens`);
    log(`  使用率: ${(std.usedRatio * 100).toFixed(2)}%`);
  } else {
    log(`  ❌ Factory API 查询失败: ${factoryUsage.message || '未知错误'}`, 'red');
  }

  // 计算差异
  if (factoryUsage.success && factoryUsage.standard) {
    const localTotal = localStats.total_tokens;
    const factoryTotal = factoryUsage.standard.orgTotalTokensUsed;
    const diff = Math.abs(localTotal - factoryTotal);
    const diffPercent = factoryTotal > 0 ? (diff / factoryTotal * 100).toFixed(2) : 0;

    log('\n【差异分析】', 'yellow');
    log(`  本地统计总 Token: ${localTotal.toLocaleString()}`);
    log(`  Factory 真实用量: ${factoryTotal.toLocaleString()}`);
    log(`  绝对差异: ${diff.toLocaleString()} tokens`);
    log(`  相对差异: ${diffPercent}%`);

    if (diffPercent < 1) {
      log('\n✅ 结论: Token 计算非常准确！差异小于 1%！', 'green');
    } else if (diffPercent < 5) {
      log('\n⚠️  结论: Token 计算基本准确，差异在 5% 以内', 'yellow');
    } else {
      log('\n❌ 结论: Token 计算存在较大偏差，建议进一步检查', 'red');
    }
  }

  log('\n====================================\n', 'bright');
}

/**
 * 主函数
 */
async function main() {
  log('\n🚀 ========== Token 计算修复验证脚本 ==========', 'bright');
  log(`   API 地址: ${API_BASE}`, 'cyan');
  log(`   测试请求数: ${TEST_REQUESTS_COUNT}`, 'cyan');
  log('===============================================\n', 'bright');

  try {
    // 第一步：记录测试前的统计数据
    log('📌 步骤 1: 获取测试前的基准数据', 'yellow');
    const statsBefore = await getLocalStats();
    log(`   测试前总请求数: ${statsBefore.total_requests}`, 'cyan');
    log(`   测试前总 Token 数: ${statsBefore.total_tokens}`, 'cyan');

    // 第二步：发起测试请求
    log('\n📌 步骤 2: 发起测试请求', 'yellow');
    let successCount = 0;
    for (let i = 0; i < TEST_REQUESTS_COUNT; i++) {
      const prompt = TEST_PROMPTS[i % TEST_PROMPTS.length];
      const result = await sendStreamingRequest(prompt, i);
      if (result.success) successCount++;

      // 每次请求间隔1秒，避免速率限制
      if (i < TEST_REQUESTS_COUNT - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    log(`\n   ✅ 完成 ${successCount}/${TEST_REQUESTS_COUNT} 个请求`, successCount === TEST_REQUESTS_COUNT ? 'green' : 'yellow');

    // 等待统计数据更新（给服务器1秒时间处理）
    log('\n⏱️  等待统计数据更新...', 'cyan');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 第三步：获取测试后的统计数据
    log('\n📌 步骤 3: 获取测试后的统计数据', 'yellow');
    const statsAfter = await getLocalStats();
    log(`   测试后总请求数: ${statsAfter.total_requests}`, 'cyan');
    log(`   测试后总 Token 数: ${statsAfter.total_tokens}`, 'cyan');
    log(`   新增请求数: ${statsAfter.total_requests - statsBefore.total_requests}`, 'green');
    log(`   新增 Token 数: ${statsAfter.total_tokens - statsBefore.total_tokens}`, 'green');

    // 第四步：获取密钥列表（用于查询 Factory API）
    log('\n📌 步骤 4: 获取密钥信息', 'yellow');
    const keys = await getKeyList();
    if (keys.length === 0) {
      throw new Error('密钥池为空！');
    }
    const firstKey = keys[0];
    log(`   使用密钥: ${firstKey.id}`, 'cyan');

    // 第五步：获取 Factory API 真实用量
    log('\n📌 步骤 5: 查询 Factory API 真实用量', 'yellow');
    const factoryUsage = await getFactoryUsage(firstKey.id);

    // 第六步：对比分析
    log('\n📌 步骤 6: 对比分析', 'yellow');
    compareData(statsAfter, factoryUsage);

    log('✅ 验证脚本执行完成！', 'green');

  } catch (error) {
    log(`\n❌ 脚本执行失败: ${error.message}`, 'red');
    console.error(error);
    process.exit(1);
  }
}

// 执行主函数
main();
