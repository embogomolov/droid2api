/**
 * Automatically remove keys that returned HTTP 402 (insufficient balance)
 * Export a backup to a text file before automatically deleting the keys
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KeyPoolManager } from '../auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('========================================');
console.log('💰 Automatically remove keys that returned HTTP 402 (insufficient balance)');
console.log('========================================\n');

async function cleanup402Keys() {
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
      return;
    }
    
    // Prepare the export content
    const exportData = [];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const exportFileName = path.join(__dirname, `../data/402-keys-backup-${timestamp}.txt`);
    
    // Build the export content
    exportData.push('========================================');
    exportData.push(`Backup of keys with HTTP 402 errors (Insufficient balance)`);
    exportData.push(`Backup time: ${new Date().toLocaleString('en-US')}`);
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
        // Save complete key details so they can be restored
        exportData.push(`Key value: ${key.key}`);
        exportData.push(`Key ID: ${key.id}`);
        exportData.push(`Status: ${key.status}`);
        exportData.push(`Created at: ${key.created_at || 'N/A'}`);
        exportData.push(`Last error: ${key.last_error || 'N/A'}`);
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
    
    // Write the backup file
    const exportContent = exportData.join('\n');
    fs.writeFileSync(exportFileName, exportContent, 'utf-8');
    
    console.log(`\n✅ Backup saved to file: ${exportFileName}`);
    console.log(`📝 The file contains details for ${keys402.length} keys with HTTP 402 errors.`);
    
    // Automatic cleanup
    console.log('\n🗑️ Start automatically removing keys with HTTP 402 errors...\n');
    
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
    console.log(`   Backup file: ${exportFileName}`);
    
    // Create a cleanup log file
    const cleanupLog = path.join(__dirname, `../data/402-cleanup-${timestamp}.log`);
    const logContent = [
      `Cleanup time: ${new Date().toLocaleString('en-US')}`,
      `Keys removed: ${cleaned}`,
      `Total before cleanup: ${stats.total}`,
      `Total after cleanup: ${keyPoolManager.keys.length}`,
      `Backup file: ${exportFileName}`,
      '',
      'Cleanup details:',
      ...keys402.map(k => `- ${k.id} (pool: ${k.poolGroup || 'default'})`)
    ].join('\n');
    fs.writeFileSync(cleanupLog, logContent, 'utf-8');
    console.log(`   Cleanup log: ${cleanupLog}`);
    
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
    
    // Calculate pool health
    const healthRate = ((finalStats.main?.active || 0) + (finalStats.freebies?.active || 0) + (finalStats.test?.active || 0)) / keyPoolManager.keys.length * 100;
    console.log(`   Health: ${healthRate.toFixed(1)}% (Percentage of active keys)`);
    
  } catch (error) {
    console.error('❌ Error during processing:', error);
  }
}

// Run cleanup
cleanup402Keys().catch(console.error);
