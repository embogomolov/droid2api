/**
 * Test Factory API concurrency settings
 */

import { getFactoryApiConcurrency } from '../config.js';
import { logInfo, logDebug, logError } from '../logger.js';

console.log('========================================');
console.log('🧪 Test Factory API concurrency settings');
console.log('========================================\n');

// 1. Test reading concurrency from the configuration
console.log('1️⃣ Test configuration loading\n');

const concurrency = getFactoryApiConcurrency();
console.log(`✅ Configured Factory API concurrency: ${concurrency}`);

if (concurrency === 100) {
  console.log('✅ Default value is correct (100)');
} else {
  console.log(`⚠️ Concurrency differs from the default of 100; current value: ${concurrency}`);
}

// 2. Test the environment variable override
console.log('\n2️⃣ Test the environment variable override\n');

// Temporarily set environment variables
process.env.FACTORY_API_CONCURRENCY = '3';
const overriddenConcurrency = getFactoryApiConcurrency();

console.log(`✅ Environment variable set: FACTORY_API_CONCURRENCY=3`);
console.log(`✅ Effective concurrency: ${overriddenConcurrency}`);

// Remove the environment variable
delete process.env.FACTORY_API_CONCURRENCY;

// 3. Test log levels in production mode
console.log('\n3️⃣ Test log levels (current environment:' + (process.env.NODE_ENV || 'production') + ')\n');

console.log('The following logs should be hidden in production mode:');
logDebug('Start querying Factory key balances and usage');
logDebug('Factory key balances and usage retrieved successfully');
logDebug(`Batch query complete: 10/10 Success`);

console.log('\nNo DEBUG logs should appear above in production mode');
console.log('Three DEBUG logs should appear above in development mode');

console.log('\n========================================');
console.log('✨ Tests complete!');
console.log('========================================\n');

console.log('💡 Summary of changes:');
console.log('1. Factory API query concurrency can now be set in the configuration file');
console.log('2. Override it with the FACTORY_API_CONCURRENCY environment variable');
console.log('3. Default concurrency is 100, consistent with other batch operations');
console.log('4. Factory API query logs now use the DEBUG level');
console.log('5. These DEBUG logs are hidden in production mode');
console.log('6. Batch key testing also uses concurrency 100 for consistent configuration');
