import fetch from 'node-fetch';
import { logDebug, logError, logInfo } from '../logger.js';
import { getFactoryApiConcurrency } from '../config.js';

/**
 * Factory AI API client
 * Query token usage and actual allowances for API keys.
 *
 * Endpoints were confirmed by capturing Factory console API calls with Playwright.
 * Reference implementation: https://github.com/AAEE86/droid-apikey
 *
 * 重要发现 (2025-10-12):
 * - /api/organization/members/chat-usage 返回的 totalAllowance 不准确,永远是20M
 * - /api/organization 包含 freeTrialAllocation.standardTokens,这才是真实额度
 * - 邀请码注册: freeTrialAllocation.standardTokens = 38M (20M + 18M邀请奖励)
 * - 普通注册: freeTrialAllocation.standardTokens = 20M
 */

const FACTORY_API_BASE = 'https://app.factory.ai/api';

/**
 * Official Factory AI API endpoints
 * Authentication: API key as a Bearer token
 */
const FACTORY_USAGE_ENDPOINT = '/organization/members/chat-usage';
const FACTORY_ORG_ENDPOINT = '/organization';

/**
 * Fetch organization information, including the actual free trial allowance, from the Factory API.
 *
 * @param {string} apiKey - Factory API key
 * @param {Object} options - Options
 * @param {number} options.timeout - Request timeout in milliseconds
 * @returns {Promise<Object>} Organization information response
 * @private
 */
async function fetchOrganization(apiKey, options = {}) {
  const { timeout = 10000 } = options;
  const url = `${FACTORY_API_BASE}${FACTORY_ORG_ENDPOINT}`;

  logDebug(`Calling the Factory organization API: ${url}`);

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
 * Fetch token usage and actual allowances from the Factory API.
 *
 * Workflow:
 * 1. Call /api/organization and /api/organization/members/chat-usage in parallel.
 * 2. Extract the actual free trial allowance (freeTrialAllocation) from /api/organization.
 * 3. Extract usage statistics from /api/organization/members/chat-usage.
 * 4. Combine the data to return accurate remaining allowances.
 *
 * @param {string} apiKey - Factory API key in fk-xxx format
 * @param {Object} options - Options
 * @param {number} options.timeout - Request timeout in milliseconds; defaults to 10000
 * @returns {Promise<Object>} Token usage information
 *
 * Response format:
 * {
 *   success: boolean,
 *   standard: {
 *     totalAllowance: number,      // Actual total standard allowance from freeTrialAllocation
 *     orgTotalTokensUsed: number,  // Organization token usage
 *     usedRatio: number,           // Usage ratio based on the actual allowance
 *     remaining: number,           // Remaining allowance
 *     basicAllowance: number,      // Base allowance (20M)
 *     orgOverageLimit: number,     // Overage limit
 *     orgOverageUsed: number       // Overage used
 *   },
 *   premium: { ... },              // Premium token pool (same structure as standard)
 *   startDate: string|null,        // Usage period start date
 *   endDate: string|null,          // Usage period end date
 *   trialEndDate: string|null,     // Free trial end date
 *   raw_responses: {               // Raw responses from both APIs
 *     organization: Object,
 *     usage: Object
 *   }
 * }
 */
export async function fetchTokenUsage(apiKey, options = {}) {
  const { timeout = 10000 } = options;

  if (!apiKey || !apiKey.startsWith('fk-')) {
    throw new Error('Invalid Factory API key format (must start with fk-)');
  }

  try {
    logDebug('Querying Factory key allowances and usage');

    // Call both APIs in parallel.
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

    // Handle the organization API result.
    if (orgResult.status === 'rejected') {
      logError(`组织API调用失败: ${orgResult.reason?.message}`);
      throw orgResult.reason;
    }

    const orgData = orgResult.value;

    // Handle the usage API result.
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
        message: 'Authentication failed: invalid key or insufficient permissions',
        status: usageResponse.status,
        raw_responses: { organization: orgData, usage: usageBody }
      };
    }

    // Handle insufficient credits (HTTP 402).
    if (usageResponse.status === 402) {
      return {
        success: false,
        error: 'payment_required',
        message: 'Insufficient credits',
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

    // Handle other HTTP errors.
    if (!usageResponse.ok) {
      throw new Error(`HTTP ${usageResponse.status}: ${usageBody?.message || usageResponse.statusText}`);
    }

    // Combine data from successful responses.
    logDebug('Successfully retrieved Factory key allowances and usage');

    const usage = usageBody.usage || {};

    // Prefer the paid usage allowance; trial allocation is a legacy fallback.
    const freeTrialAllocation = orgData.organization?.subscription?.freeTrialAllocation || {};
    const realStandardAllowance = freeTrialAllocation.standardTokens || 0;
    const realPremiumAllowance = freeTrialAllocation.premiumTokens || 0;

    // Extract statistics from the usage API.
    const standardUsage = usage.standard || {};
    const premiumUsage = usage.premium || {};

    // Calculate the actual usage ratio and remaining standard allowance.
    const standardUsed = standardUsage.orgTotalTokensUsed || 0;
    const standardRemaining = Math.max(0, realStandardAllowance - standardUsed);
    const standardRatio = realStandardAllowance > 0 ? standardUsed / realStandardAllowance : 0;

    // Calculate the actual usage ratio and remaining premium allowance.
    const premiumUsed = premiumUsage.orgTotalTokensUsed || 0;
    const premiumRemaining = Math.max(0, realPremiumAllowance - premiumUsed);
    const premiumRatio = realPremiumAllowance > 0 ? premiumUsed / realPremiumAllowance : 0;

    // Extract the trial end date.
    const trialEndDate = orgData.organization?.subscription?.orbSubscription?.trial_info?.end_date || null;

    return {
      success: true,
      standard: {
        totalAllowance: realStandardAllowance,     // Legacy allowance, not rolling-window headroom.
        orgTotalTokensUsed: standardUsed,          // Tokens used
        usedRatio: standardRatio,                  // Calculated from the actual allowance
        remaining: standardRemaining,              // Remaining allowance
        basicAllowance: standardUsage.basicAllowance || 20000000,
        orgOverageLimit: standardUsage.orgOverageLimit || 0,
        orgOverageUsed: standardUsage.orgOverageUsed || 0
      },
      premium: {
        totalAllowance: realPremiumAllowance,      // Use the actual allowance.
        orgTotalTokensUsed: premiumUsed,           // Tokens used
        usedRatio: premiumRatio,                   // Calculated from the actual allowance
        remaining: premiumRemaining,               // Remaining allowance
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
 * Fetch token usage for multiple keys in batches.
 * Includes concurrency limits and error handling.
 *
 * @param {Array<{id: string, key: string}>} keys - List of keys
 * @param {Object} options - Options
 * @param {number} options.concurrency - Concurrency limit; defaults to the configured value
 * @param {Function} options.onProgress - Progress callback: (current, total) => void
 * @returns {Promise<Array>} List of query results
 */
export async function batchFetchTokenUsage(keys, options = {}) {
  // Use the configured concurrency limit unless explicitly overridden.
  const { concurrency = getFactoryApiConcurrency(), onProgress } = options;

  const results = [];
  const total = keys.length;

  logDebug(`Fetching token usage for ${total} keys (concurrency: ${concurrency})`);

  // Process keys in batches.
  for (let i = 0; i < keys.length; i += concurrency) {
    const batch = keys.slice(i, i + concurrency);

    // Run queries in the current batch concurrently.
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
          logError(`Failed to query token usage for key ${keyObj.id}`, error);
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

    // Collect the results.
    batchResults.forEach(promiseResult => {
      if (promiseResult.status === 'fulfilled') {
        results.push(promiseResult.value);
      } else {
        logError('Batch usage query promise rejected', promiseResult.reason);
        results.push({
          success: false,
          error: 'unknown_error',
          message: promiseResult.reason?.message || 'Unknown error'
        });
      }
    });

    // Report progress.
    if (onProgress) {
      onProgress(results.length, total);
    }

    // Wait 500 ms between batches to avoid rate limits.
    if (i + concurrency < keys.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  logDebug(`Batch query complete: ${results.filter(r => r.success).length}/${total} succeeded`);
  return results;
}

/**
 * Export the commonly used backend helpers.
 */
export default {
  fetchTokenUsage,
  batchFetchTokenUsage
};
