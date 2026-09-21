import express from 'express';
import fs from 'fs';
import path from 'path';
import keyPoolManager from '../auth.js';
import { logInfo, logError } from '../logger.js';
import { getWindowSync, validateWindowSync } from '../utils/window-sync.js';
import { updateConfig as updateFullConfig, saveConfig, loadConfig, getNotesMaxLength, getConfig } from '../config.js';
import {
  sendSuccessResponse,
  sendErrorResponse,
  sendBadRequest,
  wrapAsync,
  wrapSync
} from './admin-error-handlers.js';
import { adminAuth } from '../middleware/admin-auth.js'; // 🔧 Optimization: use shared authentication middleware

const router = express.Router();

// 🔧 Optimization: adminAuth moved to ../middleware/admin-auth.js to avoid duplicate code

// Apply authentication middleware to all admin routes
router.use(adminAuth);

router.get('/window-sync', wrapSync((req, res) => {
  sendSuccessResponse(res, getWindowSync(keyPoolManager).snapshot());
}, 'get window synchronization'));

router.put('/window-sync', wrapSync((req, res) => {
  const cfg = loadConfig();
  const settings = validateWindowSync(req.body, keyPoolManager.keys, cfg.models);
  saveConfig({ ...cfg, window_sync: settings });
  const scheduler = getWindowSync(keyPoolManager);
  scheduler.wake();
  sendSuccessResponse(res, { settings });
}, 'save window synchronization'));

router.patch('/keys/:id/exclusion', wrapAsync(async (req, res) => {
  if (typeof req.body.excluded !== 'boolean') return sendBadRequest(res, 'excluded must be a boolean');
  if (!keyPoolManager.keys.some(key => key.id === req.params.id)) return sendBadRequest(res, 'Key not found');
  await keyPoolManager.setKeyExclusion(req.params.id, req.body.excluded);
  sendSuccessResponse(res, { id: req.params.id, excluded: req.body.excluded });
}, 'change key exclusion'));

/**
 * GET /admin/stats
 * Get key pool statistics
 */
router.get('/stats', wrapSync((req, res) => {
  const stats = keyPoolManager.getStats();
  sendSuccessResponse(res, stats);
}, 'get stats'));

/**
 * GET /admin/keys
 * Get keys (with pagination, filters, and token usage information)
 * Query parameters:
 *   - page: Page number (default 1)
 *   - limit: Items per page (default 10)
 *   - status: Status filter (all | active | disabled | banned; default all)
 *   - poolGroup: Pool filter (all | default | custom pool name; default all)
 *   - includeTokenUsage: Include token usage information (true/false; default false)
 */
router.get('/keys', wrapAsync(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const status = req.query.status || 'all';
  const poolGroup = req.query.poolGroup || 'all';
  const includeTokenUsage = req.query.includeTokenUsage === 'true';

  const result = keyPoolManager.getKeys(page, limit, status, poolGroup);
  result.keys = result.keys.map(({ quota_balance, ...key }) => ({ ...key, routing: Object.fromEntries(
    [['standard', 'claude-haiku-4-5-20251001'], ['core', 'kimi-k3']].map(([group, model]) => {
      let blocked = null;
      try { blocked = getWindowSync(keyPoolManager).routingBlock(key, model); }
      catch { blocked = 'Window synchronization status is unavailable'; }
      const plan = keyPoolManager.config.algorithm === 'quota-aware' ? keyPoolManager.quotaBalancer?.lastPlan[group] : null;
      const decision = plan?.accounts.find(account => account.id === key.id);
      return [group, { blocked, quota: decision ? { ...decision, at: plan.at, selected: plan.selected === key.id } : null }];
    })
  ) }));

  // Load token-usage data if token usage information is requested
  if (includeTokenUsage) {
    try {
      // Dynamically import token-usage data
      const fs = await import('fs');
      const path = await import('path');
      const { fileURLToPath } = await import('url');

      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const tokenUsageFile = path.join(__dirname, '..', 'data', 'token_usage.json');

      if (fs.existsSync(tokenUsageFile)) {
        const tokenData = JSON.parse(fs.readFileSync(tokenUsageFile, 'utf-8'));

        // Merge token usage information into the key list
        result.keys = result.keys.map(key => {
          const tokenInfo = tokenData.keys[key.id];
          if (tokenInfo && tokenInfo.success && tokenInfo.standard) {
            return {
              ...key,
              token_usage: {
                used: tokenInfo.standard.orgTotalTokensUsed || 0,
                limit: tokenInfo.standard.totalAllowance || 0,
                remaining: tokenInfo.standard.remaining || 0,
                percentage: tokenInfo.standard.totalAllowance > 0
                  ? ((tokenInfo.standard.orgTotalTokensUsed || 0) / tokenInfo.standard.totalAllowance * 100).toFixed(1)
                  : 0,
                last_sync: tokenInfo.last_sync || null
              }
            };
          }
          return key;
        });
      }
    } catch (error) {
      logError('Failed to load token usage data for keys', error);
    }
  }

  sendSuccessResponse(res, result);
}, 'get keys'));

/**
 * GET /admin/keys/:id
 * Get details for a single key
 */
/**
 * GET /admin/keys/export
 * Export keys as a text file (one key per line)
 * Query parameters:
 *   - status: Status filter (all | active | disabled | banned; default all)
 * BaSui: This route must precede /keys/:id to avoid being matched as a key ID!
 */
router.get('/keys/export', wrapSync((req, res) => {
  const status = req.query.status || 'all';

  // Get all keys without pagination
  let keys = keyPoolManager.keys;

  // Filter by status
  if (status !== 'all') {
    keys = keys.filter(k => k.status === status);
  }

  // Generate text content with one key per line
  const txtContent = keys.map(k => k.key).join('\n');

  // Set response headers to trigger a browser download
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `keys_${status}_${timestamp}.txt`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(txtContent);

  logInfo(`Admin exported ${keys.length} keys (status: ${status})`);
}, 'export keys'));

router.get('/keys/:id', wrapSync((req, res) => {
  const keyId = req.params.id;
  const key = keyPoolManager.getKey(keyId);
  sendSuccessResponse(res, key);
}, 'get key'));

/**
 * POST /admin/keys
 * Add a single key
 * Body: { key: "fk-xxx", notes: "Notes", poolGroup: "freebies" }
 */
router.post('/keys', wrapSync((req, res) => {
  const { key, notes, poolGroup } = req.body;

  if (!key) {
    return sendBadRequest(res, 'Key is required');
  }

  if (!key.startsWith('fk-')) {
    return sendBadRequest(res, 'Invalid key format (must start with "fk-")');
  }

  // Limit notes length
  const maxLength = getNotesMaxLength();
  if (notes && notes.length > maxLength) {
    return sendBadRequest(res, `Notes too long (max ${maxLength} characters)`);
  }

  const newKey = keyPoolManager.addKey(key, notes || '', poolGroup || null);

  logInfo(`Admin added new key: ${newKey.id} (pool: ${newKey.poolGroup})`);

  sendSuccessResponse(res, newKey, 'Key added successfully');
}, 'add key'));

/**
 * POST /admin/keys/batch
 * Import keys in bulk
 * Body: { keys: ["fk-xxx", "fk-yyy", ...], poolGroup: "freebies", autoTest: true }
 * autoTest: Automatically test newly imported, untested keys (default false)
 */
router.post('/keys/batch', wrapAsync(async (req, res) => {
  const { keys, poolGroup, autoTest } = req.body;

  if (!keys || !Array.isArray(keys)) {
    return sendBadRequest(res, 'Keys array is required');
  }

  const results = keyPoolManager.importKeys(keys, poolGroup || null);

  logInfo(`Admin batch imported keys: ${results.success} success, ${results.duplicate} duplicate, ${results.invalid} invalid (pool: ${poolGroup || 'default'})`);

  // BaSui: If automatic testing is enabled, test newly imported keys and automatically ban HTTP 402 failures
  let testResults = null;
  if (autoTest && results.importedKeyIds && results.importedKeyIds.length > 0) {
    logInfo(`Auto-testing ${results.importedKeyIds.length} newly imported keys...`);
    testResults = await keyPoolManager.testUntestedKeys(results.importedKeyIds);
    logInfo(`Auto-test results: ${testResults.success} success, ${testResults.failed} failed, ${testResults.banned} banned (402)`);
  }

  sendSuccessResponse(res, {
    import: results,
    test: testResults
  }, 'Batch import completed' + (testResults ? ` with auto-test` : ''));
}, 'batch import keys'));

/**
 * GET /admin/keys/banned
 * Get all banned keys
 */
router.get('/keys/banned', wrapSync((req, res) => {
  const bannedKeys = keyPoolManager.getBannedKeys();
  const bannedData = keyPoolManager.loadBannedKeys();
  
  sendSuccessResponse(res, {
    keys: bannedKeys,
    stats: bannedData.stats,
    config: bannedData.config
  }, `Found ${bannedKeys.length} banned keys`);
}, 'get banned keys'));

/**
 * POST /admin/keys/:id/unban
 * Manually unban a key
 */
router.post('/keys/:id/unban', wrapSync((req, res) => {
  const keyId = req.params.id;
  
  try {
    const key = keyPoolManager.unbanKey(keyId);
    logInfo(`Admin manually unbanned key: ${keyId}`);
    sendSuccessResponse(res, key, 'Key unbanned successfully');
  } catch (error) {
    sendErrorResponse(res, error, 'unban key');
  }
}, 'unban key'));

/**
 * POST /admin/keys/check-unban
 * Manually trigger an automatic unban check
 */
router.post('/keys/check-unban', wrapAsync(async (req, res) => {
  logInfo('Admin triggered auto-unban check');
  
  const unbannedCount = await keyPoolManager.checkAutoUnban();
  
  sendSuccessResponse(res, {
    unbanned: unbannedCount,
    bannedKeys: keyPoolManager.getBannedKeys()
  }, `Auto-unban check completed: ${unbannedCount} keys unbanned`);
}, 'check auto-unban'));

/**
 * PATCH /admin/keys/banned-config
 * Update ban settings
 */
router.patch('/keys/banned-config', wrapSync((req, res) => {
  const { auto_unban_enabled, auto_unban_hours, retest_on_unban, max_unban_attempts } = req.body;
  
  const bannedData = keyPoolManager.loadBannedKeys();
  
  if (auto_unban_enabled !== undefined) {
    bannedData.config.auto_unban_enabled = auto_unban_enabled;
  }
  if (auto_unban_hours !== undefined) {
    bannedData.config.auto_unban_hours = auto_unban_hours;
  }
  if (retest_on_unban !== undefined) {
    bannedData.config.retest_on_unban = retest_on_unban;
  }
  if (max_unban_attempts !== undefined) {
    bannedData.config.max_unban_attempts = max_unban_attempts;
  }
  
  // Save settings
  const bannedKeysPath = path.join(process.cwd(), 'data', 'banned_keys.json');
  fs.writeFileSync(bannedKeysPath, JSON.stringify(bannedData, null, 2), 'utf-8');
  
  logInfo('Admin updated banned keys config', bannedData.config);
  sendSuccessResponse(res, bannedData.config, 'Banned keys config updated');
}, 'update banned config'));

/**
 * DELETE /admin/keys/disabled
 * Delete all disabled keys
 * BaSui: This route must precede /keys/:id or Express will treat disabled as an ID!
 */
router.delete('/keys/disabled', wrapSync((req, res) => {
  const count = keyPoolManager.deleteDisabledKeys();

  logInfo(`Admin deleted ${count} disabled keys`);

  sendSuccessResponse(res, { count }, `Deleted ${count} disabled keys`);
}, 'delete disabled keys'));

/**
 * DELETE /admin/keys/banned
 * Delete all banned keys
 * BaSui: This route must precede /keys/:id or Express will treat banned as an ID!
 */
router.delete('/keys/banned', wrapSync((req, res) => {
  const count = keyPoolManager.deleteBannedKeys();

  logInfo(`Admin deleted ${count} banned keys`);

  sendSuccessResponse(res, { count }, `Deleted ${count} banned keys`);
}, 'delete banned keys'));

/**
 * DELETE /admin/keys/:id
 * Delete a single key
 * BaSui: Place this parameterized route after specific routes to follow Express matching order!
 */
router.delete('/keys/:id', wrapSync((req, res) => {
  const keyId = req.params.id;
  const deletedKey = keyPoolManager.deleteKey(keyId);

  logInfo(`Admin deleted key: ${keyId}`);

  sendSuccessResponse(res, deletedKey, 'Key deleted successfully');
}, 'delete key'));

/**
 * PATCH /admin/keys/:id/toggle
 * Change key status (active <-> disabled)
 * Body: { status: "active" | "disabled" }
 */
router.patch('/keys/:id/toggle', wrapSync((req, res) => {
  const keyId = req.params.id;
  const { status } = req.body;

  // Allow switching to active to restore a banned key
  if (!status || !['active', 'disabled'].includes(status)) {
    return sendBadRequest(res, 'Invalid status (must be "active" or "disabled")');
  }

  const updatedKey = keyPoolManager.toggleKeyStatus(keyId, status);

  logInfo(`Admin toggled key status: ${keyId} -> ${status}`);

  sendSuccessResponse(res, updatedKey, 'Key status updated successfully');
}, 'toggle key status'));

/**
 * PATCH /admin/keys/:id/notes
 * Update key notes
 * Body: { notes: "New notes" }
 */
router.patch('/keys/:id/notes', wrapSync((req, res) => {
  const keyId = req.params.id;
  const { notes } = req.body;

  if (notes === undefined) {
    return sendBadRequest(res, 'Notes field is required');
  }

  // Limit notes length
  const maxLength = getNotesMaxLength();
  if (notes.length > maxLength) {
    return sendBadRequest(res, `Notes too long (max ${maxLength} characters)`);
  }

  const updatedKey = keyPoolManager.updateNotes(keyId, notes);

  logInfo(`Admin updated key notes: ${keyId}`);

  sendSuccessResponse(res, updatedKey, 'Key notes updated successfully');
}, 'update key notes'));

/**
 * PUT /admin/keys/:id
 * Update all key information (including the key itself and notes)
 * Body: { key: "fk-xxx", notes: "New notes" }
 * BaSui: This endpoint can change the key value itself; use with care!
 */
router.put('/keys/:id', wrapSync((req, res) => {
  const keyId = req.params.id;
  const { key, notes } = req.body;

  // Validate the new key format
  if (key && !key.startsWith('fk-')) {
    return sendBadRequest(res, 'Invalid key format (must start with "fk-")');
  }

  // Limit notes length
  const maxLength = getNotesMaxLength();
  if (notes && notes.length > maxLength) {
    return sendBadRequest(res, `Notes too long (max ${maxLength} characters)`);
  }

  // Get the existing key
  const existingKey = keyPoolManager.getKey(keyId);

  // Update key data
  const updates = {};
  if (key && key !== existingKey.key) {
    // Check whether the new key already exists
    const duplicate = keyPoolManager.keys.find(k => k.key === key && k.id !== keyId);
    if (duplicate) {
      return sendBadRequest(res, 'Key already exists in the pool');
    }
    updates.key = key;
    // Calibration and measurements belong to the credential, not its editable row ID.
    delete existingKey.quota_balance;
    delete existingKey.billing_limits;
    delete existingKey.limits_error;
    existingKey.last_test_result = 'pending';
    existingKey.status = 'disabled';
  }
  if (notes !== undefined) {
    updates.notes = notes;
  }

  // Apply updates
  Object.assign(existingKey, updates);
  keyPoolManager.saveKeyPool();

  logInfo(`Admin updated key: ${keyId}`, { credentialChanged: Boolean(updates.key), notesChanged: notes !== undefined });

  sendSuccessResponse(res, existingKey, 'Key updated successfully');
}, 'update key'));

/**
 * POST /admin/keys/:id/test
 * Test whether a single key is available
 */
router.post('/keys/:id/test', wrapAsync(async (req, res) => {
  const keyId = req.params.id;
  const result = await keyPoolManager.testKey(keyId);

  // Include detailed information in logs
  if (result.success) {
    logInfo(`Admin tested key: ${keyId} - SUCCESS (Status: ${result.status})`);
  } else {
    logInfo(`Admin tested key: ${keyId} - FAILED (Status: ${result.status}, Message: ${result.message})`);
  }

  sendSuccessResponse(res, result, 'Key test completed');
}, 'test key'));

/**
 * POST /admin/keys/test-all
 * Test all keys in batches
 * Query parameters:
 *   - poolGroup: Pool ID (optional; tests all pools when omitted)
 *   - concurrency: Concurrency (optional; defaults to the configured value)
 */
router.post('/keys/test-all', wrapAsync(async (req, res) => {
  const { poolGroup, concurrency } = req.query;
  
  logInfo('Admin started batch key test', { poolGroup, concurrency });

  const results = await keyPoolManager.testAllKeys(poolGroup, concurrency ? parseInt(concurrency) : undefined);

  logInfo(`Admin batch key test completed: ${results.success} success, ${results.failed} failed`);

  sendSuccessResponse(res, results, 'Batch test completed');
}, 'batch test keys'));

/**
 * GET /admin/config
 * Get the full system configuration from data/config.json
 * Returns the complete config.json object
 */
router.get('/config', wrapSync((req, res) => {
  const fullConfig = getConfig();
  sendSuccessResponse(res, fullConfig);
}, 'get config'));

/**
 * GET /admin/config/key-pool
 * Get key pool settings only (key_pool section; backward compatibility)
 * Returns: { algorithm, retry, autoBan, performance, multiTier }
 */
router.get('/config/key-pool', wrapSync((req, res) => {
  const keyPoolConfig = keyPoolManager.getConfig();
  sendSuccessResponse(res, keyPoolConfig);
}, 'get key pool config'));

/**
 * PUT /admin/config
 * Update the full system configuration (supports partial updates and deep merging)
 * Body: Any config.json fields, for example:
 *   { port: 3000, dev_mode: true, key_pool: { algorithm: "random" } }
 */
router.put('/config', wrapSync((req, res) => {
  const updates = req.body;
  if (updates?.window_sync !== undefined) return sendBadRequest(res, 'Use /admin/window-sync to validate and save window settings');

  if (!updates || Object.keys(updates).length === 0) {
    return sendBadRequest(res, 'Config data is required');
  }

  // Use keyPoolManager when updating only key_pool settings for backward compatibility
  if (Object.keys(updates).length === 1 && updates.key_pool) {
    const updatedConfig = keyPoolManager.updateConfig(updates.key_pool);
    logInfo('Admin updated key_pool config', { changes: updates.key_pool });
    return sendSuccessResponse(res, { key_pool: updatedConfig }, 'Key pool config updated successfully');
  }

  // Update the full configuration
  keyPoolManager.updateConfig(updates.key_pool ?? {}, updates);
  const updatedFullConfig = getConfig();

  logInfo('Admin updated full config', { changes: updates });

  sendSuccessResponse(res, updatedFullConfig, 'Config updated successfully');
}, 'update config'));

/**
 * PUT /admin/config/key-pool
 * Update key pool settings only (key_pool section)
 * Body: { algorithm?, retry?, autoBan?, performance?, multiTier? }
 */
router.put('/config/key-pool', wrapSync((req, res) => {
  const newConfig = req.body;

  if (!newConfig || Object.keys(newConfig).length === 0) {
    return sendBadRequest(res, 'Key pool config data is required');
  }

  const updatedConfig = keyPoolManager.updateConfig(newConfig);

  logInfo('Admin updated key_pool config', { changes: newConfig });

  sendSuccessResponse(res, updatedConfig, 'Key pool config updated successfully');
}, 'update key pool config'));

/**
 * POST /admin/config/reset
 * Reset key pool settings to defaults
 */
router.post('/config/reset', wrapSync((req, res) => {
  const defaultConfig = keyPoolManager.resetConfig();

  logInfo('Admin reset key_pool config to defaults');

  sendSuccessResponse(res, defaultConfig, 'Key pool config reset to defaults');
}, 'reset config'));

/**
 * GET /admin/keys/export
 * Export keys as a text file (one key per line)
 * Query parameters:
 *   - status: Status filter (all | active | disabled | banned; default all)
 * BaSui: This route must precede /keys/:id to avoid being matched as a key ID!
 */

// ========== 🚀 BaSui: Multi-tier key pool management API ==========

/**
 * GET /admin/pool-groups
 * Get statistics for all pools
 * Example return value:
 * [
 *   {
 *     id: "freebies",
 *     name: "Free-tier pool",
 *     priority: 1,
 *     description: "Free-tier keys",
 *     total: 50,
 *     active: 40,
 *     disabled: 5,
 *     banned: 5,
 *     usage_rate: 0.8
 *   }
 * ]
 */
router.get('/pool-groups', wrapSync((req, res) => {
  const stats = keyPoolManager.getPoolGroupStats();
  sendSuccessResponse(res, stats);
}, 'get pool groups stats'));

/**
 * POST /admin/pool-groups
 * Create a new pool group
 * Body: { id: "test-pool", name: "Test pool", priority: 3, description: "Description" }
 */
router.post('/pool-groups', wrapSync((req, res) => {
  const { id, name, priority, description } = req.body;

  if (!id || !name || priority === undefined) {
    return sendBadRequest(res, 'id, name, and priority are required');
  }

  // Check whether the ID already exists
  if (keyPoolManager.poolGroups.find(g => g.id === id)) {
    return sendBadRequest(res, `Pool group with id "${id}" already exists`);
  }

  // Create a new pool
  const newGroup = {
    id: id.trim(),
    name: name.trim(),
    priority: parseInt(priority),
    description: description || ''
  };

  keyPoolManager.poolGroups.push(newGroup);
  keyPoolManager.saveKeyPool();

  logInfo(`Admin created pool group: ${id} (priority ${priority})`);

  sendSuccessResponse(res, newGroup, 'Pool group created successfully');
}, 'create pool group'));

/**
 * DELETE /admin/pool-groups/:id
 * Delete a pool group (removes grouping without deleting keys)
 */
router.delete('/pool-groups/:id', wrapSync((req, res) => {
  const groupId = req.params.id;

  const index = keyPoolManager.poolGroups.findIndex(g => g.id === groupId);
  if (index === -1) {
    return sendBadRequest(res, `Pool group "${groupId}" not found`);
  }

  // Remove the pool
  const deleted = keyPoolManager.poolGroups.splice(index, 1)[0];

  // Count the keys belonging to this pool
  const affectedKeys = keyPoolManager.keys.filter(k => k.poolGroup === groupId);

  // Move these keys to the default pool
  affectedKeys.forEach(k => k.poolGroup = 'default');

  keyPoolManager.saveKeyPool();

  logInfo(`Admin deleted pool group: ${groupId} (${affectedKeys.length} keys moved to default)`);

  sendSuccessResponse(res, {
    deleted,
    affected_keys: affectedKeys.length
  }, 'Pool group deleted successfully');
}, 'delete pool group'));

/**
 * PATCH /admin/keys/:id/pool
 * Change the pool assigned to a key
 * Body: { poolGroup: "main" }
 */
router.patch('/keys/:id/pool', wrapSync((req, res) => {
  const keyId = req.params.id;
  const { poolGroup } = req.body;

  if (!poolGroup) {
    return sendBadRequest(res, 'poolGroup is required');
  }

  const key = keyPoolManager.getKey(keyId);
  const oldPool = key.poolGroup;

  key.poolGroup = poolGroup;
  keyPoolManager.saveKeyPool();

  logInfo(`Admin moved key ${keyId} from "${oldPool}" to "${poolGroup}"`);

  sendSuccessResponse(res, key, 'Key pool changed successfully');
}, 'change key pool'));

// ========== 🚀 BaSui: Bulk operations API ==========

/**
 * PATCH /admin/keys/batch-change-pool
 * Change pool assignments in bulk
 * Body: { keyIds: ["key1", "key2", ...], poolGroup: "main" }
 */
router.patch('/keys/batch-change-pool', wrapSync((req, res) => {
  const { keyIds, poolGroup } = req.body;

  if (!keyIds || !Array.isArray(keyIds) || keyIds.length === 0) {
    return sendBadRequest(res, 'keyIds array is required and must not be empty');
  }

  if (!poolGroup) {
    return sendBadRequest(res, 'poolGroup is required');
  }

  let count = 0;
  const errors = [];

  keyIds.forEach(keyId => {
    try {
      const key = keyPoolManager.getKey(keyId);
      if (key) {
        key.poolGroup = poolGroup;
        count++;
      } else {
        errors.push(`Key ${keyId} not found`);
      }
    } catch (err) {
      errors.push(`Key ${keyId}: ${err.message}`);
    }
  });

  keyPoolManager.saveKeyPool();

  logInfo(`Admin batch changed pool: ${count} keys moved to "${poolGroup}"`);

  sendSuccessResponse(res, { count, errors }, `Successfully moved ${count} keys to pool "${poolGroup}"`);
}, 'batch change pool'));

/**
 * PATCH /admin/keys/batch-toggle-status
 * Enable or disable keys in bulk
 * Body: { keyIds: ["key1", "key2", ...], status: "active" | "disabled" }
 */
router.patch('/keys/batch-toggle-status', wrapSync((req, res) => {
  const { keyIds, status } = req.body;

  if (!keyIds || !Array.isArray(keyIds) || keyIds.length === 0) {
    return sendBadRequest(res, 'keyIds array is required and must not be empty');
  }

  if (!status || !['active', 'disabled'].includes(status)) {
    return sendBadRequest(res, 'status must be "active" or "disabled"');
  }

  let count = 0;
  const errors = [];

  keyIds.forEach(keyId => {
    try {
      const key = keyPoolManager.getKey(keyId);
      if (key) {
        key.status = status;
        count++;
      } else {
        errors.push(`Key ${keyId} not found`);
      }
    } catch (err) {
      errors.push(`Key ${keyId}: ${err.message}`);
    }
  });

  keyPoolManager.saveKeyPool();

  const action = status === 'active' ? 'enabled' : 'disabled';
  logInfo(`Admin batch ${action}: ${count} keys`);

  sendSuccessResponse(res, { count, errors }, `Successfully ${action} ${count} keys`);
}, 'batch toggle status'));

/**
 * DELETE /admin/keys/batch-delete
 * Delete keys in bulk
 * Body: { keyIds: ["key1", "key2", ...] }
 */
router.delete('/keys/batch-delete', wrapSync((req, res) => {
  const { keyIds } = req.body;

  if (!keyIds || !Array.isArray(keyIds) || keyIds.length === 0) {
    return sendBadRequest(res, 'keyIds array is required and must not be empty');
  }

  let count = 0;
  const errors = [];

  keyIds.forEach(keyId => {
    try {
      keyPoolManager.deleteKey(keyId);
      count++;
    } catch (err) {
      errors.push(`Key ${keyId}: ${err.message}`);
    }
  });

  logInfo(`Admin batch deleted: ${count} keys`);

  sendSuccessResponse(res, { count, errors }, `Successfully deleted ${count} keys`);
}, 'batch delete keys'));

export default router;
