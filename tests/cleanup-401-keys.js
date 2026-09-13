/**
 * Remove all invalid keys that returned HTTP 401
 * HTTP 401 indicates an expired or deleted key
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KeyPoolManager } from '../auth.js';
import { fetchTokenUsage } from '../utils/factory-api-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('========================================');
console.log('🧹 Remove invalid keys that returned HTTP 401');
console.log('========================================\n');

async function cleanup401Keys() {
  try {
    // Create a KeyPoolManager instance
    const keyPoolManager = new KeyPoolManager();
    
    // Get all keys
    const allKeys = keyPoolManager.keys;
    console.log(`📊 Total keys in the pool: ${allKeys.length}`);
    
    // Statistics
    const stats = {
      total: allKeys.length,
      active: 0,
      disabled: 0,
      banned: 0,
      error401: 0,
      cleaned: 0,
      tested: 0
    };
    
    // Collect keys to remove
    const keysToClean = [];
    const keysToTest = [];
    
    // Analyze each key
    for (const key of allKeys) {
      // Count keys by status
      if (key.status === 'active') stats.active++;
      else if (key.status === 'disabled') stats.disabled++;
      else if (key.status === 'banned') stats.banned++;
      
      // Check for a recorded HTTP 401 error
      if (key.last_error && key.last_error.includes('401')) {
        stats.error401++;
        keysToClean.push(key);
        console.log(`🔍 Found a key with an HTTP 401 error: ${key.id.substring(0, 30)}... (pool: ${key.poolGroup || 'default'})`);
      }
      // Disabled keys without a specific error message may need testing
      else if (key.status === 'disabled' && !key.last_test_result) {
        keysToTest.push(key);
      }
    }
    
    // Show the current status
    console.log(`\n📈 Current key-pool status:`);
    console.log(`   Active: ${stats.active}`);
    console.log(`   Disabled: ${stats.disabled}`);
    console.log(`   Blocked in proxy: ${stats.banned}`);
    console.log(`   HTTP 401 error: ${stats.error401}`);
    
    // Test any keys with an unknown status first
    if (keysToTest.length > 0) {
      console.log(`\n🧪 Testing ${keysToTest.length} keys with an unknown status...`);
      
      for (const key of keysToTest) {
        process.stdout.write(`   Testing ${key.id.substring(0, 20)}... `);
        try {
          const result = await fetchTokenUsage(key.key);
          if (result.success) {
            process.stdout.write('✅ Valid\n');
          } else if (result.status === 401 || (result.error && result.error === 'authentication_failed')) {
            process.stdout.write('❌ HTTP 401 error\n');
            stats.error401++;
            keysToClean.push(key);
          } else {
            process.stdout.write(`⚠️ Other error: ${result.status || result.error}\n`);
          }
        } catch (error) {
          if (error.message && error.message.includes('401')) {
            process.stdout.write('❌ HTTP 401 error\n');
            stats.error401++;
            keysToClean.push(key);
          } else {
            process.stdout.write(`⚠️ Test failed: ${error.message}\n`);
          }
        }
        stats.tested++;
      }
    }
    
    // Remove keys that returned HTTP 401
    if (keysToClean.length > 0) {
      console.log(`\n🗑️ Preparing to remove ${keysToClean.length} keys with HTTP 401 errors...`);
      
      // Ask for confirmation
      console.log('\n⚠️ Warning: Deletion cannot be undone!');
      console.log('Press Ctrl+C to cancel, or wait 5 seconds for automatic cleanup to start...');
      
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      console.log('\nStarting cleanup...\n');
      
      for (const key of keysToClean) {
        try {
          keyPoolManager.deleteKey(key.id);
          stats.cleaned++;
          console.log(`   ✅ Deleted: ${key.id.substring(0, 30)}... (pool: ${key.poolGroup || 'default'})`);
        } catch (error) {
          console.log(`   ❌ Failed to delete: ${key.id.substring(0, 30)}... - ${error.message}`);
        }
      }
      
      // Save the updated key pool
      keyPoolManager.saveKeyPool();
      console.log('\n✅ Key pool updated and saved');
    } else {
      console.log('\n✨ No keys with HTTP 401 errors found; the pool is healthy!');
    }
    
    // Show statistics after cleanup
    const remainingKeys = keyPoolManager.keys.length;
    console.log('\n========================================');
    console.log('📊 Cleanup summary:');
    console.log('========================================');
    console.log(`   Total before cleanup: ${stats.total}`);
    console.log(`   Keys tested: ${stats.tested}`);
    console.log(`   HTTP 401 errors: ${stats.error401}`);
    console.log(`   Keys removed: ${stats.cleaned}`);
    console.log(`   Remaining total: ${remainingKeys}`);
    console.log(`   Percentage removed: ${((stats.cleaned / stats.total) * 100).toFixed(1)}%`);
    
    // Show remaining keys by pool
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
    
    console.log('\n📊 Remaining keys by pool:');
    for (const [pool, stat] of Object.entries(poolStats)) {
      console.log(`   Pool ${pool}: ${stat.total} keys (active: ${stat.active}, disabled: ${stat.disabled}, blocked in proxy: ${stat.banned})`);
    }
    
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  }
}

// Run cleanup
cleanup401Keys().catch(console.error);
