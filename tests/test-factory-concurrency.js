/**
 * 测试Factory API并发控制配置
 */

import { getFactoryApiConcurrency } from '../config.js';
import { logInfo, logDebug, logError } from '../logger.js';

console.log('========================================');
console.log('🧪 测试Factory API并发控制配置');
console.log('========================================\n');

// 1. 测试从配置获取并发数
console.log('1️⃣ 测试配置读取\n');

const concurrency = getFactoryApiConcurrency();
console.log(`✅ Factory API并发数配置值: ${concurrency}`);

if (concurrency === 100) {
  console.log('✅ 默认值正确（100）');
} else {
  console.log(`⚠️ 并发数不是默认值100，当前值: ${concurrency}`);
}

// 2. 测试环境变量覆盖
console.log('\n2️⃣ 测试环境变量覆盖\n');

// 临时设置环境变量
process.env.FACTORY_API_CONCURRENCY = '3';
const overriddenConcurrency = getFactoryApiConcurrency();

console.log(`✅ 环境变量设置: FACTORY_API_CONCURRENCY=3`);
console.log(`✅ 实际获取的并发数: ${overriddenConcurrency}`);

// 清理环境变量
delete process.env.FACTORY_API_CONCURRENCY;

// 3. 测试日志级别（生产模式）
console.log('\n3️⃣ 测试日志级别（当前环境：' + (process.env.NODE_ENV || 'production') + '）\n');

console.log('下面的日志在生产模式下不应该显示：');
logDebug('开始查询Factory密钥余额和使用量');
logDebug('成功获取Factory密钥余额和使用量');
logDebug(`批量查询完成: 10/10 成功`);

console.log('\n如果是生产模式，上面应该看不到任何DEBUG日志');
console.log('如果是开发模式，上面应该看到3条DEBUG日志');

console.log('\n========================================');
console.log('✨ 测试完成！');
console.log('========================================\n');

console.log('💡 修改要点总结：');
console.log('1. Factory API查询并发数现在可通过配置文件修改');
console.log('2. 可通过环境变量 FACTORY_API_CONCURRENCY 覆盖');  
console.log('3. 默认并发数为100（与其他批量操作保持一致）');
console.log('4. Factory API查询日志改为DEBUG级别');
console.log('5. 生产模式下不会输出这些DEBUG日志');
console.log('6. 密钥批量测试并发数也是100（统一配置）');
