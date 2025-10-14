import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logWarn, logError, logDebug } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEYWORD_CONFIG_PATH = path.join(__dirname, '../data/keyword-filter.json');
const PATTERN_TYPE_MAP = {
  prefix: 'startsWith',
  suffix: 'endsWith'
};
const VALID_PATTERN_TYPES = new Set(['contains', 'exact', 'startsWith', 'endsWith', 'regex']);
const ACTION_TYPE_MAP = {
  remove_content: 'delete_keyword',
  remove: 'delete_keyword',
  delete_keyword: 'delete_keyword'
};
const VALID_ACTION_TYPES = new Set(['replace', 'delete_keyword', 'block']);
const DELETE_KEYWORD_MODES = new Set(['inline', 'targets', 'segment']);
const DEFAULT_DELETE_MODE = 'inline';
const DEFAULT_SEGMENT_DELIMITER = '\n\n';
const DEFAULT_LOGGING = {
  enabled: true,
  logMatches: true,
  logActions: true
};
const AUTO_DISABLE_MIN_MATCHES = 20;
const AUTO_DISABLE_SUPPRESSED_RATIO = 0.7;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createEmptyStats() {
  return {
    matches: 0,
    filtered: 0,
    suppressed: 0,
    totalRemovedChars: 0,
    lastTriggeredAt: null,
    autoDisabledAt: null,
    autoDisabledReason: null,
    consecutiveSuppressed: 0,
    alerts: 0
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

class KeywordFilter {
  constructor() {
    this.config = null;
    this.lastLoadTime = 0;
    this.regexCache = new Map();
    this.ruleStats = new Map();
    this.loadConfig();
  }

  normalizeAction(action) {
    if (!action || typeof action !== 'object') {
      logWarn('[KeywordFilter] Skip invalid action: not an object');
      return null;
    }

    const rawType = action.type;
    const mappedType = ACTION_TYPE_MAP[rawType] || rawType;

    if (!mappedType || !VALID_ACTION_TYPES.has(mappedType)) {
      logWarn(`[KeywordFilter] Skip action due to unknown type: ${rawType}`);
      return null;
    }

    if (mappedType === 'replace') {
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
      const targets = Array.isArray(action.targets)
        ? action.targets
            .filter(item => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean)
        : [];

      if (targets.length === 0) {
        normalized.mode = DEFAULT_DELETE_MODE;
      } else {
        normalized.targets = targets;
      }
    }

    if (mode === 'segment') {
      normalized.delimiter = typeof action.delimiter === 'string' && action.delimiter.length > 0
        ? action.delimiter
        : DEFAULT_SEGMENT_DELIMITER;

      if (action.minLength !== undefined) {
        const minLength = Number(action.minLength);
        if (Number.isFinite(minLength) && minLength >= 0) {
          normalized.minLength = minLength;
        }
      }

      if (Array.isArray(action.preserveKeywords)) {
        const keywords = action.preserveKeywords
          .filter(item => typeof item === 'string')
          .map(item => item.trim())
          .filter(Boolean);
        if (keywords.length > 0) {
          normalized.preserveKeywords = keywords;
        }
      }
    }

    return normalized;
  }

  normalizeRule(rule) {
    if (!rule || typeof rule !== 'object') {
      logWarn('[KeywordFilter] Skip invalid rule: not an object');
      return null;
    }

    const id = rule.id ? String(rule.id) : `rule-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const name = typeof rule.name === 'string' ? rule.name.trim() : '';
    if (!name) {
      logWarn(`[KeywordFilter] Skip rule ${id}: missing name`);
      return null;
    }

    const pattern = rule.pattern || {};
    const mappedPatternType = PATTERN_TYPE_MAP[pattern.type] || pattern.type;
    if (!mappedPatternType || !VALID_PATTERN_TYPES.has(mappedPatternType)) {
      logWarn(`[KeywordFilter] Skip rule ${id}: unknown pattern type ${pattern.type}`);
      return null;
    }

    if (typeof pattern.value !== 'string' || pattern.value.length === 0) {
      logWarn(`[KeywordFilter] Skip rule ${id}: invalid pattern value`);
      return null;
    }

    const action = this.normalizeAction(rule.action || {});
    if (!action) {
      logWarn(`[KeywordFilter] Skip rule ${id}: invalid action configuration`);
      return null;
    }

    const normalizedPattern = {
      type: mappedPatternType,
      value: pattern.value,
      caseSensitive: !!pattern.caseSensitive
    };

    const normalizedRule = {
      ...rule,
      id,
      name,
      enabled: typeof rule.enabled === 'boolean' ? rule.enabled : true,
      pattern: normalizedPattern,
      action,
      errors: Array.isArray(rule.errors) ? rule.errors : [],
      alerts: Array.isArray(rule.alerts) ? rule.alerts : []
    };

    if (normalizedRule.description && typeof normalizedRule.description !== 'string') {
      normalizedRule.description = String(normalizedRule.description);
    }

    return normalizedRule;
  }

  normalizeConfig(config) {
    if (!config || typeof config !== 'object') {
      return this.getDefaultConfig();
    }

    const logging = {
      ...DEFAULT_LOGGING,
      ...(config.logging || {})
    };
    logging.enabled = !!logging.enabled;
    logging.logMatches = !!logging.logMatches;
    logging.logActions = !!logging.logActions;

    const normalizedRules = Array.isArray(config.rules)
      ? config.rules.map(rule => this.normalizeRule(rule)).filter(Boolean)
      : [];

    return {
      enabled: typeof config.enabled === 'boolean' ? config.enabled : false,
      rules: normalizedRules,
      logging
    };
  }

  persistNormalizedConfig(original, normalized) {
    try {
      const originalPayload = JSON.stringify(original);
      const normalizedPayload = JSON.stringify(normalized);

      if (originalPayload !== normalizedPayload) {
        fs.writeFileSync(KEYWORD_CONFIG_PATH, JSON.stringify(normalized, null, 2), 'utf-8');
        logWarn('[KeywordFilter] Detected config anomalies, auto-fixed and saved');
      }
    } catch (error) {
      logWarn(`[KeywordFilter] Failed to persist normalized config: ${error.message}`);
    }
  }

  loadConfig() {
    try {
      if (!fs.existsSync(KEYWORD_CONFIG_PATH)) {
        logWarn('[KeywordFilter] Configuration file not found, creating default...');
        this.createDefaultConfig();
      }

      const configData = fs.readFileSync(KEYWORD_CONFIG_PATH, 'utf-8');
      const parsedConfig = JSON.parse(configData);
      const normalizedConfig = this.normalizeConfig(parsedConfig);

      this.persistNormalizedConfig(parsedConfig, normalizedConfig);

      this.config = normalizedConfig;
      this.lastLoadTime = Date.now();
      this.initializeRuleStats();
      
      if (this.config.enabled) {
        const enabledRules = this.config.rules.filter(r => r.enabled).length;
        logInfo(`[KeywordFilter] Loaded ${enabledRules} enabled rules from ${this.config.rules.length} total rules`);
      }
    } catch (error) {
      logError('[KeywordFilter] Failed to load configuration', error);
      this.config = this.getDefaultConfig();
    }
  }

  initializeRuleStats() {
    if (!this.ruleStats) {
      this.ruleStats = new Map();
    }

    const existingKeys = new Set(this.config.rules.map(rule => rule.id));

    for (const rule of this.config.rules) {
      if (!this.ruleStats.has(rule.id)) {
        this.ruleStats.set(rule.id, createEmptyStats());
      }
    }

    for (const key of Array.from(this.ruleStats.keys())) {
      if (!existingKeys.has(key)) {
        this.ruleStats.delete(key);
      }
    }
  }

  getDefaultConfig() {
    return {
      enabled: false,
      rules: [],
      logging: {
        enabled: true,
        logMatches: true,
        logActions: true
      }
    };
  }

  createDefaultConfig() {
    const defaultConfig = {
      enabled: true,
      rules: [
        {
          id: "rule-example",
          name: "示例规则",
          enabled: false,
          pattern: {
            type: "contains",
            value: "关键词",
            caseSensitive: false
          },
          action: {
            type: "replace",
            replacement: "替换词"
          },
          description: "这是一个示例规则"
        }
      ],
      logging: {
        enabled: true,
        logMatches: true,
        logActions: true
      }
    };

    try {
      fs.writeFileSync(KEYWORD_CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), 'utf-8');
      logInfo('[KeywordFilter] Default configuration created');
    } catch (error) {
      logError('[KeywordFilter] Failed to create default configuration', error);
    }
  }

  reloadConfig() {
    logInfo('[KeywordFilter] Reloading configuration...');
    this.loadConfig();
  }

  isEnabled() {
    return this.config && this.config.enabled;
  }

  matchPattern(text, pattern) {
    if (!text || !pattern) return false;

    const { type, value, caseSensitive } = pattern;
    const searchText = caseSensitive ? text : text.toLowerCase();
    const searchValue = caseSensitive ? value : value.toLowerCase();

    switch (type) {
      case 'contains':
        return searchText.includes(searchValue);
      
      case 'exact':
        return searchText === searchValue;
      
      case 'startsWith':
        return searchText.startsWith(searchValue);
      
      case 'endsWith':
        return searchText.endsWith(searchValue);
      
      case 'regex':
        try {
          const flags = caseSensitive ? '' : 'i';
          const regex = new RegExp(value, flags);
          return regex.test(text);
        } catch (error) {
          logError(`[KeywordFilter] Invalid regex pattern: ${value}`, error);
          return false;
        }
      
      default:
        logWarn(`[KeywordFilter] Unknown pattern type: ${type}`);
        return false;
    }
  }

  applyAction(text, action, pattern) {
    if (!text || !action) return text;

    const { type } = action;

    switch (type) {
      case 'replace':
        return this.performReplacement(text, pattern, action.replacement || '');
      case 'delete_keyword':
        return this.performDeleteKeyword(text, pattern, action);
      case 'block':
        return '';
      default:
        // 理论上不会走到这里，留作安全网
        return this.performLegacyAction(text, action, pattern);
    }
  }

  performReplacement(text, pattern, replacement) {
    if (pattern.type === 'regex') {
      try {
        const flags = pattern.caseSensitive ? 'g' : 'gi';
        const cacheKey = `${pattern.value}__${flags}`;
        let regex = this.regexCache.get(cacheKey);
        if (!regex) {
          regex = new RegExp(pattern.value, flags);
          this.regexCache.set(cacheKey, regex);
        }
        return text.replace(regex, replacement);
      } catch (error) {
        logError(`[KeywordFilter] Regex replacement failed: ${pattern.value}`, error);
        this.disableBrokenRule(pattern, error);
        return text;
      }
    }

    const searchValue = pattern.caseSensitive ? pattern.value : pattern.value.toLowerCase();
    const compareText = pattern.caseSensitive ? text : text.toLowerCase();

    let result = text;
    let index = compareText.indexOf(searchValue);

    while (index !== -1) {
      result = result.substring(0, index) + replacement + result.substring(index + pattern.value.length);
      const nextStart = index + replacement.length;
      const updatedCompare = pattern.caseSensitive ? result : result.toLowerCase();
      index = updatedCompare.indexOf(searchValue, nextStart);
    }

    return result;
  }

  performDeleteKeyword(text, pattern, action) {
    const mode = action.mode || DEFAULT_DELETE_MODE;

    if (mode === 'targets' && Array.isArray(action.targets) && action.targets.length > 0) {
      return this.performTargetsDeletion(text, pattern, action.targets);
    }

    if (mode === 'segment') {
      return this.performSegmentDeletion(text, pattern, action);
    }

    return this.performReplacement(text, pattern, '');
  }

  performTargetsDeletion(text, pattern, targets) {
    const caseSensitive = !!pattern.caseSensitive;

    return targets.reduce((result, target) => {
      if (!target) return result;

      try {
        const cacheKey = `__target__${target}__${caseSensitive ? 'g' : 'gi'}`;
        let regex = this.regexCache.get(cacheKey);
        if (!regex) {
          regex = new RegExp(escapeRegExp(target), caseSensitive ? 'g' : 'gi');
          this.regexCache.set(cacheKey, regex);
        }
        return result.replace(regex, '');
      } catch (error) {
        logError(`[KeywordFilter] Target deletion regex failed: ${target}`, error);
        this.disableBrokenRule(pattern, error);
        return result;
      }
    }, text);
  }

  performSegmentDeletion(text, pattern, action) {
    const delimiter = action.delimiter || DEFAULT_SEGMENT_DELIMITER;
    const minLength = typeof action.minLength === 'number' && action.minLength >= 0 ? action.minLength : 0;
    const caseSensitive = !!pattern.caseSensitive;
    const preserveKeywords = Array.isArray(action.preserveKeywords)
      ? action.preserveKeywords
          .filter(Boolean)
          .map(keyword => (caseSensitive ? keyword : keyword.toLowerCase()))
      : [];

    const segments = text.split(delimiter);
    const filteredSegments = segments.filter(segment => {
      const matches = this.matchPattern(segment, pattern);
      if (!matches) {
        return true;
      }

      if (segment.length < minLength) {
        return true;
      }

      if (preserveKeywords.length > 0) {
        const haystack = caseSensitive ? segment : segment.toLowerCase();
        const hitsKeyword = preserveKeywords.some(keyword => haystack.includes(keyword));
        if (hitsKeyword) {
          return true;
        }
      }

      return false;
    });

    return filteredSegments.join(delimiter);
  }

  performLegacyAction(text, action, pattern) {
    const { type, replacement } = action;
    switch (type) {
      case 'remove':
        return this.performReplacement(text, pattern, '');
      case 'replace':
        return this.performReplacement(text, pattern, replacement || '');
      case 'block':
        return '';
      default:
        logWarn(`[KeywordFilter] Unknown action type: ${type}`);
        return text;
    }
  }

  disableBrokenRule(pattern, error) {
    if (!this.config || !Array.isArray(this.config.rules)) {
      return;
    }

    const brokenRules = this.config.rules.filter(rule =>
      rule.pattern &&
      rule.pattern.type === pattern.type &&
      rule.pattern.value === pattern.value
    );

    if (brokenRules.length === 0) {
      return;
    }

    let hasChanges = false;

    brokenRules.forEach(rule => {
      const errorMessage = error?.message || '未知错误';
      rule.errors = rule.errors || [];
      rule.errors.push({
        timestamp: new Date().toISOString(),
        message: `正则解析失败: ${errorMessage}`
      });

      if (rule.enabled) {
        rule.enabled = false;
        hasChanges = true;
        logWarn(`[KeywordFilter] 自动禁用规则 ${rule.id} (${rule.name})，原因：正则解析失败 -> ${errorMessage}`);
      }
    });

    if (!hasChanges) {
      return;
    }

    try {
      fs.writeFileSync(KEYWORD_CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
      this.reloadConfig();
    } catch (writeError) {
      logError('[KeywordFilter] Failed to persist disabled rule state', writeError);
    }
  }

  recordRuleMatch(rule, { beforeText, afterText, removedChars }) {
    const stats = this.ruleStats.get(rule.id) || createEmptyStats();
    stats.matches += 1;
    stats.lastTriggeredAt = Date.now();

    if (beforeText !== afterText) {
      stats.filtered += 1;
      stats.totalRemovedChars += removedChars;
      stats.consecutiveSuppressed = 0;
    } else {
      stats.suppressed += 1;
      stats.consecutiveSuppressed += 1;
    }

    this.ruleStats.set(rule.id, stats);
    return stats;
  }

  evaluateRuleHealth(rule, stats) {
    if (!rule.enabled) {
      return;
    }

    if (stats.matches >= AUTO_DISABLE_MIN_MATCHES) {
      const suppressedRatio = stats.matches === 0 ? 0 : stats.suppressed / stats.matches;
      if (suppressedRatio >= AUTO_DISABLE_SUPPRESSED_RATIO) {
        this.autoDisableRule(rule, `suppressed ratio ${Math.round(suppressedRatio * 100)}% (>= ${AUTO_DISABLE_SUPPRESSED_RATIO * 100}%)`);
        stats.autoDisabledAt = Date.now();
        stats.autoDisabledReason = 'suppressed_ratio';
        stats.alerts += 1;
      }
    }
  }

  autoDisableRule(rule, reason) {
    if (!this.config || !Array.isArray(this.config.rules)) {
      return;
    }

    const targetRule = this.config.rules.find(r => r.id === rule.id);
    if (!targetRule || !targetRule.enabled) {
      return;
    }

    targetRule.enabled = false;
    targetRule.errors = targetRule.errors || [];
    targetRule.errors.push({
      timestamp: new Date().toISOString(),
      message: `自动降级: ${reason}`
    });
    targetRule.alerts = targetRule.alerts || [];
    targetRule.alerts.push({
      timestamp: new Date().toISOString(),
      reason
    });

    const stats = this.ruleStats.get(rule.id);
    if (stats) {
      const now = Date.now();
      stats.autoDisabledAt = now;
      stats.autoDisabledReason = reason;
      stats.alerts += 1;
      this.ruleStats.set(rule.id, stats);
    }

    logWarn(`[KeywordFilter] 自动降级规则 ${targetRule.id} (${targetRule.name})，原因：${reason}`);

    try {
      fs.writeFileSync(KEYWORD_CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (writeError) {
      logError('[KeywordFilter] Failed to persist auto-disabled rule state', writeError);
    }
  }

  filterText(text, context = 'unknown') {
    if (!text || !this.isEnabled()) {
      return text;
    }

    let filteredText = text;
    let matchCount = 0;
    const matchedRules = [];

    for (const rule of this.config.rules) {
      if (!rule.enabled) continue;

      if (this.matchPattern(filteredText, rule.pattern)) {
        matchCount++;
        matchedRules.push(rule.name || rule.id);

        const beforeLength = filteredText.length;
        const beforeText = filteredText;
        filteredText = this.applyAction(filteredText, rule.action, rule.pattern);
        const afterLength = filteredText.length;

        const stats = this.recordRuleMatch(rule, {
          beforeText,
          afterText: filteredText,
          removedChars: Math.max(0, beforeLength - afterLength)
        });

        this.evaluateRuleHealth(rule, stats);

        if (this.config.logging.enabled && this.config.logging.logActions) {
          logDebug(`[KeywordFilter] Rule "${rule.name}" matched in ${context}, ` +
                  `length: ${beforeLength} -> ${afterLength}`);
        }
      }
    }

    if (matchCount > 0 && this.config.logging.enabled && this.config.logging.logMatches) {
      logInfo(`[KeywordFilter] Filtered ${context}: ${matchCount} rule(s) matched [${matchedRules.join(', ')}]`);
    }

    return filteredText;
  }

  filterMessageContent(content, context) {
    if (typeof content === 'string') {
      return this.filterText(content, context);
    }

    if (!Array.isArray(content)) {
      return content;
    }

    let hasMutation = false;
    const filteredItems = content.map(item => {
      if (!item || typeof item !== 'object') {
        return item;
      }

      let mutated = false;
      let updatedItem = item;

      if (typeof item.text === 'string') {
        const filteredText = this.filterText(item.text, context);
        if (filteredText !== item.text) {
          updatedItem = { ...updatedItem, text: filteredText };
          mutated = true;
        }
      }

      if (Array.isArray(item.content)) {
        const nestedContent = this.filterMessageContent(item.content, context);
        if (nestedContent !== item.content) {
          updatedItem = updatedItem === item ? { ...updatedItem } : updatedItem;
          updatedItem.content = nestedContent;
          mutated = true;
        }
      }

      if (mutated) {
        hasMutation = true;
        return updatedItem;
      }

      return item;
    });

    return hasMutation ? filteredItems : content;
  }

  filterStructuredContent(value, context) {
    if (typeof value === 'string') {
      return this.filterText(value, context);
    }

    if (Array.isArray(value)) {
      let mutated = false;
      const filteredArray = value.map((item, index) => {
        const filteredItem = this.filterStructuredContent(item, `${context}[${index}]`);
        if (filteredItem !== item) {
          mutated = true;
        }
        return filteredItem;
      });
      return mutated ? filteredArray : value;
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    if (Buffer.isBuffer(value) || value instanceof Date || value instanceof RegExp) {
      return value;
    }

    if (!isPlainObject(value)) {
      return value;
    }

    let mutated = false;
    const filteredObject = { ...value };

    for (const [key, child] of Object.entries(value)) {
      const filteredChild = this.filterStructuredContent(child, `${context}.${key}`);
      if (filteredChild !== child) {
        filteredObject[key] = filteredChild;
        mutated = true;
      }
    }

    return mutated ? filteredObject : value;
  }

  filterMessages(messages) {
    if (!Array.isArray(messages) || !this.isEnabled()) {
      return messages;
    }

    const roleContextMap = {
      system: 'system_message',
      user: 'user_message',
      assistant: 'assistant_message',
      tool: 'tool_message'
    };

    return messages.map(msg => {
      if (!msg || typeof msg !== 'object') return msg;

      const filtered = { ...msg };

      if (!filtered.content) {
        return filtered;
      }

      const context = roleContextMap[filtered.role] || `${filtered.role || 'unknown'}_message`;
      filtered.content = this.filterMessageContent(filtered.content, context);

      return filtered;
    });
  }

  filterRequest(requestBody) {
    if (!requestBody || !this.isEnabled()) {
      return requestBody;
    }

    const filtered = { ...requestBody };

    // 过滤 system prompt
    if (filtered.system) {
      filtered.system = this.filterText(filtered.system, 'system_prompt');
    }

    // 过滤 messages
    if (filtered.messages) {
      filtered.messages = this.filterMessages(filtered.messages);
    }

    if ('context' in filtered) {
      filtered.context = this.filterStructuredContent(filtered.context, 'request_context');
    }

    if ('mcp' in filtered) {
      filtered.mcp = this.filterStructuredContent(filtered.mcp, 'request_mcp');
    }

    return filtered;
  }

  getStats() {
    if (!this.config) {
      return { enabled: false, totalRules: 0, enabledRules: 0 };
    }

    return {
      enabled: this.config.enabled,
      totalRules: this.config.rules.length,
      enabledRules: this.config.rules.filter(r => r.enabled).length,
      lastLoadTime: this.lastLoadTime,
      configPath: KEYWORD_CONFIG_PATH,
      ruleStats: Object.fromEntries(
        Array.from(this.ruleStats.entries()).map(([ruleId, stats]) => ([
          ruleId,
          {
            ...stats,
            lastTriggeredAt: stats.lastTriggeredAt ? new Date(stats.lastTriggeredAt).toISOString() : null,
            autoDisabledAt: stats.autoDisabledAt ? new Date(stats.autoDisabledAt).toISOString() : null
          }
        ]))
      )
    };
  }
}

// 单例模式
const keywordFilter = new KeywordFilter();

export default keywordFilter;
export { KeywordFilter };
