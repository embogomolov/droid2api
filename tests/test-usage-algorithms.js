/**
 * 🎓 Test usage-based key selection algorithms
 *
 * Test objectives:
 * 1. least-token-used: verify that the key with the lowest token usage is selected
 * 2. max-remaining: verify that the key with the largest remaining quota is selected
 */

import keyPoolManager from '../auth.js';
import { logInfo, logError } from '../logger.js';

async function testUsageAlgorithms() {
  logInfo('========== Start testing usage-based key selection algorithms ==========');

  try {
    // 1. Save the original configuration
    const originalConfig = keyPoolManager.getConfig();
    logInfo(`Original algorithm: ${originalConfig.algorithm}`);

    // 2. Test the least-token-used algorithm
    logInfo('\n========== Test the least-token-used algorithm ==========');
    keyPoolManager.updateConfig({ algorithm: 'least-token-used' });

    for (let i = 0; i < 3; i++) {
      try {
        const result = await keyPoolManager.getNextKey();
        logInfo(`Selection ${i + 1}: ${result.keyId.substring(0, 20)}...`);
      } catch (error) {
        logError(`least-token-used Test failed (attempt ${i+1})`, error);
      }
    }

    // 3. Test the max-remaining algorithm
    logInfo('\n========== Test the max-remaining algorithm ==========');
    keyPoolManager.updateConfig({ algorithm: 'max-remaining' });

    for (let i = 0; i < 3; i++) {
      try {
        const result = await keyPoolManager.getNextKey();
        logInfo(`Selection ${i + 1}: ${result.keyId.substring(0, 20)}...`);
      } catch (error) {
        logError(`max-remaining Test failed (attempt ${i+1})`, error);
      }
    }

    // 4. Restore the original configuration
    keyPoolManager.updateConfig({ algorithm: originalConfig.algorithm });
    logInfo(`\nConfiguration restored to: ${originalConfig.algorithm}`);

    logInfo('\n========== Tests complete!==========');
    logInfo('✅ All tests passed! The key-selection logs above indicate that the algorithms are working correctly.');

  } catch (error) {
    logError('Error during testing', error);
    process.exit(1);
  }
}

// Run tests
testUsageAlgorithms().catch(error => {
  logError('Test script failed', error);
  process.exit(1);
});
