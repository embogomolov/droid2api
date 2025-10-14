/**
 * 清理所有401错误的无效密钥
 * 401错误表示密钥已失效或被删除
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KeyPoolManager } from '../auth.js';
import { fetchTokenUsage } from '../utils/factory-api-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('========================================');
console.log('🧹 清理401错误的无效密钥');
console.log('========================================\n');

async function cleanup401Keys() {
  try {
    // 创建KeyPoolManager实例
    const keyPoolManager = new KeyPoolManager();
    
    // 获取所有密钥
    const allKeys = keyPoolManager.keys;
    console.log(`📊 密钥池总数: ${allKeys.length}`);
    
    // 统计信息
    const stats = {
      total: allKeys.length,
      active: 0,
      disabled: 0,
      banned: 0,
      error401: 0,
      cleaned: 0,
      tested: 0
    };
    
    // 收集需要清理的密钥
    const keysToClean = [];
    const keysToTest = [];
    
    // 分析每个密钥
    for (const key of allKeys) {
      // 统计状态
      if (key.status === 'active') stats.active++;
      else if (key.status === 'disabled') stats.disabled++;
      else if (key.status === 'banned') stats.banned++;
      
      // 检查是否有401错误记录
      if (key.last_error && key.last_error.includes('401')) {
        stats.error401++;
        keysToClean.push(key);
        console.log(`🔍 发现401错误密钥: ${key.id.substring(0, 30)}... (${key.poolGroup || 'default'}池)`);
      }
      // 如果状态是disabled但没有明确的错误信息，可能需要测试
      else if (key.status === 'disabled' && !key.last_test_result) {
        keysToTest.push(key);
      }
    }
    
    // 显示当前状态
    console.log(`\n📈 当前密钥池状态:`);
    console.log(`   活跃: ${stats.active}`);
    console.log(`   禁用: ${stats.disabled}`);
    console.log(`   封禁: ${stats.banned}`);
    console.log(`   401错误: ${stats.error401}`);
    
    // 如果有需要测试的密钥，先测试它们
    if (keysToTest.length > 0) {
      console.log(`\n🧪 测试 ${keysToTest.length} 个状态不明的密钥...`);
      
      for (const key of keysToTest) {
        process.stdout.write(`   测试 ${key.id.substring(0, 20)}... `);
        try {
          const result = await fetchTokenUsage(key.key);
          if (result.success) {
            process.stdout.write('✅ 有效\n');
          } else if (result.status === 401 || (result.error && result.error === 'authentication_failed')) {
            process.stdout.write('❌ 401错误\n');
            stats.error401++;
            keysToClean.push(key);
          } else {
            process.stdout.write(`⚠️ 其他错误: ${result.status || result.error}\n`);
          }
        } catch (error) {
          if (error.message && error.message.includes('401')) {
            process.stdout.write('❌ 401错误\n');
            stats.error401++;
            keysToClean.push(key);
          } else {
            process.stdout.write(`⚠️ 测试失败: ${error.message}\n`);
          }
        }
        stats.tested++;
      }
    }
    
    // 清理401错误的密钥
    if (keysToClean.length > 0) {
      console.log(`\n🗑️ 准备清理 ${keysToClean.length} 个401错误的密钥...`);
      
      // 询问确认
      console.log('\n⚠️ 警告: 删除操作不可恢复！');
      console.log('按 Ctrl+C 取消，或等待5秒自动开始清理...');
      
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      console.log('\n开始清理...\n');
      
      for (const key of keysToClean) {
        try {
          keyPoolManager.deleteKey(key.id);
          stats.cleaned++;
          console.log(`   ✅ 已删除: ${key.id.substring(0, 30)}... (${key.poolGroup || 'default'}池)`);
        } catch (error) {
          console.log(`   ❌ 删除失败: ${key.id.substring(0, 30)}... - ${error.message}`);
        }
      }
      
      // 保存更新后的密钥池
      keyPoolManager.saveKeyPool();
      console.log('\n✅ 密钥池已更新并保存');
    } else {
      console.log('\n✨ 没有发现401错误的密钥，密钥池很健康！');
    }
    
    // 显示清理后的统计
    const remainingKeys = keyPoolManager.keys.length;
    console.log('\n========================================');
    console.log('📊 清理完成统计:');
    console.log('========================================');
    console.log(`   清理前总数: ${stats.total}`);
    console.log(`   测试密钥数: ${stats.tested}`);
    console.log(`   401错误数: ${stats.error401}`);
    console.log(`   已清理数: ${stats.cleaned}`);
    console.log(`   剩余总数: ${remainingKeys}`);
    console.log(`   清理比例: ${((stats.cleaned / stats.total) * 100).toFixed(1)}%`);
    
    // 按池分组显示剩余密钥
    const poolStats = {};
    for (const key of keyPoolManager.keys) {
      const pool = key.poolGroup || 'default';
      if (!poolStats[pool]) {
        poolStats[pool] = { total: 0, active: 0, disabled: 0, banned: 0 };
      }
      poolStats[pool].total++;
      if (key.status === 'active') poolStats[pool].active++;
      else if (key.status === 'disabled') poolStats[pool].disabled++;
      else if (key.status === 'banned') poolStats[pool].banned++;
    }
    
    console.log('\n📊 各密钥池剩余情况:');
    for (const [pool, stat] of Object.entries(poolStats)) {
      console.log(`   ${pool}池: ${stat.total}个 (活跃${stat.active}, 禁用${stat.disabled}, 封禁${stat.banned})`);
    }
    
  } catch (error) {
    console.error('❌ 清理过程出错:', error);
  }
}

// 执行清理
cleanup401Keys().catch(console.error);
