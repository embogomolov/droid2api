/**
 * 测试 getConfig 函数
 */

import { getConfig } from '../config.js';

const config = getConfig();

console.log('=== 完整配置 ===');
console.log(JSON.stringify(config, null, 2));

console.log('\n=== 检查关键字段 ===');
console.log('port:', config.port);
console.log('dev_mode:', config.dev_mode);
console.log('user_agent:', config.user_agent);
console.log('system_prompt:', config.system_prompt ? '存在' : '不存在');
console.log('models:', Array.isArray(config.models) ? `${config.models.length} 个模型` : '不存在');
console.log('endpoint:', Array.isArray(config.endpoint) ? `${config.endpoint.length} 个端点` : '不存在');
console.log('key_pool:', config.key_pool ? '存在' : '不存在');
