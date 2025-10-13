import express from 'express';
import keywordFilter from '../utils/keyword-filter.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendSuccessResponse, sendErrorResponse, wrapAsync } from './admin-error-handlers.js';
import { logInfo, logWarn } from '../logger.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEYWORD_CONFIG_PATH = path.join(__dirname, '../data/keyword-filter.json');

// 获取关键词过滤配置
router.get('/config', wrapAsync(async (req, res) => {
  const config = JSON.parse(fs.readFileSync(KEYWORD_CONFIG_PATH, 'utf-8'));
  sendSuccessResponse(res, config);
}, 'get keyword filter config'));

// 更新关键词过滤配置
router.put('/config', wrapAsync(async (req, res) => {
  const newConfig = req.body;
  
  // 验证配置格式
  if (typeof newConfig.enabled !== 'boolean') {
    return sendErrorResponse(res, 'Invalid config: enabled must be boolean', 400);
  }
  
  if (!Array.isArray(newConfig.rules)) {
    return sendErrorResponse(res, 'Invalid config: rules must be array', 400);
  }
  
  // 保存配置
  fs.writeFileSync(KEYWORD_CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf-8');
  
  // 重新加载配置
  keywordFilter.reloadConfig();
  
  logInfo('[KeywordFilter] Configuration updated via API');
  sendSuccessResponse(res, { message: 'Configuration updated successfully' });
}, 'update keyword filter config'));

// 获取所有规则
router.get('/rules', wrapAsync(async (req, res) => {
  const config = JSON.parse(fs.readFileSync(KEYWORD_CONFIG_PATH, 'utf-8'));
  sendSuccessResponse(res, config.rules);
}, 'get keyword filter rules'));

// 添加新规则
router.post('/rules', wrapAsync(async (req, res) => {
  const newRule = req.body;
  
  // 验证规则格式
  if (!newRule.name || !newRule.pattern || !newRule.action) {
    return sendErrorResponse(res, 'Invalid rule: name, pattern, and action are required', 400);
  }
  
  // 生成规则ID
  if (!newRule.id) {
    newRule.id = `rule-${Date.now()}`;
  }
  
  // 设置默认值
  if (newRule.enabled === undefined) {
    newRule.enabled = true;
  }
  
  // 读取当前配置
  const config = JSON.parse(fs.readFileSync(KEYWORD_CONFIG_PATH, 'utf-8'));
  
  // 添加规则
  config.rules.push(newRule);
  
  // 保存配置
  fs.writeFileSync(KEYWORD_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  
  // 重新加载配置
  keywordFilter.reloadConfig();
  
  logInfo(`[KeywordFilter] Rule added: ${newRule.name} (${newRule.id})`);
  sendSuccessResponse(res, { message: 'Rule added successfully', rule: newRule });
}, 'add keyword filter rule'));

// 更新规则
router.put('/rules/:ruleId', wrapAsync(async (req, res) => {
  const { ruleId } = req.params;
  const updatedRule = req.body;
  
  // 读取当前配置
  const config = JSON.parse(fs.readFileSync(KEYWORD_CONFIG_PATH, 'utf-8'));
  
  // 查找规则
  const ruleIndex = config.rules.findIndex(r => r.id === ruleId);
  if (ruleIndex === -1) {
    return sendErrorResponse(res, `Rule not found: ${ruleId}`, 404);
  }
  
  // 更新规则（保留ID）
  config.rules[ruleIndex] = {
    ...updatedRule,
    id: ruleId
  };
  
  // 保存配置
  fs.writeFileSync(KEYWORD_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  
  // 重新加载配置
  keywordFilter.reloadConfig();
  
  logInfo(`[KeywordFilter] Rule updated: ${ruleId}`);
  sendSuccessResponse(res, { message: 'Rule updated successfully', rule: config.rules[ruleIndex] });
}, 'update keyword filter rule'));

// 删除规则
router.delete('/rules/:ruleId', wrapAsync(async (req, res) => {
  const { ruleId } = req.params;
  
  // 读取当前配置
  const config = JSON.parse(fs.readFileSync(KEYWORD_CONFIG_PATH, 'utf-8'));
  
  // 查找规则
  const ruleIndex = config.rules.findIndex(r => r.id === ruleId);
  if (ruleIndex === -1) {
    return sendErrorResponse(res, `Rule not found: ${ruleId}`, 404);
  }
  
  // 删除规则
  const deletedRule = config.rules.splice(ruleIndex, 1)[0];
  
  // 保存配置
  fs.writeFileSync(KEYWORD_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  
  // 重新加载配置
  keywordFilter.reloadConfig();
  
  logInfo(`[KeywordFilter] Rule deleted: ${ruleId}`);
  sendSuccessResponse(res, { message: 'Rule deleted successfully', rule: deletedRule });
}, 'delete keyword filter rule'));

// 切换规则启用状态
router.patch('/rules/:ruleId/toggle', wrapAsync(async (req, res) => {
  const { ruleId } = req.params;
  
  // 读取当前配置
  const config = JSON.parse(fs.readFileSync(KEYWORD_CONFIG_PATH, 'utf-8'));
  
  // 查找规则
  const rule = config.rules.find(r => r.id === ruleId);
  if (!rule) {
    return sendErrorResponse(res, `Rule not found: ${ruleId}`, 404);
  }
  
  // 切换启用状态
  rule.enabled = !rule.enabled;
  
  // 保存配置
  fs.writeFileSync(KEYWORD_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  
  // 重新加载配置
  keywordFilter.reloadConfig();
  
  logInfo(`[KeywordFilter] Rule toggled: ${ruleId} -> ${rule.enabled ? 'enabled' : 'disabled'}`);
  sendSuccessResponse(res, { message: 'Rule toggled successfully', rule });
}, 'toggle keyword filter rule'));

// 切换全局启用状态
router.patch('/toggle', wrapAsync(async (req, res) => {
  // 读取当前配置
  const config = JSON.parse(fs.readFileSync(KEYWORD_CONFIG_PATH, 'utf-8'));
  
  // 切换启用状态
  config.enabled = !config.enabled;
  
  // 保存配置
  fs.writeFileSync(KEYWORD_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  
  // 重新加载配置
  keywordFilter.reloadConfig();
  
  logInfo(`[KeywordFilter] Global filter ${config.enabled ? 'enabled' : 'disabled'}`);
  sendSuccessResponse(res, { message: 'Global filter toggled successfully', enabled: config.enabled });
}, 'toggle keyword filter'));

// 获取统计信息
router.get('/stats', wrapAsync(async (req, res) => {
  const stats = keywordFilter.getStats();
  sendSuccessResponse(res, stats);
}, 'get keyword filter stats'));

// 测试规则
router.post('/test', wrapAsync(async (req, res) => {
  const { text, ruleId } = req.body;
  
  if (!text) {
    return sendErrorResponse(res, 'Text is required', 400);
  }
  
  // 读取当前配置
  const config = JSON.parse(fs.readFileSync(KEYWORD_CONFIG_PATH, 'utf-8'));
  
  if (ruleId) {
    // 测试单个规则
    const rule = config.rules.find(r => r.id === ruleId);
    if (!rule) {
      return sendErrorResponse(res, `Rule not found: ${ruleId}`, 404);
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
    // 测试所有规则
    const filtered = keywordFilter.filterText(text, 'test');
    
    sendSuccessResponse(res, {
      original: text,
      filtered,
      changed: text !== filtered
    });
  }
}, 'test keyword filter'));

// 重新加载配置
router.post('/reload', wrapAsync(async (req, res) => {
  keywordFilter.reloadConfig();
  const stats = keywordFilter.getStats();
  
  logInfo('[KeywordFilter] Configuration reloaded via API');
  sendSuccessResponse(res, { message: 'Configuration reloaded successfully', stats });
}, 'reload keyword filter config'));

export default router;
