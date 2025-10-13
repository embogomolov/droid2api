import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logWarn, logError, logDebug } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEYWORD_CONFIG_PATH = path.join(__dirname, '../data/keyword-filter.json');

class KeywordFilter {
  constructor() {
    this.config = null;
    this.lastLoadTime = 0;
    this.loadConfig();
  }

  loadConfig() {
    try {
      if (!fs.existsSync(KEYWORD_CONFIG_PATH)) {
        logWarn('[KeywordFilter] Configuration file not found, creating default...');
        this.createDefaultConfig();
      }

      const configData = fs.readFileSync(KEYWORD_CONFIG_PATH, 'utf-8');
      this.config = JSON.parse(configData);
      this.lastLoadTime = Date.now();
      
      if (this.config.enabled) {
        const enabledRules = this.config.rules.filter(r => r.enabled).length;
        logInfo(`[KeywordFilter] Loaded ${enabledRules} enabled rules from ${this.config.rules.length} total rules`);
      }
    } catch (error) {
      logError('[KeywordFilter] Failed to load configuration', error);
      this.config = this.getDefaultConfig();
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

    const { type, replacement } = action;
    const { value, caseSensitive } = pattern;

    switch (type) {
      case 'replace':
        if (pattern.type === 'regex') {
          try {
            const flags = caseSensitive ? 'g' : 'gi';
            const regex = new RegExp(value, flags);
            return text.replace(regex, replacement || '');
          } catch (error) {
            logError(`[KeywordFilter] Regex replacement failed: ${value}`, error);
            return text;
          }
        } else {
          const searchValue = caseSensitive ? value : value.toLowerCase();
          const searchText = caseSensitive ? text : text.toLowerCase();
          
          let result = text;
          let index = 0;
          
          while ((index = (caseSensitive ? result : result.toLowerCase()).indexOf(searchValue, index)) !== -1) {
            result = result.substring(0, index) + (replacement || '') + result.substring(index + value.length);
            index += (replacement || '').length;
          }
          
          return result;
        }
      
      case 'remove':
        return this.applyAction(text, { type: 'replace', replacement: '' }, pattern);
      
      case 'block':
        return '';
      
      default:
        logWarn(`[KeywordFilter] Unknown action type: ${type}`);
        return text;
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
        filteredText = this.applyAction(filteredText, rule.action, rule.pattern);
        const afterLength = filteredText.length;

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

  filterMessages(messages) {
    if (!Array.isArray(messages) || !this.isEnabled()) {
      return messages;
    }

    return messages.map(msg => {
      if (!msg || typeof msg !== 'object') return msg;

      const filtered = { ...msg };

      // 过滤 system 消息
      if (filtered.role === 'system' && filtered.content) {
        if (typeof filtered.content === 'string') {
          filtered.content = this.filterText(filtered.content, 'system_message');
        } else if (Array.isArray(filtered.content)) {
          filtered.content = filtered.content.map(item => {
            if (item.type === 'text' && item.text) {
              return { ...item, text: this.filterText(item.text, 'system_message') };
            }
            return item;
          });
        }
      }

      // 过滤 user 消息
      if (filtered.role === 'user' && filtered.content) {
        if (typeof filtered.content === 'string') {
          filtered.content = this.filterText(filtered.content, 'user_message');
        } else if (Array.isArray(filtered.content)) {
          filtered.content = filtered.content.map(item => {
            if (item.type === 'text' && item.text) {
              return { ...item, text: this.filterText(item.text, 'user_message') };
            }
            return item;
          });
        }
      }

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
      configPath: KEYWORD_CONFIG_PATH
    };
  }
}

// 单例模式
const keywordFilter = new KeywordFilter();

export default keywordFilter;
export { KeywordFilter };
