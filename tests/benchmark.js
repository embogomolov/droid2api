/**
 * 🚀 droid2api Performance load-test script
 *
 * Usage:
 * node tests/benchmark.js
 *
 * Features:
 * - Measure /v1/models endpoint throughput
 * - Measure /v1/chat/completions endpoint latency
 * - Generate a performance report
 */

import fetch from 'node-fetch';
import { performance } from 'perf_hooks';

// Configuration
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

// Performance metrics collector
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
    const totalTime = (this.endTime - this.startTime) / 1000; // Seconds

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
    console.log(`📊 ${report.name} - Performance report`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Total requests:    ${report.total}`);
    console.log(`Errors:      ${report.errors} (${report.errorRate})`);
    console.log(`Test duration:    ${report.duration}`);
    console.log(`Throughput:      ${report.rps} req/s`);
    console.log(`\nLatency statistics:`);
    console.log(`  Minimum:    ${report.latency.min}`);
    console.log(`  Average:    ${report.latency.avg}`);
    console.log(`  P50:       ${report.latency.p50}`);
    console.log(`  P90:       ${report.latency.p90}`);
    console.log(`  P99:       ${report.latency.p99}`);
    console.log(`  Maximum:    ${report.latency.max}`);
    console.log(`${'='.repeat(80)}\n`);
  }
}

// Test the /v1/models endpoint
async function testModels() {
  const config = CONFIG.tests.models;
  const stats = new PerformanceStats(config.name);

  console.log(`\n🚀 Starting test: ${config.name}`);
  console.log(`   Concurrency: ${config.concurrent}, Total requests: ${config.total}\n`);

  stats.start();

  // Concurrency control
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
        process.stdout.write(`\r✓ Completed: ${++completed}/${config.total}`);
      } else {
        stats.addRequest(latency, true);
        process.stdout.write(`\r❌ Failed: ${++completed}/${config.total} (HTTP ${response.status})`);
      }
    } catch (error) {
      const latency = performance.now() - startTime;
      stats.addRequest(latency, true);
      process.stdout.write(`\r❌ Failed: ${++completed}/${config.total} (${error.message})`);
    }
  }

  // Send requests in batches
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

  // Wait for all requests to finish
  await Promise.all(queue);
  console.log(); // Start a new line

  stats.finish();
  stats.printReport();

  return stats.getReport();
}

// Test the /v1/chat/completions endpoint
async function testChatCompletions() {
  const config = CONFIG.tests.chatCompletions;
  const stats = new PerformanceStats(config.name);

  console.log(`\n🚀 Starting test: ${config.name}`);
  console.log(`   Concurrency: ${config.concurrent}, Total requests: ${config.total}\n`);

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
        process.stdout.write(`\r✓ Completed: ${++completed}/${config.total}`);
      } else {
        stats.addRequest(latency, true);
        process.stdout.write(`\r❌ Failed: ${++completed}/${config.total} (HTTP ${response.status})`);
      }
    } catch (error) {
      const latency = performance.now() - startTime;
      stats.addRequest(latency, true);
      process.stdout.write(`\r❌ Failed: ${++completed}/${config.total} (${error.message})`);
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
  console.log(); // Start a new line

  stats.finish();
  stats.printReport();

  return stats.getReport();
}

// Main function
async function main() {
  console.log(`
${'='.repeat(80)}
🚀 droid2api Performance load-testing tool
${'='.repeat(80)}
Target server: ${CONFIG.baseUrl}
API key:    ${CONFIG.apiKey.substring(0, 10)}...
${'='.repeat(80)}
`);

  // Check server availability
  console.log('🔍 Check the server connection...');
  try {
    const response = await fetch(`${CONFIG.baseUrl}/`, {
      headers: { 'x-api-key': CONFIG.apiKey }
    });
    if (response.ok) {
      console.log('✅ Server connection successful\n');
    } else {
      console.error(`❌ Server returned an error: HTTP ${response.status}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`❌ Unable to connect to the server: ${error.message}`);
    process.exit(1);
  }

  // Run the tests
  const results = {
    models: await testModels(),
    chatCompletions: await testChatCompletions()
  };

  // Print the summary
  console.log(`
${'='.repeat(80)}
📈 Load-test summary
${'='.repeat(80)}
/v1/models:
  Throughput: ${results.models.rps} req/s
  Average latency: ${results.models.latency.avg}
  Error rate: ${results.models.errorRate}

/v1/chat/completions:
  Throughput: ${results.chatCompletions.rps} req/s
  Average latency: ${results.chatCompletions.latency.avg}
  Error rate: ${results.chatCompletions.errorRate}
${'='.repeat(80)}

💡 Tips:
  - If throughput is < 500 req/s, consider enabling connection pooling
  - If average latency is > 200ms, check upstream API response times
  - If the error rate is > 5%, check the key-pool configuration and upstream rate limits
${'='.repeat(80)}
`);
}

// Run
main().catch(error => {
  console.error('❌ Load test failed:', error);
  process.exit(1);
});
