/**
 * Test token statistics grouped by key pool
 * Usage: node tests/test-token-by-pool.js
 */

import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_ACCESS_KEY;

if (!ADMIN_KEY) {
    console.error('❌ Error: Set the ADMIN_ACCESS_KEY environment variable');
    process.exit(1);
}

console.log('🧪 Start testing token statistics grouped by key pool...\n');

/**
 * Test GET /admin/token/by-pool
 */
async function testTokenByPool() {
    console.log('📊 Test GET /admin/token/by-pool...');
    
    try {
        const response = await fetch(`${BASE_URL}/admin/token/by-pool`, {
            method: 'GET',
            headers: {
                'x-admin-key': ADMIN_KEY
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();

        if (!result.success) {
            throw new Error(`API reported failure: ${result.message || 'Unknown error'}`);
        }

        console.log('✅ Request successful!\n');
        console.log('📋 Response data:');
        console.log(JSON.stringify(result.data, null, 2));

        // Verify the data structure
        if (!result.data.pools) {
            throw new Error('Response data is missing the pools field');
        }

        if (!result.data.cache_info) {
            throw new Error('Response data is missing the cache_info field');
        }

        console.log('\n📊 Key-pool statistics:');
        console.log(`  Total key pools: ${result.data.total_pools}`);
        console.log(`  Last sync time: ${result.data.cache_info.last_sync || 'Not synced'}`);
        console.log(`  Cache expired: ${result.data.cache_info.is_expired ? 'Yes' : 'No'}`);

        // Print detailed statistics for each key pool
        const pools = result.data.pools;
        Object.entries(pools).forEach(([poolId, stats]) => {
            console.log(`\n🎯 Key pool: ${poolId}`);
            console.log(`  Total keys: ${stats.total_keys}`);
            console.log(`  Keys with data: ${stats.keys_with_data}`);
            console.log(`  Tokens used: ${formatTokens(stats.total_used)}`);
            console.log(`  Total tokens: ${formatTokens(stats.total_limit)}`);
            console.log(`  Tokens remaining: ${formatTokens(stats.total_remaining)}`);
            console.log(`  Usage percentage: ${stats.percentage}%`);
        });

        console.log('\n✅ Test passed!');
        return true;

    } catch (error) {
        console.error(`❌ Test failed: ${error.message}`);
        if (error.stack) {
            console.error(error.stack);
        }
        return false;
    }
}

/**
 * Format token counts
 */
function formatTokens(tokens) {
    if (!tokens && tokens !== 0) return '-';
    if (tokens >= 1000000) {
        return `${(tokens / 1000000).toFixed(1)}M`;
    } else if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`;
    }
    return tokens.toString();
}

/**
 * Run all tests
 */
async function runTests() {
    console.log('='.repeat(60));
    console.log('🚀 Token statistics by key pool test suite');
    console.log('='.repeat(60));
    console.log();

    const results = [];

    // Test the statistics-by-pool API
    results.push(await testTokenByPool());

    console.log('\n' + '='.repeat(60));
    console.log('📊 Test result summary:');
    console.log('='.repeat(60));
    console.log(`Total tests: ${results.length}`);
    console.log(`Passed: ${results.filter(r => r).length}`);
    console.log(`Failed: ${results.filter(r => !r).length}`);

    const allPassed = results.every(r => r);
    if (allPassed) {
        console.log('\n✅ All tests passed!');
        process.exit(0);
    } else {
        console.log('\n❌ Some tests failed!');
        process.exit(1);
    }
}

runTests();
