/**
 * Token使用量管理器
 * 负责记录、统计和持久化token使用数据
 * 
 * BaSui: 使用新的准确token计算算法来追踪使用量
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logDebug, logError, logWarn } from '../logger.js';
import { normalizeTokenStats } from './token-counter.js';
import { AsyncFileWriter } from './async-file-writer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Token使用量数据文件
const TOKEN_USAGE_FILE = path.join(__dirname, '..', 'data', 'token_usage_detail.json');

class TokenUsageManager {
  constructor() {
    this.usageData = this.loadData();
    this.fileWriter = new AsyncFileWriter(TOKEN_USAGE_FILE);
    this.pendingWrites = false;
    
    // 定期保存数据
    this.saveInterval = setInterval(() => {
      if (this.pendingWrites) {
        this.saveData();
        this.pendingWrites = false;
      }
    }, 30000); // 每30秒保存一次
  }

  /**
   * 加载已有的使用量数据
   */
  loadData() {
    try {
      if (fs.existsSync(TOKEN_USAGE_FILE)) {
        const content = fs.readFileSync(TOKEN_USAGE_FILE, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      logError('加载token使用量数据失败', error);
    }

    // 初始数据结构
    return {
      keys: {},        // 按密钥ID存储的使用量
      models: {},      // 按模型存储的使用量
      daily: {},       // 按日期存储的使用量
      hourly: {},      // 按小时存储的使用量
      total: {         // 总体统计
        requests: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        reasoning_tokens: 0,
        thinking_tokens: 0,
        estimated_cost: 0
      },
      last_updated: new Date().toISOString()
    };
  }

  /**
   * 保存数据到文件
   */
  saveData() {
    try {
      this.usageData.last_updated = new Date().toISOString();
      this.fileWriter.write(this.usageData);
      logDebug('Token使用量数据已保存');
    } catch (error) {
      logError('保存token使用量数据失败', error);
    }
  }

  /**
   * 记录token使用量
   * @param {Object} params - 记录参数
   * @param {string} params.keyId - 密钥ID
   * @param {string} params.model - 模型名称
   * @param {Object} params.usage - token使用量对象
   * @param {Object} params.estimated - 预估的token使用量
   * @param {number} params.latency - 请求延迟（毫秒）
   */
  recordUsage({ keyId, model, usage, estimated, latency }) {
    try {
      // 标准化token统计
      const normalizedUsage = normalizeTokenStats(usage);
      
      const now = new Date();
      const dateKey = now.toISOString().split('T')[0]; // YYYY-MM-DD
      const hourKey = `${dateKey}T${now.getHours().toString().padStart(2, '0')}`; // YYYY-MM-DDTHH

      // 更新密钥统计
      if (keyId) {
        if (!this.usageData.keys[keyId]) {
          this.usageData.keys[keyId] = this.createEmptyStats();
        }
        this.updateStats(this.usageData.keys[keyId], normalizedUsage, latency);
      }

      // 更新模型统计
      if (model) {
        if (!this.usageData.models[model]) {
          this.usageData.models[model] = this.createEmptyStats();
        }
        this.updateStats(this.usageData.models[model], normalizedUsage, latency);
      }

      // 更新每日统计
      if (!this.usageData.daily[dateKey]) {
        this.usageData.daily[dateKey] = this.createEmptyStats();
      }
      this.updateStats(this.usageData.daily[dateKey], normalizedUsage, latency);

      // 更新每小时统计
      if (!this.usageData.hourly[hourKey]) {
        this.usageData.hourly[hourKey] = this.createEmptyStats();
      }
      this.updateStats(this.usageData.hourly[hourKey], normalizedUsage, latency);

      // 更新总体统计
      this.updateStats(this.usageData.total, normalizedUsage, latency);

      // 计算估算成本（基于简化的定价模型）
      const estimatedCost = this.calculateCost(normalizedUsage, model);
      this.usageData.total.estimated_cost += estimatedCost;

      // 如果有预估值，记录准确率
      if (estimated) {
        this.recordAccuracy(normalizedUsage, estimated);
      }

      // 标记需要保存
      this.pendingWrites = true;

      logDebug(`Token使用已记录 - 密钥: ${keyId}, 模型: ${model}, 总tokens: ${normalizedUsage.total_tokens}`);

    } catch (error) {
      logError('记录token使用量失败', error);
    }
  }

  /**
   * 创建空的统计对象
   */
  createEmptyStats() {
    return {
      requests: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      reasoning_tokens: 0,
      thinking_tokens: 0,
      total_latency: 0,
      avg_latency: 0,
      first_used: new Date().toISOString(),
      last_used: new Date().toISOString()
    };
  }

  /**
   * 更新统计数据
   */
  updateStats(stats, usage, latency) {
    stats.requests++;
    stats.prompt_tokens += usage.prompt_tokens || 0;
    stats.completion_tokens += usage.completion_tokens || 0;
    stats.total_tokens += usage.total_tokens || 0;
    stats.cache_creation_tokens += usage.cache_creation_tokens || 0;
    stats.cache_read_tokens += usage.cache_read_tokens || 0;
    stats.reasoning_tokens += usage.reasoning_tokens || 0;
    stats.thinking_tokens += usage.thinking_tokens || 0;
    
    if (latency) {
      stats.total_latency += latency;
      stats.avg_latency = stats.total_latency / stats.requests;
    }
    
    stats.last_used = new Date().toISOString();
  }

  /**
   * 计算估算成本（简化版）
   */
  calculateCost(usage, model) {
    // 简化的成本模型（美元/1M tokens）
    const pricing = {
      'claude-sonnet-4-20250514': { input: 3, output: 15 },
      'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
      'gpt-5-2025-08-07': { input: 3, output: 15 },
      'gpt-5-codex': { input: 3, output: 15 },
      'glm-4.6': { input: 1, output: 2 },
      'default': { input: 2, output: 6 }
    };

    const modelPricing = pricing[model] || pricing['default'];
    const inputCost = (usage.prompt_tokens / 1000000) * modelPricing.input;
    const outputCost = (usage.completion_tokens / 1000000) * modelPricing.output;
    
    return inputCost + outputCost;
  }

  /**
   * 记录预估准确率
   */
  recordAccuracy(actual, estimated) {
    if (!this.usageData.accuracy) {
      this.usageData.accuracy = {
        samples: 0,
        total_diff_prompt: 0,
        total_diff_completion: 0,
        avg_accuracy_prompt: 0,
        avg_accuracy_completion: 0
      };
    }

    const acc = this.usageData.accuracy;
    acc.samples++;

    const promptDiff = Math.abs(actual.prompt_tokens - (estimated.estimated_prompt_tokens || 0));
    const completionDiff = Math.abs(actual.completion_tokens - (estimated.estimated_completion_tokens || 0));

    acc.total_diff_prompt += promptDiff;
    acc.total_diff_completion += completionDiff;

    // 计算平均准确率
    if (actual.prompt_tokens > 0) {
      const promptAccuracy = 1 - (promptDiff / actual.prompt_tokens);
      acc.avg_accuracy_prompt = ((acc.avg_accuracy_prompt * (acc.samples - 1)) + promptAccuracy) / acc.samples;
    }

    if (actual.completion_tokens > 0) {
      const completionAccuracy = 1 - (completionDiff / actual.completion_tokens);
      acc.avg_accuracy_completion = ((acc.avg_accuracy_completion * (acc.samples - 1)) + completionAccuracy) / acc.samples;
    }
  }

  /**
   * 获取使用量摘要
   */
  getSummary() {
    const today = new Date().toISOString().split('T')[0];
    const currentHour = `${today}T${new Date().getHours().toString().padStart(2, '0')}`;

    return {
      total: this.usageData.total,
      today: this.usageData.daily[today] || this.createEmptyStats(),
      current_hour: this.usageData.hourly[currentHour] || this.createEmptyStats(),
      accuracy: this.usageData.accuracy || null,
      last_updated: this.usageData.last_updated
    };
  }

  /**
   * 获取指定密钥的使用量
   */
  getKeyUsage(keyId) {
    return this.usageData.keys[keyId] || null;
  }

  /**
   * 获取指定模型的使用量
   */
  getModelUsage(model) {
    return this.usageData.models[model] || null;
  }

  /**
   * 获取日期范围内的使用量
   */
  getUsageByDateRange(startDate, endDate) {
    const result = {};
    const start = new Date(startDate);
    const end = new Date(endDate);

    Object.keys(this.usageData.daily).forEach(dateKey => {
      const date = new Date(dateKey);
      if (date >= start && date <= end) {
        result[dateKey] = this.usageData.daily[dateKey];
      }
    });

    return result;
  }

  /**
   * 清理旧数据（保留最近30天）
   */
  cleanupOldData() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoffDate = thirtyDaysAgo.toISOString().split('T')[0];

    // 清理每日数据
    Object.keys(this.usageData.daily).forEach(dateKey => {
      if (dateKey < cutoffDate) {
        delete this.usageData.daily[dateKey];
      }
    });

    // 清理每小时数据（只保留7天）
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const hourCutoff = sevenDaysAgo.toISOString().substring(0, 13); // YYYY-MM-DDTHH

    Object.keys(this.usageData.hourly).forEach(hourKey => {
      if (hourKey < hourCutoff) {
        delete this.usageData.hourly[hourKey];
      }
    });

    this.pendingWrites = true;
    logInfo('已清理旧的token使用量数据');
  }

  /**
   * 销毁管理器
   */
  destroy() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
    }
    if (this.pendingWrites) {
      this.saveData();
    }
  }
}

// 创建单例
const tokenUsageManager = new TokenUsageManager();

// 定期清理旧数据（每天一次）
setInterval(() => {
  tokenUsageManager.cleanupOldData();
}, 24 * 60 * 60 * 1000);

export default tokenUsageManager;
