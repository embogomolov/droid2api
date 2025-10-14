#!/usr/bin/env node

/**
 * 快速测试402错误封禁功能
 */

import keyPoolManager from '../auth.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('\n=== 快速测试402封禁功能 ===\n');

// 1. 获取第一个活动密钥
const keys = keyPoolManager.keys.filter(k => k.status === 'active');
if (keys.length === 0) {
  console.log('没有活动密钥可供测试');
  process.exit(1);
}

const testKey = keys[0];
console.log(`1. 测试密钥: ${testKey.id}`);
console.log(`   状态: ${testKey.status}`);

// 2. 封禁密钥
console.log('\n2. 封禁密钥...');
const result = keyPoolManager.banKey(testKey.id, '测试402封禁');
console.log(`   结果: ${result ? '✅ 成功' : '❌ 失败'}`);

// 3. 检查banned_keys.json
const bannedKeysPath = path.join(__dirname, '..', 'data', 'banned_keys.json');
if (fs.existsSync(bannedKeysPath)) {
  const bannedData = JSON.parse(fs.readFileSync(bannedKeysPath, 'utf-8'));
  console.log(`\n3. 封禁列表状态:`);
  console.log(`   - 封禁密钥数: ${bannedData.keys.length}`);
  console.log(`   - 总封禁次数: ${bannedData.stats.total_banned}`);
  
  if (bannedData.keys.length > 0) {
    console.log(`\n   封禁的密钥:`);
    bannedData.keys.forEach(key => {
      console.log(`   • ${key.id}`);
      console.log(`     封禁时间: ${key.banned_at}`);
      console.log(`     封禁原因: ${key.banned_reason}`);
    });
  }
} else {
  console.log('❌ banned_keys.json 不存在');
}

// 4. 检查主密钥池
console.log(`\n4. 主密钥池状态:`);
console.log(`   - 总密钥数: ${keyPoolManager.keys.length}`);
console.log(`   - 活动密钥数: ${keyPoolManager.getActiveKeyCount()}`);

console.log('\n=== 测试完成 ===\n');
