/**
 * 自动清理402错误（余额不足）的密钥
 * 会先导出到txt文件备份，然后自动删除
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KeyPoolManager } from '../auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('========================================');
console.log('💰 自动清理402错误（余额不足）的密钥');
console.log('========================================\n');

async function cleanup402Keys() {
  try {
    // 创建KeyPoolManager实例
    const keyPoolManager = new KeyPoolManager();
    
    // 获取所有密钥
    const allKeys = keyPoolManager.keys;
    console.log(`📊 密钥池总数: ${allKeys.length}`);
    
    // 统计信息
    const stats = {
      total: allKeys.length,
      active: 0,
      disabled: 0,
      banned: 0,
      error402: 0
    };
    
    // 收集402错误的密钥
    const keys402 = [];
    
    // 分析每个密钥
    for (const key of allKeys) {
      // 统计状态
      if (key.status === 'active') stats.active++;
      else if (key.status === 'disabled') stats.disabled++;
      else if (key.status === 'banned') stats.banned++;
      
      // 检查是否有402错误记录或被封禁（通常402会导致自动封禁）
      if ((key.last_error && key.last_error.includes('402')) || 
          (key.status === 'banned' && key.ban_reason && key.ban_reason.includes('402'))) {
        stats.error402++;
        keys402.push(key);
        console.log(`💸 发现402错误密钥: ${key.id.substring(0, 30)}... (${key.poolGroup || 'default'}池)`);
      }
    }
    
    // 显示当前状态
    console.log(`\n📈 当前密钥池状态:`);
    console.log(`   活跃: ${stats.active}`);
    console.log(`   禁用: ${stats.disabled}`);
    console.log(`   封禁: ${stats.banned}`);
    console.log(`   402错误（余额不足）: ${stats.error402}`);
    
    if (keys402.length === 0) {
      console.log('\n✨ 没有发现402错误的密钥！');
      return;
    }
    
    // 准备导出内容
    const exportData = [];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const exportFileName = path.join(__dirname, `../data/402-keys-backup-${timestamp}.txt`);
    
    // 构建导出内容
    exportData.push('========================================');
    exportData.push(`402错误密钥备份 (余额不足)`);
    exportData.push(`备份时间: ${new Date().toLocaleString('zh-CN')}`);
    exportData.push(`总计: ${keys402.length} 个密钥`);
    exportData.push('========================================\n');
    
    // 按池分组
    const poolGroups = {};
    for (const key of keys402) {
      const pool = key.poolGroup || 'default';
      if (!poolGroups[pool]) {
        poolGroups[pool] = [];
      }
      poolGroups[pool].push(key);
    }
    
    // 导出每个池的密钥
    for (const [pool, keys] of Object.entries(poolGroups)) {
      exportData.push(`\n【${pool}池】 (${keys.length}个)`);
      exportData.push('----------------------------------------');
      
      for (const key of keys) {
        // 保存完整密钥信息以便恢复
        exportData.push(`密钥值: ${key.key}`);
        exportData.push(`密钥ID: ${key.id}`);
        exportData.push(`状态: ${key.status}`);
        exportData.push(`创建时间: ${key.created_at || 'N/A'}`);
        exportData.push(`最后错误: ${key.last_error || 'N/A'}`);
        exportData.push('');
      }
    }
    
    // 添加汇总信息
    exportData.push('\n========================================');
    exportData.push('汇总统计');
    exportData.push('========================================');
    for (const [pool, keys] of Object.entries(poolGroups)) {
      exportData.push(`${pool}池: ${keys.length}个`);
    }
    exportData.push(`\n总计: ${keys402.length}个402错误密钥`);
    
    // 写入备份文件
    const exportContent = exportData.join('\n');
    fs.writeFileSync(exportFileName, exportContent, 'utf-8');
    
    console.log(`\n✅ 已备份到文件: ${exportFileName}`);
    console.log(`📝 文件包含 ${keys402.length} 个402错误的密钥详情`);
    
    // 自动清理
    console.log('\n🗑️ 开始自动清理402错误密钥...\n');
    
    let cleaned = 0;
    for (const key of keys402) {
      try {
        keyPoolManager.deleteKey(key.id);
        cleaned++;
        console.log(`   ✅ 已删除: ${key.id.substring(0, 30)}... (${key.poolGroup || 'default'}池)`);
      } catch (error) {
        console.log(`   ❌ 删除失败: ${key.id.substring(0, 30)}... - ${error.message}`);
      }
    }
    
    // 保存更新后的密钥池
    keyPoolManager.saveKeyPool();
    
    console.log(`\n✅ 清理完成！`);
    console.log(`   已删除: ${cleaned}个密钥`);
    console.log(`   剩余总数: ${keyPoolManager.keys.length}个密钥`);
    console.log(`   备份文件: ${exportFileName}`);
    
    // 创建清理记录文件
    const cleanupLog = path.join(__dirname, `../data/402-cleanup-${timestamp}.log`);
    const logContent = [
      `清理时间: ${new Date().toLocaleString('zh-CN')}`,
      `清理数量: ${cleaned}个`,
      `清理前总数: ${stats.total}个`,
      `清理后总数: ${keyPoolManager.keys.length}个`,
      `备份文件: ${exportFileName}`,
      '',
      '清理详情:',
      ...keys402.map(k => `- ${k.id} (${k.poolGroup || 'default'}池)`)
    ].join('\n');
    fs.writeFileSync(cleanupLog, logContent, 'utf-8');
    console.log(`   清理日志: ${cleanupLog}`);
    
    // 显示最终统计
    console.log('\n========================================');
    console.log('📊 最终密钥池状态:');
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
      console.log(`   ${pool}池: ${stat.total}个 (活跃${stat.active}, 禁用${stat.disabled}, 封禁${stat.banned})`);
    }
    console.log(`   总计: ${keyPoolManager.keys.length}个密钥`);
    
    // 计算健康度
    const healthRate = ((finalStats.main?.active || 0) + (finalStats.freebies?.active || 0) + (finalStats.test?.active || 0)) / keyPoolManager.keys.length * 100;
    console.log(`   健康度: ${healthRate.toFixed(1)}% (活跃密钥比例)`);
    
  } catch (error) {
    console.error('❌ 处理过程出错:', error);
  }
}

// 执行清理
cleanup402Keys().catch(console.error);
