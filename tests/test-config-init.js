/**
 * 测试配置初始化机制
 * 用法: node tests/test-config-init.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const configPath = path.join(projectRoot, 'data', 'config.json');
const backupPath = path.join(projectRoot, 'data', 'config.json.test-backup');

console.log('🧪 测试配置初始化机制\n');
console.log('='.repeat(60));

// 步骤 1: 备份现有配置
console.log('\n📦 步骤 1: 备份现有配置');
if (fs.existsSync(configPath)) {
  fs.copyFileSync(configPath, backupPath);
  console.log('✅ 已备份 config.json → config.json.test-backup');
  fs.unlinkSync(configPath);
  console.log('✅ 已删除 config.json');
} else {
  console.log('ℹ️  config.json 不存在，跳过备份');
}

// 步骤 2: 设置环境变量
console.log('\n⚙️  步骤 2: 设置测试环境变量');
process.env.KEY_POOL_ALGORITHM = 'least-token-used';
process.env.KEY_POOL_MULTI_TIER_ENABLED = 'true';
process.env.NOTES_MAX_LENGTH = '2000';
process.env.REASONING_BUDGET_LOW = '8192';
console.log('✅ 已设置环境变量：');
console.log('   KEY_POOL_ALGORITHM=least-token-used');
console.log('   KEY_POOL_MULTI_TIER_ENABLED=true');
console.log('   NOTES_MAX_LENGTH=2000');
console.log('   REASONING_BUDGET_LOW=8192');

// 步骤 3: 动态导入 config.js 触发初始化
console.log('\n🚀 步骤 3: 加载 config.js（触发初始化）');
try {
  const config = await import('../config.js');
  console.log('✅ config.js 加载成功');
  
  // 步骤 4: 验证配置文件已创建
  console.log('\n🔍 步骤 4: 验证配置文件');
  if (fs.existsSync(configPath)) {
    console.log('✅ config.json 已创建');
    
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    
    // 验证配置项
    console.log('\n🎯 步骤 5: 验证配置项');
    const tests = [
      {
        name: 'KEY_POOL_ALGORITHM',
        actual: configData.key_pool?.algorithm,
        expected: 'least-token-used',
        pass: configData.key_pool?.algorithm === 'least-token-used'
      },
      {
        name: 'KEY_POOL_MULTI_TIER_ENABLED',
        actual: configData.key_pool?.multiTier?.enabled,
        expected: true,
        pass: configData.key_pool?.multiTier?.enabled === true
      },
      {
        name: 'NOTES_MAX_LENGTH',
        actual: configData.limits?.notes_max_length,
        expected: 2000,
        pass: configData.limits?.notes_max_length === 2000
      },
      {
        name: 'REASONING_BUDGET_LOW',
        actual: configData.reasoning_tokens?.low,
        expected: 8192,
        pass: configData.reasoning_tokens?.low === 8192
      }
    ];
    
    let allPassed = true;
    tests.forEach(test => {
      const status = test.pass ? '✅' : '❌';
      console.log(`${status} ${test.name}:`);
      console.log(`   期望: ${test.expected}`);
      console.log(`   实际: ${test.actual}`);
      if (!test.pass) allPassed = false;
    });
    
    if (allPassed) {
      console.log('\n✅ 所有测试通过！');
    } else {
      console.log('\n❌ 部分测试失败！');
    }
    
  } else {
    console.log('❌ config.json 未创建');
  }
  
} catch (error) {
  console.error('❌ 加载失败:', error.message);
}

// 步骤 6: 恢复备份
console.log('\n🔄 步骤 6: 恢复备份');
if (fs.existsSync(configPath)) {
  fs.unlinkSync(configPath);
  console.log('✅ 已删除测试 config.json');
}
if (fs.existsSync(backupPath)) {
  fs.copyFileSync(backupPath, configPath);
  fs.unlinkSync(backupPath);
  console.log('✅ 已恢复备份 config.json');
} else {
  console.log('ℹ️  无备份需要恢复');
}

console.log('\n' + '='.repeat(60));
console.log('🎉 测试完成！\n');
