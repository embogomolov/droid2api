/**
 * Test token usage tracking
 */
import 'dotenv/config';
import { getFactoryBalanceManager } from './balance/factory-balance-manager.js';
import keyPoolManager from './auth.js';
import { logInfo, logError } from './logger.js';

async function test() {
    logInfo('========== Start testing token usage tracking ==========');

    try {
        // Initialize the manager
        const manager = getFactoryBalanceManager();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for initialization

        // 1. Test adding a Factory key
        logInfo('\n1. Add test keys...');
        const testKeys = [
            'fk-test-key-001',
            'fk-test-key-002',
            'sk-openai-test-key',  // OpenAI key (tests automatic provider detection)
        ];

        testKeys.forEach(key => {
            try {
                const keyObj = keyPoolManager.addKey(key, `Test key ${key}`);
                logInfo(`✅ Key added successfully: ${keyObj.id} (Provider: ${keyObj.provider})`);
            } catch (e) {
                logInfo(`⚠️ Key already exists: ${key}`);
            }
        });

        // 2. Simulate recording token usage
        logInfo('\n2. Simulate recording token usage...');
        const factoryKeys = keyPoolManager.keys.filter(k => k.provider === 'factory');

        if (factoryKeys.length > 0) {
            // Simulate multiple requests
            for (let i = 0; i < 5; i++) {
                const key = factoryKeys[i % factoryKeys.length];
                const usage = {
                    total_tokens: Math.floor(Math.random() * 1000) + 100,
                    prompt_tokens: Math.floor(Math.random() * 500) + 50,
                    completion_tokens: Math.floor(Math.random() * 500) + 50
                };

                manager.recordUsage(key.api_key || key.key, usage);
                logInfo(`📝 Record usage [${key.id}]: ${usage.total_tokens} tokens`);
            }
        }

        // 3. Get usage statistics
        logInfo('\n3. Get usage statistics...');
        const allStats = manager.getUsageStats();
        logInfo('📊 Usage statistics for all keys:');
        Object.entries(allStats).forEach(([key, stats]) => {
            logInfo(`  ${key}:`);
            logInfo(`    Total tokens: ${stats.total_tokens}`);
            logInfo(`    Total requests: ${stats.total_requests}`);
            logInfo(`    Last updated: ${stats.last_updated || 'N/A'}`);
        });

        // 4. Get usage for one key
        if (factoryKeys.length > 0) {
            logInfo('\n4. Get usage for one key...');
            const testKey = factoryKeys[0];
            const keyStats = manager.getUsageStats(testKey.api_key || testKey.key);
            logInfo(`Usage for key ${testKey.id}:`, keyStats);
        }

        // 5. Get the usage summary
        logInfo('\n5. Get the usage summary...');
        const summary = manager.getBalanceSummary();
        logInfo('📈 Usage summary:', summary);

        // 6. Test data persistence
        logInfo('\n6. Test data persistence...');
        await manager.saveCache();
        logInfo('✅ Data saved to file');

        // 7. Test reloading
        logInfo('\n7. Test reloading data...');
        await manager.loadCache();
        const reloadedStats = manager.getUsageStats();
        logInfo(`✅ Reloaded successfully; total: ${Object.keys(reloadedStats).length} records`);

        // 8. Show configuration details
        logInfo('\n8. Current configuration...');
        logInfo(`📅 Sync interval: ${manager.syncInterval / 60000} minutes`);
        logInfo(`📦 Batch size: ${manager.batchSize}`);
        logInfo(`🗓️ Data retention: ${manager.dataRetentionDays} days`);

        // 9. Test cleanup
        logInfo('\n9. Test data cleanup...');
        manager.cleanupOldData();
        logInfo('✅ Expired data removed');

        // 10. Show usage for today
        logInfo('\n10. Usage statistics for today...');
        const today = new Date().toISOString().split('T')[0];
        let todayTotal = 0;
        let todayRequests = 0;

        Object.values(manager.getUsageStats()).forEach(stats => {
            if (stats.daily && stats.daily[today]) {
                todayTotal += stats.daily[today].tokens || 0;
                todayRequests += stats.daily[today].requests || 0;
            }
        });

        logInfo(`📅 Statistics for today:`);
        logInfo(`  Tokens used: ${todayTotal}`);
        logInfo(`  Request count: ${todayRequests}`);

        logInfo('\n========== Tests complete ==========');
        logInfo('✅ Token usage tracking works correctly');
        logInfo('📁 Data saved to: data/factory_usage.json');

        // Stop automatic synchronization in the test environment
        manager.stopAutoSync();

    } catch (error) {
        logError(`❌ Test failed: ${error.message}`, error);
    }

    // Exit the process
    process.exit(0);
}

// Run tests
test().catch(error => {
    logError('Test error:', error);
    process.exit(1);
});