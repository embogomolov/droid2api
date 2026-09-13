/**
 * Test configuration initialization
 * Usage: node tests/test-config-init.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const configPath = path.join(projectRoot, 'data', 'config.json');
const backupPath = path.join(projectRoot, 'data', 'config.json.test-backup');

console.log('🧪 Test configuration initialization\n');
console.log('='.repeat(60));

// Step 1: Back up the existing configuration
console.log('\n📦 Step 1: Back up the existing configuration');
if (fs.existsSync(configPath)) {
  fs.copyFileSync(configPath, backupPath);
  console.log('✅ Backed up config.json → config.json.test-backup');
  fs.unlinkSync(configPath);
  console.log('✅ Deleted config.json');
} else {
  console.log('ℹ️  config.json does not exist; skipping backup');
}

// Step 2: Set environment variables
console.log('\n⚙️  Step 2: Set test environment variables');
process.env.KEY_POOL_ALGORITHM = 'least-token-used';
process.env.KEY_POOL_MULTI_TIER_ENABLED = 'true';
process.env.NOTES_MAX_LENGTH = '2000';
process.env.REASONING_BUDGET_LOW = '8192';
console.log('✅ Environment variables set:');
console.log('   KEY_POOL_ALGORITHM=least-token-used');
console.log('   KEY_POOL_MULTI_TIER_ENABLED=true');
console.log('   NOTES_MAX_LENGTH=2000');
console.log('   REASONING_BUDGET_LOW=8192');

// Step 3: Dynamically import config.js to trigger initialization
console.log('\n🚀 Step 3: Load config.js (triggers initialization)');
try {
  const config = await import('../config.js');
  console.log('✅ config.js loaded successfully');
  
  // Step 4: Verify that the configuration file was created
  console.log('\n🔍 Step 4: Verify the configuration file');
  if (fs.existsSync(configPath)) {
    console.log('✅ config.json created');
    
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    
    // Verify configuration values
    console.log('\n🎯 Step 5: Verify configuration values');
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
      console.log(`   Expected: ${test.expected}`);
      console.log(`   Actual: ${test.actual}`);
      if (!test.pass) allPassed = false;
    });
    
    if (allPassed) {
      console.log('\n✅ All tests passed!');
    } else {
      console.log('\n❌ Some tests failed!');
    }
    
  } else {
    console.log('❌ config.json was not created');
  }
  
} catch (error) {
  console.error('❌ Loading failed:', error.message);
}

// Step 6: Restore the backup
console.log('\n🔄 Step 6: Restore the backup');
if (fs.existsSync(configPath)) {
  fs.unlinkSync(configPath);
  console.log('✅ Removed test file config.json');
}
if (fs.existsSync(backupPath)) {
  fs.copyFileSync(backupPath, configPath);
  fs.unlinkSync(backupPath);
  console.log('✅ Backup restored config.json');
} else {
  console.log('ℹ️  No backup to restore');
}

console.log('\n' + '='.repeat(60));
console.log('🎉 Tests complete!\n');
