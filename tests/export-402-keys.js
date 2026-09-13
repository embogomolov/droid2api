/**
 * Export and remove keys that returned HTTP 402 (insufficient balance)
 * HTTP 402 indicates that the key has exhausted its balance
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KeyPoolManager } from '../auth.js';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('========================================');
console.log('💰 Process keys that returned HTTP 402 (insufficient balance)');
console.log('========================================\n');

// Create a readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

async function handle402Keys() {
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
      error402: 0
    };
    
    // Collect keys that returned HTTP 402
    const keys402 = [];
    
    // Analyze each key
    for (const key of allKeys) {
      // Count keys by status
      if (key.status === 'active') stats.active++;
      else if (key.status === 'disabled') stats.disabled++;
      else if (key.status === 'banned') stats.banned++;
      
      // Check for a recorded HTTP 402 error or a ban (HTTP 402 normally triggers an automatic ban)
      if ((key.last_error && key.last_error.includes('402')) || 
          (key.status === 'banned' && key.ban_reason && key.ban_reason.includes('402'))) {
        stats.error402++;
        keys402.push(key);
        console.log(`💸 Found a key with an HTTP 402 error: ${key.id.substring(0, 30)}... (pool: ${key.poolGroup || 'default'})`);
      }
    }
    
    // Show the current status
    console.log(`\n📈 Current key-pool status:`);
    console.log(`   Active: ${stats.active}`);
    console.log(`   Disabled: ${stats.disabled}`);
    console.log(`   Blocked in proxy: ${stats.banned}`);
    console.log(`   HTTP 402 (insufficient balance): ${stats.error402}`);
    
    if (keys402.length === 0) {
      console.log('\n✨ No keys with HTTP 402 errors found!');
      rl.close();
      return;
    }
    
    // Prepare the export content
    const exportData = [];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const exportFileName = path.join(__dirname, `../data/402-keys-${timestamp}.txt`);
    
    // Build the export content
    exportData.push('========================================');
    exportData.push(`Keys with HTTP 402 errors (Insufficient balance)`);
    exportData.push(`Export time: ${new Date().toLocaleString('en-US')}`);
    exportData.push(`Total: ${keys402.length} keys`);
    exportData.push('========================================\n');
    
    // Group by pool
    const poolGroups = {};
    for (const key of keys402) {
      const pool = key.poolGroup || 'default';
      if (!poolGroups[pool]) {
        poolGroups[pool] = [];
      }
      poolGroups[pool].push(key);
    }
    
    // Export keys from each pool
    for (const [pool, keys] of Object.entries(poolGroups)) {
      exportData.push(`\n[Pool ${pool}] (${keys.length} keys)`);
      exportData.push('----------------------------------------');
      
      for (const key of keys) {
        exportData.push(`Key ID: ${key.id}`);
        exportData.push(`Key value: ${key.key}`);
        exportData.push(`Status: ${key.status}`);
        exportData.push(`Created at: ${key.created_at || 'N/A'}`);
        exportData.push(`Last used: ${key.last_used_at || 'N/A'}`);
        exportData.push(`Usage count: ${key.usage_count || 0}`);
        exportData.push(`Error count: ${key.error_count || 0}`);
        exportData.push(`Last error: ${key.last_error || 'N/A'}`);
        if (key.ban_reason) {
          exportData.push(`Ban reason: ${key.ban_reason}`);
        }
        exportData.push('');
      }
    }
    
    // Add summary statistics
    exportData.push('\n========================================');
    exportData.push('Summary statistics');
    exportData.push('========================================');
    for (const [pool, keys] of Object.entries(poolGroups)) {
      exportData.push(`Pool ${pool}: ${keys.length} keys`);
    }
    exportData.push(`\nTotal: ${keys402.length} keys with HTTP 402 errors`);
    
    // Write the file
    const exportContent = exportData.join('\n');
    fs.writeFileSync(exportFileName, exportContent, 'utf-8');
    
    console.log(`\n✅ Exported to file: ${exportFileName}`);
    console.log(`📝 The file contains details for ${keys402.length} keys with HTTP 402 errors.`);
    
    // Show a preview of the file content
    console.log('\n📄 File content preview:');
    console.log('----------------------------------------');
    const preview = exportData.slice(0, 15).join('\n');
    console.log(preview);
    if (exportData.length > 15) {
      console.log('... (See the file for the remaining content)');
    }
    console.log('----------------------------------------');
    
    // Ask whether to delete the keys
    console.log('\n⚠️ These keys have no remaining balance. Removing them is recommended to keep the pool healthy.');
    const answer = await askQuestion('\nRemove these keys with HTTP 402 errors from the pool?(yes/no): ');
    
    if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
      console.log('\n🗑️ Start removing keys with HTTP 402 errors...\n');
      
      let cleaned = 0;
      for (const key of keys402) {
        try {
          keyPoolManager.deleteKey(key.id);
          cleaned++;
          console.log(`   ✅ Deleted: ${key.id.substring(0, 30)}... (pool: ${key.poolGroup || 'default'})`);
        } catch (error) {
          console.log(`   ❌ Failed to delete: ${key.id.substring(0, 30)}... - ${error.message}`);
        }
      }
      
      // Save the updated key pool
      keyPoolManager.saveKeyPool();
      
      console.log(`\n✅ Cleanup complete!`);
      console.log(`   Deleted: ${cleaned} keys`);
      console.log(`   Remaining total: ${keyPoolManager.keys.length} keys`);
      
      // Create a cleanup log file
      const cleanupLog = path.join(__dirname, `../data/402-cleanup-${timestamp}.log`);
      const logContent = [
        `Cleanup time: ${new Date().toLocaleString('en-US')}`,
        `Keys removed: ${cleaned}`,
        `Total before cleanup: ${stats.total}`,
        `Total after cleanup: ${keyPoolManager.keys.length}`,
        `Backup file: ${exportFileName}`
      ].join('\n');
      fs.writeFileSync(cleanupLog, logContent, 'utf-8');
      console.log(`   Cleanup log: ${cleanupLog}`);
      
    } else {
      console.log('\n👍 Deletion canceled. The keys are saved in the text file for reference.');
    }
    
    // Show final statistics
    console.log('\n========================================');
    console.log('📊 Final key-pool status:');
    console.log('========================================');
    
    const finalStats = {};
    for (const key of keyPoolManager.keys) {
      const pool = key.poolGroup || 'default';
      if (!finalStats[pool]) {
        finalStats[pool] = { total: 0, active: 0, disabled: 0, banned: 0 };
      }
      finalStats[pool].total++;
      if (key.status === 'active') finalStats[pool].active++;
      else if (key.status === 'disabled') finalStats[pool].disabled++;
      else if (key.status === 'banned') finalStats[pool].banned++;
    }
    
    for (const [pool, stat] of Object.entries(finalStats)) {
      console.log(`   Pool ${pool}: ${stat.total} keys (active: ${stat.active}, disabled: ${stat.disabled}, blocked in proxy: ${stat.banned})`);
    }
    console.log(`   Total: ${keyPoolManager.keys.length} keys`);
    
  } catch (error) {
    console.error('❌ Error during processing:', error);
  } finally {
    rl.close();
  }
}

// Run processing
handle402Keys().catch(console.error);
