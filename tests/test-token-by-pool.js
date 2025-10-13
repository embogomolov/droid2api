/**
 * 测试按密钥池分组的Token统计功能
 * 使用方法: node tests/test-token-by-pool.js
 */

import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_ACCESS_KEY;

if (!ADMIN_KEY) {
    console.error('❌ 错误: 请设置 ADMIN_ACCESS_KEY 环境变量');
    process.exit(1);
}

console.log('🧪 开始测试按密钥池分组的Token统计功能...\n');

/**
 * 测试 GET /admin/token/by-pool
 */
async function testTokenByPool() {
    console.log('📊 测试 GET /admin/token/by-pool...');
    
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
            throw new Error(`API返回失败: ${result.message || '未知错误'}`);
        }

        console.log('✅ 请求成功！\n');
        console.log('📋 响应数据:');
        console.log(JSON.stringify(result.data, null, 2));

        // 验证数据结构
        if (!result.data.pools) {
            throw new Error('响应数据缺少 pools 字段');
        }

        if (!result.data.cache_info) {
            throw new Error('响应数据缺少 cache_info 字段');
        }

        console.log('\n📊 密钥池统计:');
        console.log(`  总密钥池数: ${result.data.total_pools}`);
        console.log(`  最后同步时间: ${result.data.cache_info.last_sync || '未同步'}`);
        console.log(`  缓存是否过期: ${result.data.cache_info.is_expired ? '是' : '否'}`);

        // 打印每个密钥池的详细统计
        const pools = result.data.pools;
        Object.entries(pools).forEach(([poolId, stats]) => {
            console.log(`\n🎯 密钥池: ${poolId}`);
            console.log(`  总密钥数: ${stats.total_keys}`);
            console.log(`  有数据的密钥数: ${stats.keys_with_data}`);
            console.log(`  已使用Token: ${formatTokens(stats.total_used)}`);
            console.log(`  总Token: ${formatTokens(stats.total_limit)}`);
            console.log(`  剩余Token: ${formatTokens(stats.total_remaining)}`);
            console.log(`  使用百分比: ${stats.percentage}%`);
        });

        console.log('\n✅ 测试通过！');
        return true;

    } catch (error) {
        console.error(`❌ 测试失败: ${error.message}`);
        if (error.stack) {
            console.error(error.stack);
        }
        return false;
    }
}

/**
 * 格式化Token数量
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
 * 运行所有测试
 */
async function runTests() {
    console.log('='.repeat(60));
    console.log('🚀 Token按密钥池统计测试套件');
    console.log('='.repeat(60));
    console.log();

    const results = [];

    // 测试按密钥池统计API
    results.push(await testTokenByPool());

    console.log('\n' + '='.repeat(60));
    console.log('📊 测试结果汇总:');
    console.log('='.repeat(60));
    console.log(`总测试数: ${results.length}`);
    console.log(`通过: ${results.filter(r => r).length}`);
    console.log(`失败: ${results.filter(r => !r).length}`);

    const allPassed = results.every(r => r);
    if (allPassed) {
        console.log('\n✅ 所有测试通过！');
        process.exit(0);
    } else {
        console.log('\n❌ 部分测试失败！');
        process.exit(1);
    }
}

runTests();
