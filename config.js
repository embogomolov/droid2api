import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let config = null;

/**
 * Initialize the default configuration from environment variables
 * Called only when config.json does not exist
 */
function getDefaultConfigFromEnv() {
  const parseBool = (envVar, defaultValue) => {
    if (!envVar) return defaultValue;
    return envVar.toLowerCase() === 'true' || envVar === '1';
  };

  const template = path.join(process.env.DROID2API_DEFAULTS_DIR || path.join(__dirname, 'data'), 'config.json.example');
  const defaults = JSON.parse(fs.readFileSync(template, 'utf8'));
  const pool = defaults.key_pool;
  return {
    ...defaults,
    port: parseInt(process.env.PORT) || defaults.port,
    dev_mode: process.env.NODE_ENV ? process.env.NODE_ENV === 'development' : defaults.dev_mode,
    user_agent: process.env.USER_AGENT || defaults.user_agent,
    system_prompt: process.env.SYSTEM_PROMPT || defaults.system_prompt,
    limits: {
      notes_max_length: parseInt(process.env.NOTES_MAX_LENGTH) || defaults.limits.notes_max_length,
      max_json_log_size: parseInt(process.env.MAX_JSON_LOG_SIZE) || defaults.limits.max_json_log_size
    },
    key_pool: {
      algorithm: process.env.KEY_POOL_ALGORITHM || pool.algorithm,
      retry: {
        enabled: parseBool(process.env.KEY_POOL_RETRY_ENABLED, pool.retry.enabled),
        maxRetries: parseInt(process.env.KEY_POOL_RETRY_MAX) || pool.retry.maxRetries,
        retryDelay: parseInt(process.env.KEY_POOL_RETRY_DELAY_MS) || pool.retry.retryDelay
      },
      autoBan: {
        enabled: parseBool(process.env.KEY_POOL_AUTO_BAN_ENABLED, pool.autoBan.enabled),
        errorThreshold: parseInt(process.env.KEY_POOL_ERROR_THRESHOLD) || pool.autoBan.errorThreshold,
        ban402: parseBool(process.env.KEY_POOL_BAN_402, pool.autoBan.ban402),
        ban401: parseBool(process.env.KEY_POOL_BAN_401, pool.autoBan.ban401)
      },
      performance: {
        concurrentLimit: parseInt(process.env.KEY_POOL_CONCURRENT_LIMIT) || pool.performance.concurrentLimit,
        requestTimeout: parseInt(process.env.KEY_POOL_REQUEST_TIMEOUT_MS) || pool.performance.requestTimeout,
        factoryApiConcurrency: parseInt(process.env.FACTORY_API_CONCURRENCY) || 100
      },
      multiTier: {
        enabled: parseBool(process.env.KEY_POOL_MULTI_TIER_ENABLED, pool.multiTier.enabled),
        autoFallback: parseBool(process.env.KEY_POOL_MULTI_TIER_AUTO_FALLBACK, pool.multiTier.autoFallback)
      },
      retry_delay_ms: parseInt(process.env.KEY_POOL_RETRY_DELAY_MS) || pool.retry_delay_ms,
      request_timeout_ms: parseInt(process.env.KEY_POOL_REQUEST_TIMEOUT_MS) || pool.request_timeout_ms,
      batch_test_interval_ms: parseInt(process.env.KEY_POOL_BATCH_TEST_INTERVAL_MS) || pool.batch_test_interval_ms,
      cache_ttl_ms: parseInt(process.env.KEY_POOL_CACHE_TTL_MS) || pool.cache_ttl_ms
    },
    reasoning_tokens: {
      low: parseInt(process.env.REASONING_BUDGET_LOW) || defaults.reasoning_tokens.low,
      medium: parseInt(process.env.REASONING_BUDGET_MEDIUM) || defaults.reasoning_tokens.medium,
      high: parseInt(process.env.REASONING_BUDGET_HIGH) || defaults.reasoning_tokens.high
    },
    balance_sync: {
      sync_interval_minutes: parseInt(process.env.SYNC_INTERVAL_MINUTES) || defaults.balance_sync.sync_interval_minutes,
      save_interval_minutes: parseInt(process.env.BALANCE_SAVE_INTERVAL_MINUTES) || defaults.balance_sync.save_interval_minutes
    },
    token_sync: {
      enabled: parseBool(process.env.TOKEN_SYNC_ENABLED, true),
      interval_minutes: parseInt(process.env.TOKEN_SYNC_INTERVAL_MINUTES) || 5,
      on_startup: parseBool(process.env.TOKEN_SYNC_ON_STARTUP, true),
      startup_timeout_seconds: parseInt(process.env.TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS) || 10
    },
    redis: {
      enabled: parseBool(process.env.REDIS_ENABLED, defaults.redis.enabled),
      host: process.env.REDIS_HOST || defaults.redis.host,
      port: parseInt(process.env.REDIS_PORT) || defaults.redis.port,
      password: process.env.REDIS_PASSWORD || defaults.redis.password,
      db: parseInt(process.env.REDIS_DB) || defaults.redis.db,
      key_prefix: process.env.REDIS_KEY_PREFIX || defaults.redis.key_prefix
    },
    cluster: {
      enabled: parseBool(process.env.CLUSTER_MODE, defaults.cluster.enabled),
      workers: parseInt(process.env.CLUSTER_WORKERS) || defaults.cluster.workers
    }
  };
}

function initializeConfig(configPath) {
  if (fs.existsSync(configPath)) return;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const defaults = getDefaultConfigFromEnv();
  try {
    fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

export function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'data', 'config.json');
    
    initializeConfig(configPath);

    // Read the existing configuration
    const configData = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(configData);
    
    // Runtime environment variable overrides (selected variables only)
    if (process.env.PORT) {
      config.port = parseInt(process.env.PORT);
    }
    if (process.env.NODE_ENV) {
      config.dev_mode = process.env.NODE_ENV === 'development';
    }
    
    return config;
  } catch (error) {
    throw new Error(`Failed to load data/config.json: ${error.message}`);
  }
}

export function getConfig() {
  if (!config) {
    loadConfig();
  }
  return config;
}

export function getModelById(modelId) {
  const cfg = getConfig();
  return cfg.models.find(m => m.id === modelId)
    || (modelId === 'claude-fable-5-1' ? cfg.models.find(m => m.id === 'claude-fable-5.1') : undefined);
}

export function getEndpointByType(type) {
  const cfg = getConfig();
  return cfg.endpoint.find(e => e.name === type);
}

export function isDevMode() {
  return process.env.NODE_ENV === 'development';
}

export function getPort() {
  const cfg = getConfig();
  return cfg.port || 3000;
}

export function getSystemPrompt() {
  const cfg = getConfig();
  return cfg.system_prompt || '';
}

export function getModelReasoning(modelId) {
  const model = getModelById(modelId);
  if (!model || !model.reasoning) {
    return null;
  }
  const reasoningLevel = model.reasoning.toLowerCase();
  if (['low', 'medium', 'high', 'auto'].includes(reasoningLevel)) {
    return reasoningLevel;
  }
  return null;
}

export function getUserAgent() {
  const cfg = getConfig();
  return cfg.user_agent || 'factory-cli/0.213.0';
}

// Get limit settings
export function getLimits() {
  const cfg = getConfig();
  return {
    notes_max_length: parseInt(process.env.NOTES_MAX_LENGTH) || cfg.limits?.notes_max_length || 1000,
    max_json_log_size: parseInt(process.env.MAX_JSON_LOG_SIZE) || cfg.limits?.max_json_log_size || 5000
  };
}

export function getNotesMaxLength() {
  return getLimits().notes_max_length;
}

export function getMaxJsonLogSize() {
  return getLimits().max_json_log_size;
}

// Get the full key pool configuration, with all supported environment variable overrides
/**
 * Get the Factory API concurrency setting
 */
export function getFactoryApiConcurrency() {
  const cfg = getConfig();
  const keyPoolCfg = cfg.key_pool || {};
  return parseInt(process.env.FACTORY_API_CONCURRENCY) || 
         keyPoolCfg?.performance?.factoryApiConcurrency || 
         100; // Default concurrency is 100, consistent with other batch operations
}

export function getKeyPoolConfig() {
  const cfg = getConfig();
  const keyPoolCfg = cfg.key_pool || {};

  // Helper: Parse boolean environment variables
  const parseBool = (envVar, defaultValue) => {
    if (!envVar) return defaultValue;
    return envVar.toLowerCase() === 'true' || envVar === '1';
  };

  return {
    // Selection algorithm (env > config.json > default)
    algorithm: process.env.KEY_POOL_ALGORITHM || keyPoolCfg.algorithm || 'round-robin',
    waitForQuota: keyPoolCfg.waitForQuota === true,

    // Retry settings
    retry: {
      enabled: parseBool(process.env.KEY_POOL_RETRY_ENABLED, keyPoolCfg.retry?.enabled ?? true),
      maxRetries: process.env.KEY_POOL_RETRY_MAX !== undefined ? parseInt(process.env.KEY_POOL_RETRY_MAX) : keyPoolCfg.retry?.maxRetries ?? 3,
      retryDelay: process.env.KEY_POOL_RETRY_DELAY_MS !== undefined ? parseInt(process.env.KEY_POOL_RETRY_DELAY_MS) : keyPoolCfg.retry?.retryDelay ?? 1000
    },

    // Automatic ban settings
    autoBan: {
      enabled: parseBool(process.env.KEY_POOL_AUTO_BAN_ENABLED, keyPoolCfg.autoBan?.enabled ?? true),
      errorThreshold: parseInt(process.env.KEY_POOL_ERROR_THRESHOLD) || keyPoolCfg.autoBan?.errorThreshold || 5,
      ban402: parseBool(process.env.KEY_POOL_BAN_402, keyPoolCfg.autoBan?.ban402 ?? true),
      ban401: parseBool(process.env.KEY_POOL_BAN_401, keyPoolCfg.autoBan?.ban401 ?? false)
    },

    // Performance settings
    performance: {
      concurrentLimit: parseInt(process.env.KEY_POOL_CONCURRENT_LIMIT) || keyPoolCfg.performance?.concurrentLimit || 100,
      requestTimeout: parseInt(process.env.KEY_POOL_REQUEST_TIMEOUT_MS) || keyPoolCfg.performance?.requestTimeout || 10000,
      factoryApiConcurrency: parseInt(process.env.FACTORY_API_CONCURRENCY) || keyPoolCfg.performance?.factoryApiConcurrency || 100
    },

    // 🚀 BaSui: Multi-tier key pool configuration (Multi-Tier Pool)
    multiTier: {
      enabled: parseBool(process.env.KEY_POOL_MULTI_TIER_ENABLED, keyPoolCfg.multiTier?.enabled ?? false),
      autoFallback: parseBool(process.env.KEY_POOL_MULTI_TIER_AUTO_FALLBACK, keyPoolCfg.multiTier?.autoFallback ?? true)
    },

    // Backward compatibility: Keep legacy fields
    retry_delay_ms: parseInt(process.env.KEY_POOL_RETRY_DELAY_MS) || keyPoolCfg.retry_delay_ms || 1000,
    request_timeout_ms: parseInt(process.env.KEY_POOL_REQUEST_TIMEOUT_MS) || keyPoolCfg.request_timeout_ms || 10000,
    batch_test_interval_ms: parseInt(process.env.KEY_POOL_BATCH_TEST_INTERVAL_MS) || keyPoolCfg.batch_test_interval_ms || 500,
    cache_ttl_ms: parseInt(process.env.KEY_POOL_CACHE_TTL_MS) || keyPoolCfg.cache_ttl_ms || 300000,
    ...(keyPoolCfg.weights ? { weights: keyPoolCfg.weights } : {})
  };
}

// Get reasoning token settings
export function getReasoningTokens() {
  const cfg = getConfig();
  return {
    low: parseInt(process.env.REASONING_BUDGET_LOW) || cfg.reasoning_tokens?.low || 4096,
    medium: parseInt(process.env.REASONING_BUDGET_MEDIUM) || cfg.reasoning_tokens?.medium || 12288,
    high: parseInt(process.env.REASONING_BUDGET_HIGH) || cfg.reasoning_tokens?.high || 24576
  };
}

export function getReasoningBudget(level) {
  const tokens = getReasoningTokens();
  return tokens[level] || null;
}

// Get balance synchronization settings
export function getBalanceSyncConfig() {
  const cfg = getConfig();
  return {
    sync_interval_minutes: parseInt(process.env.SYNC_INTERVAL_MINUTES) || cfg.balance_sync?.sync_interval_minutes || 30,
    save_interval_minutes: parseInt(process.env.BALANCE_SAVE_INTERVAL_MINUTES) || cfg.balance_sync?.save_interval_minutes || 5
  };
}

// 🆕 Get automatic token synchronization settings
export function getTokenSyncConfig() {
  const cfg = getConfig();
  
  const parseBool = (envVar, defaultValue) => {
    if (!envVar) return defaultValue;
    return envVar.toLowerCase() === 'true' || envVar === '1';
  };
  
  return {
    enabled: parseBool(process.env.TOKEN_SYNC_ENABLED, cfg.token_sync?.enabled ?? true),
    interval_minutes: parseInt(process.env.TOKEN_SYNC_INTERVAL_MINUTES) || cfg.token_sync?.interval_minutes || 5,
    on_startup: parseBool(process.env.TOKEN_SYNC_ON_STARTUP, cfg.token_sync?.on_startup ?? true),
    startup_timeout_seconds: parseInt(process.env.TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS) || cfg.token_sync?.startup_timeout_seconds || 10
  };
}

// Save configuration to config.json
export function saveConfig(newConfig) {
  const configPath = path.join(__dirname, 'data', 'config.json');
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(newConfig, null, 2), 'utf-8');
    fs.renameSync(temporaryPath, configPath);
    config = newConfig; // Update the in-memory configuration
    return config;
  } catch (error) {
    throw new Error(`Failed to save data/config.json: ${error.message}`);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch {}
  }
}

// Update selected settings (supports deep merging)
export function updateConfig(updates) {
  const currentConfig = getConfig();
  const mergedConfig = deepMerge(currentConfig, updates);
  return saveConfig(mergedConfig);
}

// Deep-merge objects
function deepMerge(target, source) {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}
