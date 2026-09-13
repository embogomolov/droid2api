#!/usr/bin/env node

/**
 * Quick test of proxy key blocking on HTTP 402
 */

import keyPoolManager from '../auth.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('\n=== Quick test of proxy key blocking on HTTP 402 ===\n');

// 1. Get the first active key
const keys = keyPoolManager.keys.filter(k => k.status === 'active');
if (keys.length === 0) {
  console.log('No active keys available for testing');
  process.exit(1);
}

const testKey = keys[0];
console.log(`1. Test key: ${testKey.id}`);
console.log(`   Status: ${testKey.status}`);

// 2. Block the key in the proxy
console.log('\n2. Block the key in the proxy...');
const result = keyPoolManager.banKey(testKey.id, 'Test proxy block for HTTP 402');
console.log(`   Result: ${result ? '✅ Success' : '❌ Failed'}`);

// 3. Check banned_keys.json
const bannedKeysPath = path.join(__dirname, '..', 'data', 'banned_keys.json');
if (fs.existsSync(bannedKeysPath)) {
  const bannedData = JSON.parse(fs.readFileSync(bannedKeysPath, 'utf-8'));
  console.log(`\n3. Proxy block-list status:`);
  console.log(`   - Proxy-blocked keys: ${bannedData.keys.length}`);
  console.log(`   - Total proxy blocks: ${bannedData.stats.total_banned}`);
  
  if (bannedData.keys.length > 0) {
    console.log(`\n   Proxy-blocked keys:`);
    bannedData.keys.forEach(key => {
      console.log(`   • ${key.id}`);
      console.log(`     Blocked at: ${key.banned_at}`);
      console.log(`     Block reason: ${key.banned_reason}`);
    });
  }
} else {
  console.log('❌ banned_keys.json Missing');
}

// 4. Check the main key pool
console.log(`\n4. Main key-pool status:`);
console.log(`   - Total keys: ${keyPoolManager.keys.length}`);
console.log(`   - Active keys: ${keyPoolManager.getActiveKeyCount()}`);

console.log('\n=== Tests complete ===\n');
