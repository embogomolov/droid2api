/**
 * 🚀 droid2api 性能压测脚本
 *
 * 使用方式：
 * node tests/benchmark.js
 *
 * 功能：
 * - 测试 /v1/models 接口吞吐量
 * - 测试 /v1/chat/completions 接口延迟
 * - 生成性能报告
 */

import fetch from 'node-fetch';
import { performance } from 'perf_hooks';

// 配置
const CONFIG = {
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.API_ACCESS_KEY || 'your-api-key',
  tests: {
    models: {
      name: 'GET /v1/models',
      concurrent: 100,
      total: 1000
    },
    chatCompletions: {
      name: 'POST /v1/chat/completions',
      concurrent: 50,
      total: 200
    }
  }
};

// 性能统计器
class PerformanceStats {
  constructor(name) {
    this.name = name;
    this.latencies = [];
    this.errors = 0;
    this.startTime = 0;
    this.endTime = 0;
  }

  start() {
    this.startTime = performance.now();
  }

  addRequest(latency, isError = false) {
    this.latencies.push(latency);
    if (isError) this.errors++;
  }

  finish() {
    this.endTime = performance.now();
  }

  getReport() {
    if (this.latencies.length === 0) {
      return { error: 'No requests completed' };
    }

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const total = this.latencies.length;
    const totalTime = (this.endTime - this.startTime) / 1000; // 秒

    return {
      name: this.name,
      total: total,
      errors: this.errors,
      errorRate: ((this.errors / total) * 100).toFixed(2) + '%',
      duration: totalTime.toFixed(2) + 's',
      rps: (total / totalTime).toFixed(2),
      latency: {
        min: sorted[0].toFixed(2) + 'ms',
        max: sorted[sorted.length - 1].toFixed(2) + 'ms',
        avg: (sorted.reduce((a, b) => a + b, 0) / total).toFixed(2) + 'ms',
        p50: sorted[Math.floor(total * 0.5)].toFixed(2) + 'ms',
        p90: sorted[Math.floor(total * 0.9)].toFixed(2) + 'ms',
        p99: sorted[Math.floor(total * 0.99)].toFixed(2) + 'ms'
      }
    };
  }

  printReport() {
    const report = this.getReport();
    if (report.error) {
      console.error(`❌ ${this.name}: ${report.error}`);
      return;
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`📊 ${report.name} - 性能报告`);
    console.log(`${'='.repeat(80)}`);
    console.log(`总请求数:    ${report.total}`);
    console.log(`错误数:      ${report.errors} (${report.errorRate})`);
    console.log(`测试时长:    ${report.duration}`);
    console.log(`吞吐量:      ${report.rps} req/s`);
    console.log(`\n延迟统计:`);
    console.log(`  最小值:    ${report.latency.min}`);
    console.log(`  平均值:    ${report.latency.avg}`);
    console.log(`  P50:       ${report.latency.p50}`);
    console.log(`  P90:       ${report.latency.p90}`);
    console.log(`  P99:       ${report.latency.p99}`);
    console.log(`  最大值:    ${report.latency.max}`);
    console.log(`${'='.repeat(80)}\n`);
  }
}

// 测试 /v1/models 接口
async function testModels() {
  const config = CONFIG.tests.models;
  const stats = new PerformanceStats(config.name);

  console.log(`\n🚀 开始测试: ${config.name}`);
  console.log(`   并发数: ${config.concurrent}, 总请求: ${config.total}\n`);

  stats.start();

  // 并发控制
  let completed = 0;
  const queue = [];

  async function makeRequest() {
    const startTime = performance.now();
    try {
      const response = await fetch(`${CONFIG.baseUrl}/v1/models`, {
        headers: {
          'x-api-key': CONFIG.apiKey
        }
      });

      const latency = performance.now() - startTime;

      if (response.ok) {
        stats.addRequest(latency, false);
        process.stdout.write(`\r✓ 完成: ${++completed}/${config.total}`);
      } else {
        stats.addRequest(latency, true);
        process.stdout.write(`\r❌ 失败: ${++completed}/${config.total} (HTTP ${response.status})`);
      }
    } catch (error) {
      const latency = performance.now() - startTime;
      stats.addRequest(latency, true);
      process.stdout.write(`\r❌ 失败: ${++completed}/${config.total} (${error.message})`);
    }
  }

  // 分批发送请求
  for (let i = 0; i < config.total; i++) {
    if (queue.length >= config.concurrent) {
      await Promise.race(queue);
    }
    const promise = makeRequest();
    queue.push(promise);
    promise.then(() => {
      const index = queue.indexOf(promise);
      if (index > -1) queue.splice(index, 1);
    });
  }

  // 等待所有请求完成
  await Promise.all(queue);
  console.log(); // 换行

  stats.finish();
  stats.printReport();

  return stats.getReport();
}

// 测试 /v1/chat/completions 接口
async function testChatCompletions() {
  const config = CONFIG.tests.chatCompletions;
  const stats = new PerformanceStats(config.name);

  console.log(`\n🚀 开始测试: ${config.name}`);
  console.log(`   并发数: ${config.concurrent}, 总请求: ${config.total}\n`);

  stats.start();

  let completed = 0;
  const queue = [];

  async function makeRequest() {
    const startTime = performance.now();
    try {
      const response = await fetch(`${CONFIG.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CONFIG.apiKey
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          messages: [
            { role: 'user', content: 'Hello' }
          ],
          max_tokens: 10,
          stream: false
        })
      });

      const latency = performance.now() - startTime;

      if (response.ok) {
        stats.addRequest(latency, false);
        process.stdout.write(`\r✓ 完成: ${++completed}/${config.total}`);
      } else {
        stats.addRequest(latency, true);
        process.stdout.write(`\r❌ 失败: ${++completed}/${config.total} (HTTP ${response.status})`);
      }
    } catch (error) {
      const latency = performance.now() - startTime;
      stats.addRequest(latency, true);
      process.stdout.write(`\r❌ 失败: ${++completed}/${config.total} (${error.message})`);
    }
  }

  for (let i = 0; i < config.total; i++) {
    if (queue.length >= config.concurrent) {
      await Promise.race(queue);
    }
    const promise = makeRequest();
    queue.push(promise);
    promise.then(() => {
      const index = queue.indexOf(promise);
      if (index > -1) queue.splice(index, 1);
    });
  }

  await Promise.all(queue);
  console.log(); // 换行

  stats.finish();
  stats.printReport();

  return stats.getReport();
}

// 主函数
async function main() {
  console.log(`
${'='.repeat(80)}
🚀 droid2api 性能压测工具
${'='.repeat(80)}
目标服务器: ${CONFIG.baseUrl}
API密钥:    ${CONFIG.apiKey.substring(0, 10)}...
${'='.repeat(80)}
`);

  // 检查服务器是否可用
  console.log('🔍 检查服务器连接...');
  try {
    const response = await fetch(`${CONFIG.baseUrl}/`, {
      headers: { 'x-api-key': CONFIG.apiKey }
    });
    if (response.ok) {
      console.log('✅ 服务器连接正常\n');
    } else {
      console.error(`❌ 服务器返回错误: HTTP ${response.status}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`❌ 无法连接到服务器: ${error.message}`);
    process.exit(1);
  }

  // 运行测试
  const results = {
    models: await testModels(),
    chatCompletions: await testChatCompletions()
  };

  // 打印总结
  console.log(`
${'='.repeat(80)}
📈 压测总结
${'='.repeat(80)}
/v1/models:
  吞吐量: ${results.models.rps} req/s
  平均延迟: ${results.models.latency.avg}
  错误率: ${results.models.errorRate}

/v1/chat/completions:
  吞吐量: ${results.chatCompletions.rps} req/s
  平均延迟: ${results.chatCompletions.latency.avg}
  错误率: ${results.chatCompletions.errorRate}
${'='.repeat(80)}

💡 提示:
  - 如果吞吐量 < 500 req/s，考虑启用连接池优化
  - 如果平均延迟 > 200ms，检查上游 API 响应速度
  - 如果错误率 > 5%，检查密钥池配置和上游限流
${'='.repeat(80)}
`);
}

// 运行
main().catch(error => {
  console.error('❌ 压测失败:', error);
  process.exit(1);
});
