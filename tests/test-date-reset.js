/**
 * Test script: verify that statistics reset correctly when the date changes
 *
 * Test scenarios:
 * 1. The current date has data (2025-10-12: 837 requests)
 * 2. Simulate switching to a new day (2025-10-13)
 * 3. Verify that getTodayStats() returns 0
 */

import { getTodayStats, getStatsSummary } from '../utils/request-stats.js';

console.log('========================================');
console.log('📅 Daily reset test');
console.log('========================================\n');

// 1. Get the current date
const currentDate = new Date().toISOString().split('T')[0];
console.log(`Current date: ${currentDate}\n`);

// 2. Get statistics for today
const todayStats = getTodayStats();
console.log('📊 getTodayStats() returned:');
console.log(JSON.stringify(todayStats, null, 2));
console.log('');

// 3. Get the statistics summary
const summary = getStatsSummary();
console.log('📈 getStatsSummary() returned:');
console.log(`  - total_requests: ${summary.total_requests}`);
console.log(`  - today_requests: ${summary.today_requests}`);
console.log(`  - total_tokens: ${summary.total_tokens}`);
console.log(`  - today_tokens: ${summary.today_tokens}`);
console.log('');

// 4. Analyze the issue
console.log('========================================');
console.log('🔍 Issue analysis:');
console.log('========================================');

if (summary.total_requests === summary.today_requests) {
  console.log('⚠️  Warning: total_requests equals today_requests');
  console.log('   This means daily data did not reset correctly, or all requests occurred today');
} else {
  console.log('✅ OK: total_requests ≠ today_requests');
}

if (summary.today_requests === 0) {
  console.log('✅ Today has 0 requests (expected if a new day has started)');
} else {
  console.log(`ℹ️  Requests so far today: ${summary.today_requests} requests`);
}

console.log('\n========================================');
console.log('💡 Suggestions:');
console.log('========================================');
console.log('If today_requests does not reset to zero after the date changes:');
console.log('1. Check the server time-zone setting');
console.log('2. Check whether new Date() returns the correct date');
console.log('3. Check whether request_stats.json has an entry for today');
console.log('4. Check whether the frontend correctly calls /admin/stats/summary');
