/**
 * Token counting fix verification script
 *
 * Features:
 * 1. Send multiple streaming requests to an Anthropic model.
 * 2. Fetch local statistics (GET /admin/stats/summary).
 * 3. Fetch actual Factory usage (GET /admin/token/usage/{keyId}?forceRefresh=true).
 * 4. Compare local and provider statistics to evaluate the fix.
 *
 * Usage:
 *   node tests/verify-token-fix.js
 */

import fetch from 'node-fetch';
import { config } from 'dotenv';

// Load environment variables.
config();

// Configuration
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const ACCESS_KEY = process.env.API_ACCESS_KEY || 'your-access-key';
const ADMIN_KEY = process.env.ADMIN_ACCESS_KEY || 'your-admin-key';
const TEST_REQUESTS_COUNT = 5; // Send 5 test requests.

// Short test prompts to minimize token usage.
const TEST_PROMPTS = [
  'Hello, introduce yourself in one sentence.',
  'Explain artificial intelligence in one sentence.',
  'Recommend a programming book and explain why in one sentence.',
  'Describe your favorite programming language in one sentence.',
  'Give a beginner one piece of programming advice in a single sentence.'
];

// Colored output helpers
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
 * Send a single streaming request.
 */
async function sendStreamingRequest(prompt, index) {
  log(`\n📤 [Request ${index + 1}/${TEST_REQUESTS_COUNT}] Sending streaming request...`, 'blue');
  log(`   Prompt: "${prompt}"`, 'cyan');

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
        max_tokens: 150 // Limit output length to reduce token usage.
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`   ❌ Request failed: ${response.status} ${errorText}`, 'red');
      return { success: false, error: errorText };
    }

    let fullResponse = '';
    let chunkCount = 0;

    // Read the streaming response.
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
            // Ignore parsing errors.
          }
        }
      }
    }

    log(`   ✅ Request succeeded. Received ${chunkCount} chunks`, 'green');
    log(`   Response content: "${fullResponse.substring(0, 100)}..."`, 'cyan');
    return { success: true, response: fullResponse, chunkCount };

  } catch (error) {
    log(`   ❌ Request error: ${error.message}`, 'red');
    return { success: false, error: error.message };
  }
}

/**
 * Fetch local statistics from the request-stats.js module.
 */
async function getLocalStats() {
  log('\n📊 Fetching local statistics...', 'blue');

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
      throw new Error(result.message || 'Failed to fetch statistics');
    }

    log('   ✅ Local statistics retrieved successfully', 'green');
    return result.data;

  } catch (error) {
    log(`   ❌ Failed to fetch local statistics: ${error.message}`, 'red');
    throw error;
  }
}

/**
 * Fetch the key list.
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
      throw new Error(result.message || 'Failed to fetch the key list');
    }

    return result.data?.keys || [];

  } catch (error) {
    log(`   ❌ Failed to fetch the key list: ${error.message}`, 'red');
    throw error;
  }
}

/**
 * Fetch actual Factory usage via /admin/token/usage/:keyId?forceRefresh=true.
 */
async function getFactoryUsage(keyId) {
  log(`\n🌐 Fetching actual Factory usage (keyId: ${keyId})...`, 'blue');

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
      throw new Error(result.message || 'Factory API query failed');
    }

    log('   ✅ Factory API data retrieved successfully', 'green');
    return result.data;

  } catch (error) {
    log(`   ❌ Failed to fetch Factory API data: ${error.message}`, 'red');
    throw error;
  }
}

/**
 * Compare local and provider data.
 */
function compareData(localStats, factoryUsage) {
  log('\n📋 ========== Usage comparison ==========', 'bright');

  log('\n[Local statistics]', 'yellow');
  log(`  Total requests: ${localStats.total_requests}`);
  log(`  Total tokens: ${localStats.total_tokens}`);
  log(`  Requests today: ${localStats.today_requests}`);
  log(`  Tokens today: ${localStats.today_tokens}`);
  log(`  Input tokens today: ${localStats.today_input_tokens}`);
  log(`  Output tokens today: ${localStats.today_output_tokens}`);

  log('\n[Actual Factory usage]', 'yellow');
  if (factoryUsage.success && factoryUsage.standard) {
    const std = factoryUsage.standard;
    log(`  Total allowance: ${std.totalAllowance.toLocaleString()} tokens`);
    log(`  Used: ${std.orgTotalTokensUsed.toLocaleString()} tokens`);
    log(`  Remaining: ${std.remaining.toLocaleString()} tokens`);
    log(`  Usage ratio: ${(std.usedRatio * 100).toFixed(2)}%`);
  } else {
    log(`  ❌ Factory API query failed: ${factoryUsage.message || 'Unknown error'}`, 'red');
  }

  // Calculate the difference.
  if (factoryUsage.success && factoryUsage.standard) {
    const localTotal = localStats.total_tokens;
    const factoryTotal = factoryUsage.standard.orgTotalTokensUsed;
    const diff = Math.abs(localTotal - factoryTotal);
    const diffPercent = factoryTotal > 0 ? (diff / factoryTotal * 100).toFixed(2) : 0;

    log('\n[Difference analysis]', 'yellow');
    log(`  Local total tokens: ${localTotal.toLocaleString()}`);
    log(`  Actual Factory usage: ${factoryTotal.toLocaleString()}`);
    log(`  Absolute difference: ${diff.toLocaleString()} tokens`);
    log(`  Relative difference: ${diffPercent}%`);

    if (diffPercent < 1) {
      log('\n✅ Result: Token counts are highly accurate; the difference is below 1%.', 'green');
    } else if (diffPercent < 5) {
      log('\n⚠️  Result: Token counts are reasonably accurate; the difference is below 5%.', 'yellow');
    } else {
      log('\n❌ Result: Token counts differ significantly; further investigation is recommended.', 'red');
    }
  }

  log('\n====================================\n', 'bright');
}

/**
 * Main function
 */
async function main() {
  log('\n🚀 ========== Token counting fix verification script ==========', 'bright');
  log(`   API URL: ${API_BASE}`, 'cyan');
  log(`   Test request count: ${TEST_REQUESTS_COUNT}`, 'cyan');
  log('===============================================\n', 'bright');

  try {
    // Step 1: Record statistics before the test.
    log('📌 Step 1: Fetch baseline statistics', 'yellow');
    const statsBefore = await getLocalStats();
    log(`   Total requests before the test: ${statsBefore.total_requests}`, 'cyan');
    log(`   Total tokens before the test: ${statsBefore.total_tokens}`, 'cyan');

    // Step 2: Send test requests.
    log('\n📌 Step 2: Send test requests', 'yellow');
    let successCount = 0;
    for (let i = 0; i < TEST_REQUESTS_COUNT; i++) {
      const prompt = TEST_PROMPTS[i % TEST_PROMPTS.length];
      const result = await sendStreamingRequest(prompt, i);
      if (result.success) successCount++;

      // Wait 1 second between requests to avoid rate limits.
      if (i < TEST_REQUESTS_COUNT - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    log(`\n   ✅ Completed ${successCount}/${TEST_REQUESTS_COUNT} requests successfully`, successCount === TEST_REQUESTS_COUNT ? 'green' : 'yellow');

    // Wait for statistics to update (allow 2 seconds for server processing).
    log('\n⏱️  Waiting for statistics to update...', 'cyan');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 3: Fetch statistics after the test.
    log('\n📌 Step 3: Fetch statistics after the test', 'yellow');
    const statsAfter = await getLocalStats();
    log(`   Total requests after the test: ${statsAfter.total_requests}`, 'cyan');
    log(`   Total tokens after the test: ${statsAfter.total_tokens}`, 'cyan');
    log(`   Requests added: ${statsAfter.total_requests - statsBefore.total_requests}`, 'green');
    log(`   Tokens added: ${statsAfter.total_tokens - statsBefore.total_tokens}`, 'green');

    // Step 4: Fetch the key list for the Factory API query.
    log('\n📌 Step 4: Fetch key information', 'yellow');
    const keys = await getKeyList();
    if (keys.length === 0) {
      throw new Error('The key pool is empty.');
    }
    const firstKey = keys[0];
    log(`   Using key: ${firstKey.id}`, 'cyan');

    // Step 5: Fetch actual Factory usage.
    log('\n📌 Step 5: Query actual Factory usage', 'yellow');
    const factoryUsage = await getFactoryUsage(firstKey.id);

    // Step 6: Compare the data.
    log('\n📌 Step 6: Compare the data', 'yellow');
    compareData(statsAfter, factoryUsage);

    log('✅ Verification script completed.', 'green');

  } catch (error) {
    log(`\n❌ Script failed: ${error.message}`, 'red');
    console.error(error);
    process.exit(1);
  }
}

// Run the main function.
main();
