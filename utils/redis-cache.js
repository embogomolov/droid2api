/**
 * Redis 缓存管理器 🚀
 *
 * 功能：
 * - 密钥池状态缓存（减少文件读取）
 * - Token 使用量缓存（高性能统计）
 * - 支持集群模式（多进程共享状态）
 *
 * 依赖：
 * npm install redis
 *
 * 使用：
 * import redisCache from './utils/redis-cache.js';
 * await redisCache.set('key', value, 60);  // 缓存60秒
 * const value = await redisCache.get('key');
 */

import { logDebug, logError, logInfo } from '../logger.js';

class RedisCache {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.isEnabled = false;
    this.config = {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_DB || '0'),
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'droid2api:',
      // BaSui：连接池配置（复用Redis连接）
      socket: {
        keepAlive: true,
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            logError('Redis重连失败，达到最大重试次数');
            return false;  // 停止重连
          }
          return Math.min(retries * 100, 3000);  // 重连延迟：100ms, 200ms, ..., 3000ms
        }
      }
    };
  }

  /**
   * 初始化 Redis 连接
   */
  async connect() {
    // BaSui：如果未安装redis包，优雅降级（不影响系统运行）
    try {
      const { createClient } = await import('redis');

      this.client = createClient(this.config);

      // 错误处理
      this.client.on('error', (err) => {
        logError('Redis错误', err);
        this.isConnected = false;
      });

      // 重连成功
      this.client.on('reconnecting', () => {
        logInfo('Redis正在重连...');
      });

      // 连接成功
      this.client.on('connect', () => {
        logInfo('Redis连接成功');
        this.isConnected = true;
        this.isEnabled = true;
      });

      // 建立连接
      await this.client.connect();

      logInfo(`Redis缓存已启用: ${this.config.host}:${this.config.port} (DB:${this.config.db})`);

    } catch (error) {
      logInfo('Redis未安装或连接失败，缓存功能已禁用（系统仍可正常运行）');
      logDebug('Redis错误详情', error);
      this.isEnabled = false;
    }
  }

  /**
   * 获取缓存（带前缀）
   * @param {string} key - 缓存键
   * @returns {Promise<any>}
   */
  async get(key) {
    if (!this.isEnabled || !this.isConnected) {
      return null;
    }

    try {
      const fullKey = this.config.keyPrefix + key;
      const value = await this.client.get(fullKey);

      if (value) {
        logDebug(`Redis缓存命中: ${key}`);
        return JSON.parse(value);
      }

      logDebug(`Redis缓存未命中: ${key}`);
      return null;
    } catch (error) {
      logError(`Redis读取失败: ${key}`, error);
      return null;
    }
  }

  /**
   * 设置缓存（带前缀和过期时间）
   * @param {string} key - 缓存键
   * @param {any} value - 缓存值
   * @param {number} ttl - 过期时间（秒），默认60秒
   * @returns {Promise<boolean>}
   */
  async set(key, value, ttl = 60) {
    if (!this.isEnabled || !this.isConnected) {
      return false;
    }

    try {
      const fullKey = this.config.keyPrefix + key;
      const jsonValue = JSON.stringify(value);

      await this.client.setEx(fullKey, ttl, jsonValue);
      logDebug(`Redis缓存已设置: ${key} (TTL: ${ttl}s)`);
      return true;
    } catch (error) {
      logError(`Redis写入失败: ${key}`, error);
      return false;
    }
  }

  /**
   * 删除缓存
   * @param {string} key - 缓存键
   * @returns {Promise<boolean>}
   */
  async del(key) {
    if (!this.isEnabled || !this.isConnected) {
      return false;
    }

    try {
      const fullKey = this.config.keyPrefix + key;
      await this.client.del(fullKey);
      logDebug(`Redis缓存已删除: ${key}`);
      return true;
    } catch (error) {
      logError(`Redis删除失败: ${key}`, error);
      return false;
    }
  }

  /**
   * 批量删除缓存（通过模式匹配）
   * @param {string} pattern - 匹配模式，如 "keypool:*"
   * @returns {Promise<number>} 删除的键数量
   */
  async delByPattern(pattern) {
    if (!this.isEnabled || !this.isConnected) {
      return 0;
    }

    try {
      const fullPattern = this.config.keyPrefix + pattern;
      const keys = await this.client.keys(fullPattern);

      if (keys.length > 0) {
        await this.client.del(keys);
        logDebug(`Redis批量删除: ${pattern} (${keys.length}个键)`);
        return keys.length;
      }

      return 0;
    } catch (error) {
      logError(`Redis批量删除失败: ${pattern}`, error);
      return 0;
    }
  }

  /**
   * 检查缓存是否存在
   * @param {string} key - 缓存键
   * @returns {Promise<boolean>}
   */
  async exists(key) {
    if (!this.isEnabled || !this.isConnected) {
      return false;
    }

    try {
      const fullKey = this.config.keyPrefix + key;
      const result = await this.client.exists(fullKey);
      return result === 1;
    } catch (error) {
      logError(`Redis检查失败: ${key}`, error);
      return false;
    }
  }

  /**
   * 自增计数器（原子操作）
   * @param {string} key - 计数器键
   * @param {number} increment - 增量，默认1
   * @param {number} ttl - 过期时间（秒），默认不过期
   * @returns {Promise<number>} 自增后的值
   */
  async incr(key, increment = 1, ttl = null) {
    if (!this.isEnabled || !this.isConnected) {
      return 0;
    }

    try {
      const fullKey = this.config.keyPrefix + key;
      const newValue = await this.client.incrBy(fullKey, increment);

      if (ttl !== null && newValue === increment) {
        // 首次创建时设置过期时间
        await this.client.expire(fullKey, ttl);
      }

      return newValue;
    } catch (error) {
      logError(`Redis自增失败: ${key}`, error);
      return 0;
    }
  }

  /**
   * 获取缓存状态（用于监控）
   */
  async getStats() {
    if (!this.isEnabled || !this.isConnected) {
      return {
        enabled: false,
        connected: false,
        message: 'Redis未启用或未连接'
      };
    }

    try {
      const info = await this.client.info('stats');
      const keyspace = await this.client.info('keyspace');

      return {
        enabled: true,
        connected: true,
        host: this.config.host,
        port: this.config.port,
        db: this.config.db,
        keyPrefix: this.config.keyPrefix,
        info: info,
        keyspace: keyspace
      };
    } catch (error) {
      logError('获取Redis状态失败', error);
      return {
        enabled: true,
        connected: false,
        error: error.message
      };
    }
  }

  /**
   * 关闭连接（应用退出时调用）
   */
  async disconnect() {
    if (this.client && this.isConnected) {
      await this.client.quit();
      logInfo('Redis连接已关闭');
      this.isConnected = false;
    }
  }

  /**
   * 清空所有缓存（危险操作！仅用于开发/测试）
   */
  async flushAll() {
    if (!this.isEnabled || !this.isConnected) {
      return false;
    }

    try {
      await this.client.flushDb();
      logInfo('Redis缓存已清空');
      return true;
    } catch (error) {
      logError('Redis清空失败', error);
      return false;
    }
  }

  /**
   * 判断 Redis 是否可用
   */
  isAvailable() {
    return this.isEnabled && this.isConnected;
  }
}

// BaSui：全局单例（整个应用共享一个Redis连接）
const redisCache = new RedisCache();

export default redisCache;
export { RedisCache };
