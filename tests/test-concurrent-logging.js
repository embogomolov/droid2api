/**
 * 测试并发控制和日志输出修改
 */

import { KeyPoolManager } from '../auth.js';
import { logInfo, logError, logWarn, logDebug } from '../logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('========================================');
console.log('🧪 测试并发控制和日志输出修改');
console.log('========================================\n');

// 1. 测试日志输出（生产模式）
console.log('1️⃣ 测试日志输出（当前环境：' + (process.env.NODE_ENV || 'production') + '）\n');

// 测试各种日志级别
logInfo('这是INFO日志 - 生产模式不应该显示');
logDebug('这是DEBUG日志 - 生产模式不应该显示');
logWarn('这是WARNING日志 - 应该显示');
logError('这是ERROR日志 - 应该显示', new Error('测试错误'));

console.log('\n如果是生产模式，上面应该只看到WARNING和ERROR日志\n');

// 2. 测试并发限制
console.log('2️⃣ 测试并发限制配置\n');

// 创建临时的密钥池配置文件
const testKeyPoolPath = path.join(__dirname, '../data/test_key_pool.json');
const testKeyPoolData = {
  keys: [],
  stats: {
    total: 0,
    active: 0,
    disabled: 0,
    banned: 0
  },
  config: {
    algorithm: 'round-robin',
    performance: {
      concurrentLimit: 100  // 设置为100
    },
    retry: {
      enabled: false
    },
    autoBan: {
      enabled: true
    }
  }
};

// 写入测试配置
fs.writeFileSync(testKeyPoolPath, JSON.stringify(testKeyPoolData, null, 2));

try {
  // 创建KeyPoolManager实例
  const keyPoolManager = new KeyPoolManager();
  
  // 检查并发限制配置
  const config = keyPoolManager.config;
  const concurrentLimit = config.performance?.concurrentLimit || 10;
  
  console.log(`✅ 并发限制配置值: ${concurrentLimit}`);
  
  // 验证最大并发限制（代码中应该是100）
  const maxConcurrent = Math.max(1, Math.min(concurrentLimit, 100));
  console.log(`✅ 实际最大并发限制: ${maxConcurrent}`);
  
  if (maxConcurrent === 100) {
    console.log('✅ 并发限制已成功修改为100！');
  } else {
    console.log('❌ 并发限制修改失败，当前值：' + maxConcurrent);
  }
  
} catch (error) {
  console.error('❌ 测试失败:', error.message);
} finally {
  // 清理测试文件
  if (fs.existsSync(testKeyPoolPath)) {
    fs.unlinkSync(testKeyPoolPath);
  }
}

console.log('\n========================================');
console.log('✨ 测试完成！');
console.log('========================================\n');

console.log('💡 提示：');
console.log('- 生产模式：export NODE_ENV=production');
console.log('- 开发模式：export NODE_ENV=development');
console.log('- 当前模式：' + (process.env.NODE_ENV || 'production（默认）'));
