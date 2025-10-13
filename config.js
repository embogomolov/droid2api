import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let config = null;

/**
 * 从环境变量初始化默认配置
 * 只在 config.json 不存在时调用
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
    user_agent: process.env.USER_AGENT || "factory-cli/0.19.3",
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
 * 初始化配置文件
 * 如果 config.json 不存在，从 .env 或默认值创建
 */
function initializeConfig() {
  const configPath = path.join(__dirname, 'data', 'config.json');
  
  // 如果配置文件不存在，从环境变量创建
  if (!fs.existsSync(configPath)) {
    console.log('[INFO] config.json 不存在，从 .env 初始化默认配置...');
    
    // 确保 data 目录存在
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // 从环境变量获取默认配置
    const defaultConfig = getDefaultConfigFromEnv();
    
    // 保存到文件
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
    console.log('[INFO] ✅ 已创建 config.json，配置来自 .env');
    console.log('[INFO] 💡 之后修改配置请使用管理面板或直接编辑 config.json');
    
    return defaultConfig;
  }
  
  return null;
}

export function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'data', 'config.json');
    
    // 初始化配置（如果需要）
    const initializedConfig = initializeConfig();
    if (initializedConfig) {
      config = initializedConfig;
      return config;
    }
    
    // 读取现有配置
    const configData = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(configData);
    
    // 运行时环境变量优先级（仅特定变量）
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
  return cfg.models.find(m => m.id === modelId);
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
  return cfg.user_agent || 'factory-cli/0.19.3';
}

// 获取限制配置
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

// 获取密钥池配置（完整版，支持所有环境变量覆盖）
/**
 * 获取Factory API并发配置
 */
export function getFactoryApiConcurrency() {
  const cfg = getConfig();
  const keyPoolCfg = cfg.key_pool || {};
  return parseInt(process.env.FACTORY_API_CONCURRENCY) || 
         keyPoolCfg?.performance?.factoryApiConcurrency || 
         100; // 默认并发数100，与其他批量操作保持一致
}

export function getKeyPoolConfig() {
  const cfg = getConfig();
  const keyPoolCfg = cfg.key_pool || {};

  // 辅助函数：解析布尔值环境变量
  const parseBool = (envVar, defaultValue) => {
    if (!envVar) return defaultValue;
    return envVar.toLowerCase() === 'true' || envVar === '1';
  };

  return {
    // 轮询算法（env > config.json > 默认值）
    algorithm: process.env.KEY_POOL_ALGORITHM || keyPoolCfg.algorithm || 'round-robin',

    // 重试配置
    retry: {
      enabled: parseBool(process.env.KEY_POOL_RETRY_ENABLED, keyPoolCfg.retry?.enabled ?? true),
      maxRetries: parseInt(process.env.KEY_POOL_RETRY_MAX) || keyPoolCfg.retry?.maxRetries || 3,
      retryDelay: parseInt(process.env.KEY_POOL_RETRY_DELAY_MS) || keyPoolCfg.retry?.retryDelay || 1000
    },

    // 自动封禁配置
    autoBan: {
      enabled: parseBool(process.env.KEY_POOL_AUTO_BAN_ENABLED, keyPoolCfg.autoBan?.enabled ?? true),
      errorThreshold: parseInt(process.env.KEY_POOL_ERROR_THRESHOLD) || keyPoolCfg.autoBan?.errorThreshold || 5,
      ban402: parseBool(process.env.KEY_POOL_BAN_402, keyPoolCfg.autoBan?.ban402 ?? true),
      ban401: parseBool(process.env.KEY_POOL_BAN_401, keyPoolCfg.autoBan?.ban401 ?? false)
    },

    // 性能配置
    performance: {
      concurrentLimit: parseInt(process.env.KEY_POOL_CONCURRENT_LIMIT) || keyPoolCfg.performance?.concurrentLimit || 100,
      requestTimeout: parseInt(process.env.KEY_POOL_REQUEST_TIMEOUT_MS) || keyPoolCfg.performance?.requestTimeout || 10000,
      factoryApiConcurrency: parseInt(process.env.FACTORY_API_CONCURRENCY) || keyPoolCfg.performance?.factoryApiConcurrency || 100
    },

    // 🚀 BaSui：多级密钥池配置（Multi-Tier Pool）
    multiTier: {
      enabled: parseBool(process.env.KEY_POOL_MULTI_TIER_ENABLED, keyPoolCfg.multiTier?.enabled ?? false),
      autoFallback: parseBool(process.env.KEY_POOL_MULTI_TIER_AUTO_FALLBACK, keyPoolCfg.multiTier?.autoFallback ?? true)
    },

    // 向后兼容：保留旧字段
    retry_delay_ms: parseInt(process.env.KEY_POOL_RETRY_DELAY_MS) || keyPoolCfg.retry_delay_ms || 1000,
    request_timeout_ms: parseInt(process.env.KEY_POOL_REQUEST_TIMEOUT_MS) || keyPoolCfg.request_timeout_ms || 10000,
    batch_test_interval_ms: parseInt(process.env.KEY_POOL_BATCH_TEST_INTERVAL_MS) || keyPoolCfg.batch_test_interval_ms || 500,
    cache_ttl_ms: parseInt(process.env.KEY_POOL_CACHE_TTL_MS) || keyPoolCfg.cache_ttl_ms || 300000
  };
}

// 获取推理token配置
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

// 获取余额同步配置
export function getBalanceSyncConfig() {
  const cfg = getConfig();
  return {
    sync_interval_minutes: parseInt(process.env.SYNC_INTERVAL_MINUTES) || cfg.balance_sync?.sync_interval_minutes || 30,
    save_interval_minutes: parseInt(process.env.BALANCE_SAVE_INTERVAL_MINUTES) || cfg.balance_sync?.save_interval_minutes || 5
  };
}

// 🆕 获取Token自动同步配置
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

// 保存配置到 config.json
export function saveConfig(newConfig) {
  try {
    const configPath = path.join(__dirname, 'data', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf-8');
    config = newConfig; // 更新内存中的配置
    return config;
  } catch (error) {
    throw new Error(`Failed to save data/config.json: ${error.message}`);
  }
}

// 更新部分配置（支持深度合并）
export function updateConfig(updates) {
  const currentConfig = getConfig();
  const mergedConfig = deepMerge(currentConfig, updates);
  return saveConfig(mergedConfig);
}

// 深度合并对象
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
