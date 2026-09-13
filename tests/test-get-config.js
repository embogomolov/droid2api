/**
 * Test the getConfig function
 */

import { getConfig } from '../config.js';

const config = getConfig();

console.log('=== Full configuration ===');
console.log(JSON.stringify(config, null, 2));

console.log('\n=== Check key fields ===');
console.log('port:', config.port);
console.log('dev_mode:', config.dev_mode);
console.log('user_agent:', config.user_agent);
console.log('system_prompt:', config.system_prompt ? 'Present' : 'Missing');
console.log('models:', Array.isArray(config.models) ? `${config.models.length} models` : 'Missing');
console.log('endpoint:', Array.isArray(config.endpoint) ? `${config.endpoint.length} endpoints` : 'Missing');
console.log('key_pool:', config.key_pool ? 'Present' : 'Missing');
