import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import keywordFilter from '../utils/keyword-filter.js';
import { sendSuccessResponse, sendErrorResponse, wrapAsync } from './admin-error-handlers.js';
import { logInfo, logWarn } from '../logger.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEYWORD_CONFIG_PATH = path.join(__dirname, '../data/keyword-filter.json');

const VALID_PATTERN_TYPES = new Set(['contains', 'exact', 'startsWith', 'endsWith', 'regex']);
const PATTERN_TYPE_MAP = {
  prefix: 'startsWith',
  suffix: 'endsWith'
};
const ACTION_TYPE_MAP = {
  remove_content: 'delete_keyword',
  remove: 'delete_keyword',
  delete_keyword: 'delete_keyword'
};
const VALID_ACTION_TYPES = new Set(['replace', 'delete_keyword', 'block']);
const DELETE_KEYWORD_MODES = new Set(['inline', 'targets', 'segment']);
const DEFAULT_DELETE_MODE = 'inline';
const DEFAULT_SEGMENT_DELIMITER = '\n\n';
const MAX_PRESERVE_KEYWORDS = 20;

function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function sanitizeLogging(logging = {}) {
  return {
    enabled: typeof logging.enabled === 'boolean' ? logging.enabled : true,
    logMatches: typeof logging.logMatches === 'boolean' ? logging.logMatches : true,
    logActions: typeof logging.logActions === 'boolean' ? logging.logActions : true
  };
}

function normalizePattern(pattern) {
  if (!pattern || typeof pattern !== 'object') {
    throw createValidationError('Rule pattern configuration is missing or malformed');
  }

  const rawType = pattern.type;
  const mappedType = PATTERN_TYPE_MAP[rawType] || rawType;
  const { value, caseSensitive } = pattern;

  if (!mappedType || !VALID_PATTERN_TYPES.has(mappedType)) {
    throw createValidationError(`Unsupported pattern.type: ${rawType}`);
  }

  if (typeof value !== 'string') {
    throw createValidationError('pattern.value must be a string');
  }

  return {
    type: mappedType,
    value,
    caseSensitive: !!caseSensitive
  };
}

function normalizeAction(action) {
  if (!action || typeof action !== 'object') {
    throw createValidationError('Rule action configuration is missing or malformed');
  }

  const rawType = action.type;
  const mappedType = ACTION_TYPE_MAP[rawType] || rawType;

  if (!mappedType || !VALID_ACTION_TYPES.has(mappedType)) {
    throw createValidationError(`Unsupported action.type: ${rawType}`);
  }

  if (mappedType === 'replace') {
    if (action.replacement !== undefined && typeof action.replacement !== 'string') {
      throw createValidationError('replace.replacement must be a string');
    }
    return {
      type: 'replace',
      replacement: typeof action.replacement === 'string' ? action.replacement : ''
    };
  }

  if (mappedType === 'block') {
    return { type: 'block' };
  }

  const rawMode = action.mode || DEFAULT_DELETE_MODE;
  const mode = DELETE_KEYWORD_MODES.has(rawMode) ? rawMode : DEFAULT_DELETE_MODE;
  const normalized = {
    type: 'delete_keyword',
    mode
  };

  if (mode === 'targets') {
    if (!Array.isArray(action.targets)) {
      throw createValidationError('delete_keyword.targets must be an array of strings');
    }

    const targets = action.targets
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean);

    if (targets.length === 0) {
      throw createValidationError('delete_keyword.targets requires at least one nonempty string');
    }

    normalized.targets = targets;
  }

  if (mode === 'segment') {
    if (action.delimiter !== undefined && typeof action.delimiter !== 'string') {
      throw createValidationError('delete_keyword.delimiter must be a string');
    }

    if (action.minLength !== undefined) {
      const minLength = Number(action.minLength);
      if (!Number.isFinite(minLength) || minLength < 0) {
        throw createValidationError('delete_keyword.minLength must be a number >= 0');
      }
      normalized.minLength = minLength;
    }

    if (action.preserveKeywords !== undefined) {
      if (!Array.isArray(action.preserveKeywords)) {
        throw createValidationError('delete_keyword.preserveKeywords must be an array of strings');
      }
      const keywords = action.preserveKeywords
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean);

      if (keywords.length > MAX_PRESERVE_KEYWORDS) {
        throw createValidationError(`delete_keyword.preserveKeywords supports at most ${MAX_PRESERVE_KEYWORDS} keywords`);
      }

      normalized.preserveKeywords = keywords;
    }

    normalized.delimiter = action.delimiter && action.delimiter.length > 0
      ? action.delimiter
      : DEFAULT_SEGMENT_DELIMITER;
  }

  return normalized;
}

function generateRuleId() {
  return `rule-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function sanitizeRule(rule, { preserveId = false } = {}) {
  if (!rule || typeof rule !== 'object') {
    throw createValidationError('Rule must be an object');
  }

  const name = typeof rule.name === 'string' ? rule.name.trim() : '';
  if (!name) {
    throw createValidationError('Rule name cannot be empty');
  }

  const sanitized = {
    ...rule,
    id: preserveId && rule.id ? String(rule.id) : (rule.id ? String(rule.id) : generateRuleId()),
    name,
    enabled: typeof rule.enabled === 'boolean' ? rule.enabled : true,
    pattern: normalizePattern(rule.pattern),
    action: normalizeAction(rule.action)
  };

  if (sanitized.description && typeof sanitized.description !== 'string') {
    sanitized.description = String(sanitized.description);
  }

  return sanitized;
}

function sanitizeConfig(config, { strict = false } = {}) {
  if (!config || typeof config !== 'object') {
    throw createValidationError('Configuration must be an object');
  }

  if (strict && typeof config.enabled !== 'boolean') {
    throw createValidationError('enabled field must be a boolean');
  }

  if (strict && !Array.isArray(config.rules)) {
    throw createValidationError('rules must be an array');
  }

  const sanitizedRules = [];
  if (Array.isArray(config.rules)) {
    for (const rule of config.rules) {
      try {
        sanitizedRules.push(sanitizeRule(rule, { preserveId: true }));
      } catch (error) {
        if (strict) {
          throw error;
        }
        logWarn(`[KeywordFilter] Skipping invalid rule ${rule?.id || '<unknown>'}: ${error.message}`);
      }
    }
  }

  return {
    enabled: typeof config.enabled === 'boolean' ? config.enabled : false,
    rules: sanitizedRules,
    logging: sanitizeLogging(config.logging || {})
  };
}

function wrapFsError(message, error) {
  const wrapped = new Error(`${message}: ${error.message}`);
  wrapped.statusCode = 500;
  return wrapped;
}

function writeKeywordConfig(config, { reload = true } = {}) {
  try {
    const payload = JSON.stringify(config, null, 2);
    fs.writeFileSync(KEYWORD_CONFIG_PATH, payload, 'utf-8');
    if (reload) {
      keywordFilter.reloadConfig();
    }
  } catch (error) {
    throw wrapFsError('Failed to write keyword filter configuration', error);
  }
}

function readKeywordConfig({ autoMigrate = true } = {}) {
  if (!fs.existsSync(KEYWORD_CONFIG_PATH)) {
    keywordFilter.reloadConfig();
  }

  let raw;
  try {
    raw = fs.readFileSync(KEYWORD_CONFIG_PATH, 'utf-8');
  } catch (error) {
    throw wrapFsError('Failed to read keyword filter configuration', error);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw wrapFsError('Failed to parse keyword filter configuration', error);
  }

  if (!autoMigrate) {
    return parsed;
  }

  const sanitized = sanitizeConfig(parsed);
  const normalizedOriginal = JSON.stringify(parsed);
  const normalizedSanitized = JSON.stringify(sanitized);

  if (normalizedOriginal !== normalizedSanitized) {
    logWarn('[KeywordFilter] Invalid configuration detected; automatically corrected and saved');
    writeKeywordConfig(sanitized, { reload: false });
    keywordFilter.reloadConfig();
  }

  return sanitized;
}

// Get keyword filter configuration
router.get('/config', wrapAsync(async (req, res) => {
  const config = readKeywordConfig();
  sendSuccessResponse(res, config);
}, 'get keyword filter config'));

// Update keyword filter configuration
router.put('/config', wrapAsync(async (req, res) => {
  const sanitizedConfig = sanitizeConfig(req.body || {}, { strict: true });
  sanitizedConfig.lastUpdatedAt = new Date().toISOString();
  sanitizedConfig.lastUpdatedBy = req.headers['x-admin-key'] ? 'admin-key' : 'unknown';
  writeKeywordConfig(sanitizedConfig);
  logInfo('[KeywordFilter] Configuration updated via API');
  sendSuccessResponse(res, {
    message: 'Configuration updated successfully',
    config: sanitizedConfig
  });
}, 'update keyword filter config'));

// Get all rules
router.get('/rules', wrapAsync(async (req, res) => {
  const config = readKeywordConfig();
  sendSuccessResponse(res, config.rules);
}, 'get keyword filter rules'));

// Add a new rule
router.post('/rules', wrapAsync(async (req, res) => {
  const newRule = sanitizeRule(req.body || {});
  const config = readKeywordConfig({ autoMigrate: false });

  if (!Array.isArray(config.rules)) {
    config.rules = [];
  }

  if (config.rules.some(rule => rule.id === newRule.id)) {
    return sendErrorResponse(res, 409, `Rule ID already exists: ${newRule.id}`);
  }

  config.rules.push(newRule);

  const sanitizedConfig = sanitizeConfig(config);
  writeKeywordConfig(sanitizedConfig);

  logInfo(`[KeywordFilter] Rule added: ${newRule.name} (${newRule.id})`);
  sendSuccessResponse(res, { message: 'Rule added successfully', rule: newRule });
}, 'add keyword filter rule'));

// Update a rule
router.put('/rules/:ruleId', wrapAsync(async (req, res) => {
  const { ruleId } = req.params;
  const config = readKeywordConfig({ autoMigrate: false });

  if (!Array.isArray(config.rules)) {
    return sendErrorResponse(res, 404, `Rule not found: ${ruleId}`);
  }

  const ruleIndex = config.rules.findIndex(rule => rule.id === ruleId);
  if (ruleIndex === -1) {
    return sendErrorResponse(res, 404, `Rule not found: ${ruleId}`);
  }

  const sanitizedRule = sanitizeRule({ ...req.body, id: ruleId }, { preserveId: true });
  config.rules[ruleIndex] = sanitizedRule;

  const sanitizedConfig = sanitizeConfig(config);
  writeKeywordConfig(sanitizedConfig);

  logInfo(`[KeywordFilter] Rule updated: ${ruleId}`);
  sendSuccessResponse(res, { message: 'Rule updated successfully', rule: sanitizedRule });
}, 'update keyword filter rule'));

// Delete a rule
router.delete('/rules/:ruleId', wrapAsync(async (req, res) => {
  const { ruleId } = req.params;
  const config = readKeywordConfig({ autoMigrate: false });

  if (!Array.isArray(config.rules)) {
    return sendErrorResponse(res, 404, `Rule not found: ${ruleId}`);
  }

  const ruleIndex = config.rules.findIndex(rule => rule.id === ruleId);
  if (ruleIndex === -1) {
    return sendErrorResponse(res, 404, `Rule not found: ${ruleId}`);
  }

  const [deletedRule] = config.rules.splice(ruleIndex, 1);

  const sanitizedConfig = sanitizeConfig(config);
  writeKeywordConfig(sanitizedConfig);

  logInfo(`[KeywordFilter] Rule deleted: ${ruleId}`);
  sendSuccessResponse(res, { message: 'Rule deleted successfully', rule: deletedRule });
}, 'delete keyword filter rule'));

// Toggle a rule on or off
router.patch('/rules/:ruleId/toggle', wrapAsync(async (req, res) => {
  const { ruleId } = req.params;
  const config = readKeywordConfig({ autoMigrate: false });

  if (!Array.isArray(config.rules)) {
    return sendErrorResponse(res, 404, `Rule not found: ${ruleId}`);
  }

  const rule = config.rules.find(r => r.id === ruleId);
  if (!rule) {
    return sendErrorResponse(res, 404, `Rule not found: ${ruleId}`);
  }

  rule.enabled = !rule.enabled;

  const sanitizedConfig = sanitizeConfig(config);
  writeKeywordConfig(sanitizedConfig);

  logInfo(`[KeywordFilter] Rule toggled: ${ruleId} -> ${rule.enabled ? 'enabled' : 'disabled'}`);
  sendSuccessResponse(res, { message: 'Rule toggled successfully', rule });
}, 'toggle keyword filter rule'));

// Toggle the filter globally
router.patch('/toggle', wrapAsync(async (req, res) => {
  const config = readKeywordConfig({ autoMigrate: false });
  config.enabled = !config.enabled;

  const sanitizedConfig = sanitizeConfig(config);
  writeKeywordConfig(sanitizedConfig);

  logInfo(`[KeywordFilter] Global filter ${sanitizedConfig.enabled ? 'enabled' : 'disabled'}`);
  sendSuccessResponse(res, { message: 'Global filter toggled successfully', enabled: sanitizedConfig.enabled });
}, 'toggle keyword filter'));

// Get statistics
router.get('/stats', wrapAsync(async (req, res) => {
  const stats = keywordFilter.getStats();
  sendSuccessResponse(res, stats);
}, 'get keyword filter stats'));

// Test a rule
router.post('/test', wrapAsync(async (req, res) => {
  const { text, ruleId } = req.body || {};

  if (!text || typeof text !== 'string') {
    return sendErrorResponse(res, 400, 'text parameter is required and must be a string');
  }

  const config = readKeywordConfig();

  if (ruleId) {
    const rule = config.rules.find(r => r.id === ruleId);
    if (!rule) {
      return sendErrorResponse(res, 404, `Rule not found: ${ruleId}`);
    }

    const matched = keywordFilter.matchPattern(text, rule.pattern);
    const filtered = matched ? keywordFilter.applyAction(text, rule.action, rule.pattern) : text;

    sendSuccessResponse(res, {
      matched,
      original: text,
      filtered,
      rule: rule.name
    });
  } else {
    const filtered = keywordFilter.filterText(text, 'test');

    sendSuccessResponse(res, {
      original: text,
      filtered,
      changed: text !== filtered
    });
  }
}, 'test keyword filter'));

// Reload configuration
router.post('/reload', wrapAsync(async (req, res) => {
  keywordFilter.reloadConfig();
  const stats = keywordFilter.getStats();

  logInfo('[KeywordFilter] Configuration reloaded via API');
  sendSuccessResponse(res, { message: 'Configuration reloaded successfully', stats });
}, 'reload keyword filter config'));

export default router;
