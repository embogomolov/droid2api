/**
 * Test Factory balance management
 */
import 'dotenv/config';
import { getFactoryBalanceManager } from './balance/factory-balance-manager.js';
import keyPoolManager from './auth.js';
import { logInfo, logError } from './logger.js';

async function test() {
    logInfo('========== Start testing Factory balance management ==========');

    try {
        // Initialize the manager
        const manager = getFactoryBalanceManager();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for initialization

        // 1. Test adding a Factory key
        logInfo('\n1. Test adding a Factory key...');
        const testKey = 'fk-test-' + Date.now();
        try {
            const keyObj = keyPoolManager.addKey(testKey, 'Test key');
            logInfo(`Key added successfully: ${keyObj.id} (Provider: ${keyObj.provider})`);
        } catch (e) {
            logInfo(`Key already exists or could not be added: ${e.message}`);
        }

        // 2. Test retrieving the balance summary
        logInfo('\n2. Test retrieving the balance summary...');
        const summary = manager.getBalanceSummary();
        logInfo(`Balance summary:`, summary);

        // 3. Test querying one key balance using the cache
        logInfo('\n3. Test querying one cached key balance...');
        const factoryKeys = keyPoolManager.keys.filter(k => k.provider === 'factory');
        if (factoryKeys.length > 0) {
            const testKeyObj = factoryKeys[0];
            const balance = await manager.getBalance(testKeyObj.api_key || testKeyObj.key, false);
            logInfo(`Key ${testKeyObj.id} balance:`, balance);
        } else {
            logInfo('No Factory keys available for testing');
        }

        // 4. Test forcing a balance refresh
        logInfo('\n4. Test forcing a balance refresh...');
        if (factoryKeys.length > 0) {
            const testKeyObj = factoryKeys[0];
            const balance = await manager.getBalance(testKeyObj.api_key || testKeyObj.key, true);
            logInfo(`Key ${testKeyObj.id} refreshed balance:`, balance);
        }

        // 5. Test synchronizing all balances
        logInfo('\n5. Test synchronizing all balances...');
        const syncResult = await manager.syncAllBalances();
        logInfo(`Synchronization results:`, syncResult);

        // 6. Test usage recording
        logInfo('\n6. Test usage recording...');
        if (factoryKeys.length > 0) {
            const testKeyObj = factoryKeys[0];
            manager.recordUsage(testKeyObj.api_key || testKeyObj.key, {
                total_tokens: 100,
                prompt_tokens: 50,
                completion_tokens: 50
            });
            const usage = manager.getUsageStats(testKeyObj.api_key || testKeyObj.key);
            logInfo(`Key ${testKeyObj.id} usage:`, usage);
        }

        // 7. Test data persistence
        logInfo('\n7. Test data persistence...');
        await manager.saveCache();
        logInfo('Data saved to file');

        // 8. Test loading cached data
        logInfo('\n8. Test loading cached data...');
        await manager.loadCache();
        const summaryAfterLoad = manager.getBalanceSummary();
        logInfo(`Summary after loading:`, summaryAfterLoad);

        // 9. Test removing expired data
        logInfo('\n9. Test removing expired data...');
        manager.cleanupOldData();
        logInfo('Expired data removed');

        // 10. Test scheduled synchronization
        logInfo('\n10. Scheduled synchronization settings...');
        logInfo(`Sync interval: ${manager.syncInterval / 60000} minutes`);
        logInfo(`Last sync: ${manager.lastSyncTime || 'Not synced'}`);

        logInfo('\n========== Tests complete ==========');

        // Stop automatic synchronization in the test environment
        manager.stopAutoSync();

    } catch (error) {
        logError(`Test failed: ${error.message}`, error);
    }

    // Exit the process
    process.exit(0);
}

// Run tests
test().catch(error => {
    logError('Test error:', error);
    process.exit(1);
});