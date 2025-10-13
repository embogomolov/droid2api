import fetch from 'node-fetch';
import { logDebug, logError, logInfo } from '../logger.js';
import { getFactoryApiConcurrency } from '../config.js';

/**
 * Factory AI API 客户端
 * 用于查询密钥的 token 使用量和真实额度信息
 *
 * 实际端点通过Playwright抓取Factory控制台真实API调用确认
 * 参考实现: https://github.com/AAEE86/droid-apikey
 *
 * 重要发现 (2025-10-12):
 * - /api/organization/members/chat-usage 返回的 totalAllowance 不准确,永远是20M
 * - /api/organization 包含 freeTrialAllocation.standardTokens,这才是真实额度
 * - 邀请码注册: freeTrialAllocation.standardTokens = 38M (20M + 18M邀请奖励)
 * - 普通注册: freeTrialAllocation.standardTokens = 20M
 */

const FACTORY_API_BASE = 'https://app.factory.ai/api';

/**
 * Factory AI官方API端点
 * 认证方式: API Key作为Bearer token
 */
const FACTORY_USAGE_ENDPOINT = '/organization/members/chat-usage';
const FACTORY_ORG_ENDPOINT = '/organization';

/**
 * 调用Factory API获取组织信息 (包含真实的免费试用额度)
 *
 * @param {string} apiKey - Factory API密钥
 * @param {Object} options - 选项
 * @param {number} options.timeout - 请求超时(毫秒)
 * @returns {Promise<Object>} 组织信息响应
 * @private
 */
async function fetchOrganization(apiKey, options = {}) {
  const { timeout = 10000 } = options;
  const url = `${FACTORY_API_BASE}${FACTORY_ORG_ENDPOINT}`;

  logDebug(`调用Factory组织API: ${url}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      logDebug(`/api/organization非JSON响应: ${text.substring(0, 200)}`);
      throw new Error('API返回非JSON格式响应');
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${data?.message || response.statusText}`);
    }

    return data;
  } catch (fetchError) {
    clearTimeout(timeoutId);
    if (fetchError.name === 'AbortError') {
      throw new Error(`组织API请求超时(${timeout}ms)`);
    }
    throw fetchError;
  }
}

/**
 * 调用Factory API获取Token使用量和真实额度
 *
 * 工作流程:
 * 1. 并行调用两个API: /api/organization 和 /api/organization/members/chat-usage
 * 2. 从 /api/organization 提取真实的免费试用额度 (freeTrialAllocation)
 * 3. 从 /api/organization/members/chat-usage 提取使用量统计
 * 4. 合并数据,返回准确的余额信息
 *
 * @param {string} apiKey - Factory API密钥(fk-xxx格式)
 * @param {Object} options - 选项
 * @param {number} options.timeout - 请求超时时间(毫秒),默认10000
 * @returns {Promise<Object>} Token使用量信息
 *
 * 返回格式:
 * {
 *   success: boolean,
 *   standard: {
 *     totalAllowance: number,      // 真实的标准额度总额 (从freeTrialAllocation获取)
 *     orgTotalTokensUsed: number,  // 组织已使用
 *     usedRatio: number,           // 使用率 (基于真实额度计算)
 *     remaining: number,           // 剩余额度
 *     basicAllowance: number,      // 基础额度 (20M)
 *     orgOverageLimit: number,     // 超额限制
 *     orgOverageUsed: number       // 超额已使用
 *   },
 *   premium: { ... },              // Premium token池(结构同standard)
 *   startDate: string|null,        // 周期开始时间
 *   endDate: string|null,          // 周期结束时间
 *   trialEndDate: string|null,     // 免费试用结束时间
 *   raw_responses: {               // 两个API的原始响应
 *     organization: Object,
 *     usage: Object
 *   }
 * }
 */
export async function fetchTokenUsage(apiKey, options = {}) {
  const { timeout = 10000 } = options;

  if (!apiKey || !apiKey.startsWith('fk-')) {
    throw new Error('无效的Factory API密钥格式(必须以fk-开头)');
  }

  try {
    logDebug('开始查询Factory密钥余额和使用量');

    // 并行调用两个API
    const [orgResult, usageResult] = await Promise.allSettled([
      fetchOrganization(apiKey, { timeout }),
      fetch(`${FACTORY_API_BASE}${FACTORY_USAGE_ENDPOINT}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(timeout)
      })
    ]);

    // 处理组织API结果
    if (orgResult.status === 'rejected') {
      logError(`组织API调用失败: ${orgResult.reason?.message}`);
      throw orgResult.reason;
    }

    const orgData = orgResult.value;

    // 处理使用量API结果
    if (usageResult.status === 'rejected') {
      logError(`使用量API调用失败: ${usageResult.reason?.message}`);
      throw usageResult.reason;
    }

    const usageResponse = usageResult.value;
    const contentType = usageResponse.headers.get('content-type');

    if (!contentType || !contentType.includes('application/json')) {
      const text = await usageResponse.text();
      logDebug(`使用量API非JSON响应: ${text.substring(0, 200)}`);
      throw new Error('使用量API返回非JSON格式响应');
    }

    const usageBody = await usageResponse.json();

    // 处理认证失败
    if (usageResponse.status === 401 || usageResponse.status === 403) {
      return {
        success: false,
        error: 'authentication_failed',
        message: '认证失败: 密钥无效或权限不足',
        status: usageResponse.status,
        raw_responses: { organization: orgData, usage: usageBody }
      };
    }

    // 处理余额不足 (402错误)
    if (usageResponse.status === 402) {
      return {
        success: false,
        error: 'payment_required',
        message: '余额不足',
        status: usageResponse.status,
        standard: {
          totalAllowance: 0,
          orgTotalTokensUsed: 0,
          usedRatio: 1,
          remaining: 0,
          basicAllowance: 0,
          orgOverageLimit: 0,
          orgOverageUsed: 0
        },
        raw_responses: { organization: orgData, usage: usageBody }
      };
    }

    // 处理其他HTTP错误
    if (!usageResponse.ok) {
      throw new Error(`HTTP ${usageResponse.status}: ${usageBody?.message || usageResponse.statusText}`);
    }

    // 成功响应 - 合并数据
    logDebug('成功获取Factory密钥余额和使用量');

    const usage = usageBody.usage || {};

    // 从组织API提取真实的免费试用额度
    const freeTrialAllocation = orgData.organization?.subscription?.freeTrialAllocation || {};
    const realStandardAllowance = freeTrialAllocation.standardTokens || 0;
    const realPremiumAllowance = freeTrialAllocation.premiumTokens || 0;

    // 从使用量API提取统计数据
    const standardUsage = usage.standard || {};
    const premiumUsage = usage.premium || {};

    // 计算真实的使用率和剩余额度 (standard)
    const standardUsed = standardUsage.orgTotalTokensUsed || 0;
    const standardRemaining = Math.max(0, realStandardAllowance - standardUsed);
    const standardRatio = realStandardAllowance > 0 ? standardUsed / realStandardAllowance : 0;

    // 计算真实的使用率和剩余额度 (premium)
    const premiumUsed = premiumUsage.orgTotalTokensUsed || 0;
    const premiumRemaining = Math.max(0, realPremiumAllowance - premiumUsed);
    const premiumRatio = realPremiumAllowance > 0 ? premiumUsed / realPremiumAllowance : 0;

    // 提取试用结束时间
    const trialEndDate = orgData.organization?.subscription?.orbSubscription?.trial_info?.end_date || null;

    return {
      success: true,
      standard: {
        totalAllowance: realStandardAllowance,     // 使用真实额度 (20M或38M)
        orgTotalTokensUsed: standardUsed,          // 已使用
        usedRatio: standardRatio,                  // 基于真实额度计算
        remaining: standardRemaining,              // 剩余额度
        basicAllowance: standardUsage.basicAllowance || 20000000,
        orgOverageLimit: standardUsage.orgOverageLimit || 0,
        orgOverageUsed: standardUsage.orgOverageUsed || 0
      },
      premium: {
        totalAllowance: realPremiumAllowance,      // 使用真实额度
        orgTotalTokensUsed: premiumUsed,           // 已使用
        usedRatio: premiumRatio,                   // 基于真实额度计算
        remaining: premiumRemaining,               // 剩余额度
        basicAllowance: premiumUsage.basicAllowance || 0,
        orgOverageLimit: premiumUsage.orgOverageLimit || 0,
        orgOverageUsed: premiumUsage.orgOverageUsed || 0
      },
      startDate: usage.startDate,
      endDate: usage.endDate,
      trialEndDate: trialEndDate,
      raw_responses: {
        organization: orgData,
        usage: usageBody
      }
    };

  } catch (error) {
    logError(`Factory API调用失败: ${error.message}`, error);
    return {
      success: false,
      error: 'api_call_failed',
      message: error.message,
      raw_error: error
    };
  }
}

/**
 * 批量查询多个密钥的token使用量
 * 带并发控制和错误处理
 *
 * @param {Array<{id: string, key: string}>} keys - 密钥列表
 * @param {Object} options - 选项
 * @param {number} options.concurrency - 并发数,默认10
 * @param {Function} options.onProgress - 进度回调函数 (current, total) => void
 * @returns {Promise<Array>} 查询结果列表
 */
export async function batchFetchTokenUsage(keys, options = {}) {
  // 从配置中获取并发数，如果没有传入则使用配置值
  const { concurrency = getFactoryApiConcurrency(), onProgress } = options;

  const results = [];
  const total = keys.length;

  logDebug(`开始批量查询 ${total} 个密钥的token使用量(并发数:${concurrency})`);

  // 按批次处理
  for (let i = 0; i < keys.length; i += concurrency) {
    const batch = keys.slice(i, i + concurrency);

    // 并发执行当前批次
    const batchResults = await Promise.allSettled(
      batch.map(async (keyObj) => {
        try {
          const usage = await fetchTokenUsage(keyObj.key);
          return {
            id: keyObj.id,
            key: keyObj.key,
            ...usage,
            last_sync: new Date().toISOString()
          };
        } catch (error) {
          logError(`查询密钥 ${keyObj.id} token使用量失败`, error);
          return {
            id: keyObj.id,
            key: keyObj.key,
            success: false,
            error: 'query_failed',
            message: error.message,
            last_sync: new Date().toISOString()
          };
        }
      })
    );

    // 提取结果
    batchResults.forEach(promiseResult => {
      if (promiseResult.status === 'fulfilled') {
        results.push(promiseResult.value);
      } else {
        logError('批量查询Promise rejected', promiseResult.reason);
        results.push({
          success: false,
          error: 'unknown_error',
          message: promiseResult.reason?.message || 'Unknown error'
        });
      }
    });

    // 进度回调
    if (onProgress) {
      onProgress(results.length, total);
    }

    // 批次之间短暂延迟,避免触发速率限制(500ms)
    if (i + concurrency < keys.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  logDebug(`批量查询完成: ${results.filter(r => r.success).length}/${total} 成功`);
  return results;
}

/**
 * 导出后端常用的简化接口
 */
export default {
  fetchTokenUsage,
  batchFetchTokenUsage
};
