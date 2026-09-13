/**
 * Redis cache manager 🚀
 *
 * Features:
 * - Cache key pool state to reduce disk reads.
 * - Cache token usage for fast statistics access.
 * - Support cluster mode by sharing state across processes.
 *
 * Dependency:
 * npm install redis
 *
 * Usage:
 * import redisCache from './utils/redis-cache.js';
 * await redisCache.set('key', value, 60);  // Cache for 60 seconds.
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
      // BaSui: Connection settings for Redis connection reuse.
      socket: {
        keepAlive: true,
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            logError('Redis reconnection failed: retry limit reached');
            return false;  // Stop reconnecting.
          }
          return Math.min(retries * 100, 3000);  // Reconnection delay: 100 ms, 200 ms, ..., 3,000 ms
        }
      }
    };
  }

  /**
   * Initialize the Redis connection.
   */
  async connect() {
    // BaSui: Continue without caching if the redis package is unavailable.
    try {
      const { createClient } = await import('redis');

      this.client = createClient(this.config);

      // Handle connection errors.
      this.client.on('error', (err) => {
        logError('Redis error', err);
        this.isConnected = false;
      });

      // Log reconnection attempts.
      this.client.on('reconnecting', () => {
        logInfo('Reconnecting to Redis...');
      });

      // Connection established.
      this.client.on('connect', () => {
        logInfo('Connected to Redis');
        this.isConnected = true;
        this.isEnabled = true;
      });

      // Establish the connection.
      await this.client.connect();

      logInfo(`Redis cache enabled: ${this.config.host}:${this.config.port} (DB:${this.config.db})`);

    } catch (error) {
      logInfo('Redis is unavailable or the connection failed; caching is disabled and the application can continue running');
      logDebug('Redis error details', error);
      this.isEnabled = false;
    }
  }

  /**
   * Get a cached value using the configured key prefix.
   * @param {string} key - Cache key
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
        logDebug(`Redis cache hit: ${key}`);
        return JSON.parse(value);
      }

      logDebug(`Redis cache miss: ${key}`);
      return null;
    } catch (error) {
      logError(`Redis read failed: ${key}`, error);
      return null;
    }
  }

  /**
   * Cache a value with the configured key prefix and expiration.
   * @param {string} key - Cache key
   * @param {any} value - Cached value
   * @param {number} ttl - Time to live in seconds; defaults to 60
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
      logDebug(`Redis cache entry set: ${key} (TTL: ${ttl}s)`);
      return true;
    } catch (error) {
      logError(`Redis write failed: ${key}`, error);
      return false;
    }
  }

  /**
   * Delete a cache entry.
   * @param {string} key - Cache key
   * @returns {Promise<boolean>}
   */
  async del(key) {
    if (!this.isEnabled || !this.isConnected) {
      return false;
    }

    try {
      const fullKey = this.config.keyPrefix + key;
      await this.client.del(fullKey);
      logDebug(`Redis cache entry deleted: ${key}`);
      return true;
    } catch (error) {
      logError(`Redis deletion failed: ${key}`, error);
      return false;
    }
  }

  /**
   * Delete cache entries matching a pattern.
   * @param {string} pattern - Match pattern, such as "keypool:*"
   * @returns {Promise<number>} Number of deleted keys
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
        logDebug(`Redis batch deletion: ${pattern} (${keys.length} keys)`);
        return keys.length;
      }

      return 0;
    } catch (error) {
      logError(`Redis batch deletion failed: ${pattern}`, error);
      return 0;
    }
  }

  /**
   * Check whether a cache entry exists.
   * @param {string} key - Cache key
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
      logError(`Redis existence check failed: ${key}`, error);
      return false;
    }
  }

  /**
   * Increment a counter atomically.
   * @param {string} key - Counter key
   * @param {number} increment - Increment amount; defaults to 1
   * @param {number} ttl - Time to live in seconds; no expiration by default
   * @returns {Promise<number>} Value after incrementing
   */
  async incr(key, increment = 1, ttl = null) {
    if (!this.isEnabled || !this.isConnected) {
      return 0;
    }

    try {
      const fullKey = this.config.keyPrefix + key;
      const newValue = await this.client.incrBy(fullKey, increment);

      if (ttl !== null && newValue === increment) {
        // Set the expiration when the counter is first created.
        await this.client.expire(fullKey, ttl);
      }

      return newValue;
    } catch (error) {
      logError(`Redis increment failed: ${key}`, error);
      return 0;
    }
  }

  /**
   * Get cache status for monitoring.
   */
  async getStats() {
    if (!this.isEnabled || !this.isConnected) {
      return {
        enabled: false,
        connected: false,
        message: 'Redis is disabled or disconnected'
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
      logError('Failed to get Redis status', error);
      return {
        enabled: true,
        connected: false,
        error: error.message
      };
    }
  }

  /**
   * Close the connection on application exit.
   */
  async disconnect() {
    if (this.client && this.isConnected) {
      await this.client.quit();
      logInfo('Redis connection closed');
      this.isConnected = false;
    }
  }

  /**
   * Flush all entries in the selected database (destructive; development/testing only).
   */
  async flushAll() {
    if (!this.isEnabled || !this.isConnected) {
      return false;
    }

    try {
      await this.client.flushDb();
      logInfo('Redis cache flushed');
      return true;
    } catch (error) {
      logError('Redis flush failed', error);
      return false;
    }
  }

  /**
   * Check whether Redis is available.
   */
  isAvailable() {
    return this.isEnabled && this.isConnected;
  }
}

// BaSui: Global singleton; the application shares one Redis connection.
const redisCache = new RedisCache();

export default redisCache;
export { RedisCache };
