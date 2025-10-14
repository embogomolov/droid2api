/**
 * 测试脚本：验证日期切换时统计数据是否正确重置
 *
 * 测试场景：
 * 1. 当前日期有数据 (2025-10-12: 837次请求)
 * 2. 模拟切换到新的一天 (2025-10-13)
 * 3. 验证getTodayStats()是否返回0
 */

import { getTodayStats, getStatsSummary } from '../utils/request-stats.js';

console.log('========================================');
console.log('📅 日期重置测试');
console.log('========================================\n');

// 1. 获取当前日期
const currentDate = new Date().toISOString().split('T')[0];
console.log(`当前日期: ${currentDate}\n`);

// 2. 获取今日统计
const todayStats = getTodayStats();
console.log('📊 getTodayStats() 返回:');
console.log(JSON.stringify(todayStats, null, 2));
console.log('');

// 3. 获取统计摘要
const summary = getStatsSummary();
console.log('📈 getStatsSummary() 返回:');
console.log(`  - total_requests: ${summary.total_requests}`);
console.log(`  - today_requests: ${summary.today_requests}`);
console.log(`  - total_tokens: ${summary.total_tokens}`);
console.log(`  - today_tokens: ${summary.today_tokens}`);
console.log('');

// 4. 分析问题
console.log('========================================');
console.log('🔍 问题分析:');
console.log('========================================');

if (summary.total_requests === summary.today_requests) {
  console.log('⚠️  警告: total_requests 等于 today_requests');
  console.log('   这说明今日数据没有正确重置，或者所有请求都在今天发生');
} else {
  console.log('✅ 正常: total_requests ≠ today_requests');
}

if (summary.today_requests === 0) {
  console.log('✅ 今日请求数为0（正常，如果今天是新的一天）');
} else {
  console.log(`ℹ️  今日已有 ${summary.today_requests} 次请求`);
}

console.log('\n========================================');
console.log('💡 建议:');
console.log('========================================');
console.log('如果日期切换后 today_requests 没有清零：');
console.log('1. 检查服务器时区设置');
console.log('2. 检查 new Date() 返回的日期是否正确');
console.log('3. 检查 request_stats.json 中是否有今天的键');
console.log('4. 检查前端是否正确调用了 /admin/stats/summary API');
