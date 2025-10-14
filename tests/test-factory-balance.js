/**
 * 测试Factory余额管理功能
 */
import 'dotenv/config';
import { getFactoryBalanceManager } from './balance/factory-balance-manager.js';
import keyPoolManager from './auth.js';
import { logInfo, logError } from './logger.js';

async function test() {
    logInfo('========== 开始测试Factory余额管理功能 ==========');

    try {
        // 初始化管理器
        const manager = getFactoryBalanceManager();
        await new Promise(resolve => setTimeout(resolve, 1000)); // 等待初始化

        // 1. 测试添加Factory密钥
        logInfo('\n1. 测试添加Factory密钥...');
        const testKey = 'fk-test-' + Date.now();
        try {
            const keyObj = keyPoolManager.addKey(testKey, '测试密钥');
            logInfo(`添加密钥成功: ${keyObj.id} (Provider: ${keyObj.provider})`);
        } catch (e) {
            logInfo(`密钥已存在或添加失败: ${e.message}`);
        }

        // 2. 测试获取余额汇总
        logInfo('\n2. 测试获取余额汇总...');
        const summary = manager.getBalanceSummary();
        logInfo(`余额汇总:`, summary);

        // 3. 测试单个密钥余额查询（使用缓存）
        logInfo('\n3. 测试单个密钥余额查询（缓存）...');
        const factoryKeys = keyPoolManager.keys.filter(k => k.provider === 'factory');
        if (factoryKeys.length > 0) {
            const testKeyObj = factoryKeys[0];
            const balance = await manager.getBalance(testKeyObj.api_key || testKeyObj.key, false);
            logInfo(`密钥 ${testKeyObj.id} 余额:`, balance);
        } else {
            logInfo('没有Factory密钥可供测试');
        }

        // 4. 测试强制刷新余额
        logInfo('\n4. 测试强制刷新余额...');
        if (factoryKeys.length > 0) {
            const testKeyObj = factoryKeys[0];
            const balance = await manager.getBalance(testKeyObj.api_key || testKeyObj.key, true);
            logInfo(`密钥 ${testKeyObj.id} 刷新后余额:`, balance);
        }

        // 5. 测试同步所有余额
        logInfo('\n5. 测试同步所有余额...');
        const syncResult = await manager.syncAllBalances();
        logInfo(`同步结果:`, syncResult);

        // 6. 测试使用量记录
        logInfo('\n6. 测试使用量记录...');
        if (factoryKeys.length > 0) {
            const testKeyObj = factoryKeys[0];
            manager.recordUsage(testKeyObj.api_key || testKeyObj.key, {
                total_tokens: 100,
                prompt_tokens: 50,
                completion_tokens: 50
            });
            const usage = manager.getUsageStats(testKeyObj.api_key || testKeyObj.key);
            logInfo(`密钥 ${testKeyObj.id} 使用量:`, usage);
        }

        // 7. 测试数据持久化
        logInfo('\n7. 测试数据持久化...');
        await manager.saveCache();
        logInfo('数据已保存到文件');

        // 8. 测试缓存加载
        logInfo('\n8. 测试缓存加载...');
        await manager.loadCache();
        const summaryAfterLoad = manager.getBalanceSummary();
        logInfo(`加载后的汇总:`, summaryAfterLoad);

        // 9. 测试清理过期数据
        logInfo('\n9. 测试清理过期数据...');
        manager.cleanupOldData();
        logInfo('过期数据已清理');

        // 10. 测试定时同步
        logInfo('\n10. 定时同步配置...');
        logInfo(`同步间隔: ${manager.syncInterval / 60000}分钟`);
        logInfo(`上次同步: ${manager.lastSyncTime || '未同步'}`);

        logInfo('\n========== 测试完成 ==========');

        // 停止自动同步（测试环境）
        manager.stopAutoSync();

    } catch (error) {
        logError(`测试失败: ${error.message}`, error);
    }

    // 退出进程
    process.exit(0);
}

// 运行测试
test().catch(error => {
    logError('测试异常:', error);
    process.exit(1);
});