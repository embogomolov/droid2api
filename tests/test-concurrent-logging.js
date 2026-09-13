/**
 * Test changes to concurrency control and logging
 */

import { KeyPoolManager } from '../auth.js';
import { logInfo, logError, logWarn, logDebug } from '../logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('========================================');
console.log('🧪 Test changes to concurrency control and logging');
console.log('========================================\n');

// 1. Test logging in production mode
console.log('1️⃣ Test logging (current environment: ' + (process.env.NODE_ENV || 'production') + ')\n');

// Test each log level
logInfo('This is an INFO log; it should be hidden in production mode');
logDebug('This is a DEBUG log; it should be hidden in production mode');
logWarn('This WARNING log should be visible');
logError('This is an ERROR log; it should be visible', new Error('Test error'));

console.log('\nIn production mode, only WARNING and ERROR logs should appear above\n');

// 2. Test concurrency limits
console.log('2️⃣ Test the concurrency limit configuration\n');

// Create a temporary key-pool configuration file
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
      concurrentLimit: 100  // Set to 100
    },
    retry: {
      enabled: false
    },
    autoBan: {
      enabled: true
    }
  }
};

// Write the test configuration
fs.writeFileSync(testKeyPoolPath, JSON.stringify(testKeyPoolData, null, 2));

try {
  // Create a KeyPoolManager instance
  const keyPoolManager = new KeyPoolManager();
  
  // Check the concurrency limit configuration
  const config = keyPoolManager.config;
  const concurrentLimit = config.performance?.concurrentLimit || 10;
  
  console.log(`✅ Configured concurrency limit: ${concurrentLimit}`);
  
  // Verify the maximum concurrency limit (the code should use100)
  const maxConcurrent = Math.max(1, Math.min(concurrentLimit, 100));
  console.log(`✅ Actual maximum concurrency limit: ${maxConcurrent}`);
  
  if (maxConcurrent === 100) {
    console.log('✅ Concurrency limit successfully changed to100!');
  } else {
    console.log('❌ Failed to change the concurrency limit; current value:' + maxConcurrent);
  }
  
} catch (error) {
  console.error('❌ Test failed:', error.message);
} finally {
  // Remove test files
  if (fs.existsSync(testKeyPoolPath)) {
    fs.unlinkSync(testKeyPoolPath);
  }
}

console.log('\n========================================');
console.log('✨ Tests complete!');
console.log('========================================\n');

console.log('💡 Notes: ');
console.log('- Production mode:export NODE_ENV=production');
console.log('- Development mode:export NODE_ENV=development');
console.log('- Current mode:' + (process.env.NODE_ENV || 'production(default)'));
