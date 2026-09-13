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

  return {
    port: parseInt(process.env.PORT) || 3000,
    endpoint: [
      {
        name: "openai",
        base_url: "https://app.factory.ai/api/llm/o/v1/responses"
      },
      {
        name: "anthropic",
        base_url: "https://app.factory.ai/api/llm/a/v1/messages"
      },
      {
        name: "common",
        base_url: "https://app.factory.ai/api/llm/o/v1/chat/completions"
      }
    ],
    models: [
      {
        name: "Opus 4.1",
        id: "claude-opus-4-1-20250805",
        type: "anthropic",
        reasoning: "auto"
      },
      {
        name: "Sonnet 4",
        id: "claude-sonnet-4-20250514",
        type: "anthropic",
        reasoning: "auto"
      },
      {
        name: "Sonnet 4.5",
        id: "claude-sonnet-4-5-20250929",
        type: "anthropic",
        reasoning: "auto"
      },
      {
        name: "GPT-5",
        id: "gpt-5-2025-08-07",
        type: "openai",
        reasoning: "auto"
      },
      {
        name: "GPT-5-Codex",
        id: "gpt-5-codex",
        type: "openai",
        reasoning: "auto"
      },
      {
        name: "GLM-4.6",
        id: "glm-4.6",
        type: "common"
      }
    ],
    dev_mode: parseBool(process.env.NODE_ENV, false),
    user_agent: process.env.USER_AGENT || "factory-cli/0.213.0",
    system_prompt: process.env.SYSTEM_PROMPT || "You are Droid, an AI software engineering agent built by Factory.",
    limits: {
      notes_max_length: parseInt(process.env.NOTES_MAX_LENGTH) || 1000,
      max_json_log_size: parseInt(process.env.MAX_JSON_LOG_SIZE) || 5000
    },
    key_pool: {
      algorithm: process.env.KEY_POOL_ALGORITHM || "round-robin",
      retry: {
        enabled: parseBool(process.env.KEY_POOL_RETRY_ENABLED, true),
        maxRetries: parseInt(process.env.KEY_POOL_RETRY_MAX) || 3,
        retryDelay: parseInt(process.env.KEY_POOL_RETRY_DELAY_MS) || 1000
      },
      autoBan: {
        enabled: parseBool(process.env.KEY_POOL_AUTO_BAN_ENABLED, true),
        errorThreshold: parseInt(process.env.KEY_POOL_ERROR_THRESHOLD) || 5,
        ban402: parseBool(process.env.KEY_POOL_BAN_402, true),
        ban401: parseBool(process.env.KEY_POOL_BAN_401, false)
      },
      performance: {
        concurrentLimit: parseInt(process.env.KEY_POOL_CONCURRENT_LIMIT) || 100,
        requestTimeout: parseInt(process.env.KEY_POOL_REQUEST_TIMEOUT_MS) || 10000,
        factoryApiConcurrency: parseInt(process.env.FACTORY_API_CONCURRENCY) || 100
      },
      multiTier: {
        enabled: parseBool(process.env.KEY_POOL_MULTI_TIER_ENABLED, true),
        autoFallback: parseBool(process.env.KEY_POOL_MULTI_TIER_AUTO_FALLBACK, true)
      },
      retry_delay_ms: parseInt(process.env.KEY_POOL_RETRY_DELAY_MS) || 1000,
      request_timeout_ms: parseInt(process.env.KEY_POOL_REQUEST_TIMEOUT_MS) || 10000,
      batch_test_interval_ms: parseInt(process.env.KEY_POOL_BATCH_TEST_INTERVAL_MS) || 500,
      cache_ttl_ms: parseInt(process.env.KEY_POOL_CACHE_TTL_MS) || 300000
    },
    reasoning_tokens: {
      low: parseInt(process.env.REASONING_BUDGET_LOW) || 4096,
      medium: parseInt(process.env.REASONING_BUDGET_MEDIUM) || 12288,
      high: parseInt(process.env.REASONING_BUDGET_HIGH) || 24576
    },
    balance_sync: {
      sync_interval_minutes: parseInt(process.env.SYNC_INTERVAL_MINUTES) || 30,
      save_interval_minutes: parseInt(process.env.BALANCE_SAVE_INTERVAL_MINUTES) || 5
    },
    token_sync: {
      enabled: parseBool(process.env.TOKEN_SYNC_ENABLED, true),
      interval_minutes: parseInt(process.env.TOKEN_SYNC_INTERVAL_MINUTES) || 5,
      on_startup: parseBool(process.env.TOKEN_SYNC_ON_STARTUP, true),
      startup_timeout_seconds: parseInt(process.env.TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS) || 10
    },
    redis: {
      enabled: parseBool(process.env.REDIS_ENABLED, false),
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || "",
      db: parseInt(process.env.REDIS_DB) || 0,
      key_prefix: process.env.REDIS_KEY_PREFIX || "droid2api:"
    },
    cluster: {
      enabled: parseBool(process.env.CLUSTER_MODE, false),
      workers: parseInt(process.env.CLUSTER_WORKERS) || 0
    }
  };
}

/**
 * Initialize the configuration file
 * Create config.json from .env or defaults if it does not exist
 */
function initializeConfig() {
  const configPath = path.join(__dirname, 'data', 'config.json');
  
  // Create the configuration from environment variables if the file is missing
  if (!fs.existsSync(configPath)) {
    console.log('[INFO] config.json does not exist; initializing defaults from .env...');
    
    // Ensure the data directory exists
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // Get the default configuration from environment variables
    const defaultConfig = getDefaultConfigFromEnv();
    
    // Save to a file
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
    console.log('[INFO] ✅ Created config.json using settings from .env');
    console.log('[INFO] 💡 Use the admin panel for subsequent configuration changes, or edit config.json');
    
    return defaultConfig;
  }
  
  return null;
}

export function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'data', 'config.json');
    
    // Initialize the configuration (if needed)
    const initializedConfig = initializeConfig();
    if (initializedConfig) {
      config = initializedConfig;
      return config;
    }
    
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
