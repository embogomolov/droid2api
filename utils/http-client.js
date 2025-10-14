import http from 'http';
import https from 'https';
import fetch from 'node-fetch';
import { logWarn, logError } from '../logger.js';

/**
 * HTTP客户端连接池管理器 🚀
 *
 * 性能优化核心：
 * - Keep-Alive 复用 TCP 连接（减少握手开销）
 * - 连接池管理（避免连接泄漏）
 * - 自动超时处理（防止连接挂死）
 */

// BaSui：HTTP连接池配置 - 根据你的实际并发量调整！
const HTTP_AGENT_OPTIONS = {
  keepAlive: true,               // 开启 Keep-Alive
  keepAliveMsecs: 1000,         // Keep-Alive 探测间隔
  maxSockets: 100,              // 每个 host 最大并发连接数（单进程）
  maxFreeSockets: 10,           // 空闲连接池大小
  timeout: 60000,               // Socket 超时时间（60秒）
  freeSocketTimeout: 30000      // 空闲连接超时（30秒后释放）
};

// BaSui：全局连接池实例（单例模式）
const httpAgent = new http.Agent(HTTP_AGENT_OPTIONS);
const httpsAgent = new https.Agent(HTTP_AGENT_OPTIONS);

/**
 * 使用连接池的 fetch 封装
 * @param {string} url - 请求 URL
 * @param {object} options - fetch 选项
 * @returns {Promise<Response>}
 */
// BaSui：自定义Fetch重试异常，方便上层判断是不是已经撞到墙了
export class FetchRetryError extends Error {
  constructor(url, attempts, lastError = null, lastStatus = null) {
    super(`请求在 ${attempts} 次尝试后仍然失败：${url}`);
    this.name = 'FetchRetryError';
    this.url = url;
    this.attempts = attempts;
    this.lastError = lastError;
    this.lastStatus = lastStatus;
  }
}

function defaultShouldRetry(response) {
  if (response.ok) {
    return false;
  }

  // BaSui：402余额不足直接拉黑别废话，403违规提醒用户；都别重试
  if (response.status === 402 || response.status === 403) {
    return false;
  }

  // 其他错误继续轮询，靠算法顶住风控风暴
  return true;
}

function shouldStopRetry(error, signal) {
  if (error?.name === 'AbortError') {
    return true;
  }
  if (signal?.aborted) {
    return true;
  }
  return false;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchWithPool(url, options = {}) {
  // BaSui：根据协议自动选择 agent
  const agent = url.startsWith('https') ? httpsAgent : httpAgent;

  const {
    retry = true,
    maxRetries = 3,
    retryDelay = 500,
    shouldRetry = defaultShouldRetry,
    onRetry = null
  } = options;

  const fetchOptions = {
    ...options,
    agent
  };

  // 这些是我们自定义的控制参数，不能直接塞给fetch
  delete fetchOptions.retry;
  delete fetchOptions.maxRetries;
  delete fetchOptions.retryDelay;
  delete fetchOptions.shouldRetry;
  delete fetchOptions.onRetry;

  const attempts = retry ? Math.max(1, maxRetries) : 1;
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, fetchOptions);

      if (!retry) {
        return response;
      }

      if (!shouldRetry(response, attempt)) {
        return response;
      }

      lastStatus = response.status;
      // BaSui：失败的响应要赶紧掐掉，不然Agent憋着会闷坏
      if (response.body && typeof response.body.cancel === 'function') {
        try {
          // 安全地取消流，捕获可能的错误
          response.body.cancel();
        } catch (cancelError) {
          // 忽略取消流时的错误（通常是流已经关闭）
        }
      }

      if (attempt < attempts) {
        if (onRetry) {
          onRetry({ attempt, attempts, url, reason: `HTTP ${lastStatus}` });
        }
        logWarn(`[FetchRetry] 第 ${attempt} 次请求失败(HTTP ${lastStatus})，准备再冲一次：${url}`);
        await delay(retryDelay);
        continue;
      }

      break;
    } catch (error) {
      lastError = error;

      if (shouldStopRetry(error, fetchOptions.signal) || !retry) {
        throw error;
      }

      if (attempt < attempts) {
        if (onRetry) {
          onRetry({ attempt, attempts, url, reason: error.message });
        }
        logWarn(`[FetchRetry] 第 ${attempt} 次请求炸掉(${error.message})，换个姿势重来：${url}`);
        await delay(retryDelay);
        continue;
      }

      break;
    }
  }

  logError(`[FetchRetry] 已尝试 ${attempts} 次依旧失败，宣布阵亡：${url}`, lastError || new Error(`HTTP ${lastStatus}`));
  throw new FetchRetryError(url, attempts, lastError, lastStatus);
}

/**
 * 获取连接池状态（用于监控）
 */
export function getPoolStats() {
  return {
    http: {
      sockets: Object.keys(httpAgent.sockets).length,
      freeSockets: Object.keys(httpAgent.freeSockets).length,
      requests: Object.keys(httpAgent.requests).length
    },
    https: {
      sockets: Object.keys(httpsAgent.sockets).length,
      freeSockets: Object.keys(httpsAgent.freeSockets).length,
      requests: Object.keys(httpsAgent.requests).length
    }
  };
}

/**
 * 优雅关闭连接池（应用退出时调用）
 */
export function destroyPool() {
  httpAgent.destroy();
  httpsAgent.destroy();
}

export default fetchWithPool;
