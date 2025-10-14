/**
 * OAuth 认证模块
 *
 * 功能：
 * - 支持 DROID_REFRESH_KEY 环境变量
 * - 支持 data/auth.json 文件认证（项目级，Docker 友好）
 * - 支持 ~/.factory/auth.json 文件认证（用户级，兜底）
 * - WorkOS OAuth 自动刷新（6小时间隔，8小时有效期）
 * - 刷新失败时使用旧 token 兜底
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { logDebug, logError, logInfo, logWarning } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class OAuthAuthenticator {
  constructor() {
    this.authFilePath = null;
    this.authSource = null;
    this.tokenData = null;
    this.lastRefreshTime = null;
  }

  /**
   * 从 DROID_REFRESH_KEY 或 auth.json 加载认证信息
   * 优先级：DROID_REFRESH_KEY > data/auth.json > ~/.factory/auth.json
   *
   * 🔧 BaSui：如果没有配置任何 refresh_token，直接返回 null，不报错！
   */
  async loadOAuthConfig() {
    // 1️⃣ 检查 DROID_REFRESH_KEY 环境变量
    const envRefreshKey = process.env.DROID_REFRESH_KEY;
    if (envRefreshKey && envRefreshKey.trim() !== '') {
      logInfo('Using refresh token from DROID_REFRESH_KEY');
      this.authSource = 'env';
      // 老王：保存到项目级 data/auth.json（Docker 友好）
      this.authFilePath = path.join(__dirname, 'data', 'auth.json');
      return { type: 'refresh', value: envRefreshKey.trim() };
    }

    // 2️⃣ 检查 data/auth.json 文件（项目级，优先）⭐
    const projectAuthPath = path.join(__dirname, 'data', 'auth.json');
    if (fs.existsSync(projectAuthPath)) {
      try {
        const authData = JSON.parse(fs.readFileSync(projectAuthPath, 'utf-8'));
        logInfo('Using auth from data/auth.json (project-level)');
        this.authSource = 'project-file';
        this.authFilePath = projectAuthPath;

        // 老王：恢复 lastRefreshTime，用于判断是否需要刷新
        if (authData.last_refresh) {
          this.lastRefreshTime = authData.last_refresh;
        }

        // 🔧 BaSui：修复字段读取 - 优先使用 refresh_token 作为缓存判断依据
        if (authData.refresh_token || authData.api_key) {
          this.tokenData = authData;
        }

        if (authData.refresh_token) {
          return { type: 'refresh', value: authData.refresh_token };
        }
        if (authData.api_key) {
          return { type: 'api_key', value: authData.api_key };
        }
      } catch (error) {
        logError('Failed to parse data/auth.json', error);
      }
    }

    // 3️⃣ 检查 ~/.factory/auth.json 文件（用户级，兜底）
    // 🔧 BaSui：添加环境变量控制 - 可通过 SKIP_FACTORY_AUTH=true 禁止读取用户级配置
    if (process.env.SKIP_FACTORY_AUTH === 'true') {
      logInfo('SKIP_FACTORY_AUTH is set, skipping ~/.factory/auth.json');
      return null;
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (homeDir) {
      const factoryAuthPath = path.join(homeDir, '.factory', 'auth.json');
      if (fs.existsSync(factoryAuthPath)) {
        try {
          const authData = JSON.parse(fs.readFileSync(factoryAuthPath, 'utf-8'));
          logInfo('Using auth from ~/.factory/auth.json (user-level)');
          this.authSource = 'user-file';
          this.authFilePath = factoryAuthPath;

          // 老王：恢复 lastRefreshTime
          if (authData.last_refresh) {
            this.lastRefreshTime = authData.last_refresh;
          }

          // 🔧 BaSui：修复字段读取 - 优先使用 refresh_token 作为缓存判断依据
          if (authData.refresh_token || authData.api_key) {
            this.tokenData = authData;
          }

          if (authData.refresh_token) {
            return { type: 'refresh', value: authData.refresh_token };
          }
          if (authData.api_key) {
            return { type: 'api_key', value: authData.api_key };
          }
        } catch (error) {
          logError('Failed to parse ~/.factory/auth.json', error);
        }
      }
    }

    return null;
  }

  /**
   * WorkOS OAuth 刷新逻辑
   * 调用 WorkOS API 刷新 access_token
   *
   * @param {string} refreshToken - refresh_token
   * @returns {Promise<{accessToken: string, refreshToken: string} | null>}
   */
  async refreshApiKey(refreshToken) {
    const url = 'https://api.workos.com/user_management/authenticate';

    logInfo('Refreshing API key via WorkOS OAuth...');

    // 🔧 修复 BaSui：检查 WORKOS_CLIENT_ID 是否配置
    const clientId = process.env.WORKOS_CLIENT_ID || 'client_factory';
    if (!process.env.WORKOS_CLIENT_ID) {
      logWarning('WORKOS_CLIENT_ID not set, using default: client_factory');
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logError(`WorkOS OAuth refresh failed: ${response.status} ${response.statusText}`, errorText);

        // 🔧 修复 BaSui：提供更友好的错误提示
        if (response.status === 400 && errorText.includes('invalid_client')) {
          logError('❌ OAuth 认证失败！可能的原因：');
          logError('  1. WORKOS_CLIENT_ID 环境变量未设置或不正确');
          logError('  2. refresh_token 已过期或无效');
          logError('  3. WorkOS API 配置变更');
          logError('💡 建议：检查环境变量配置或联系管理员');
        }

        return null;
      }

      const data = await response.json();

      if (!data.access_token) {
        logError('WorkOS OAuth response missing access_token', data);
        return null;
      }

      logInfo('Successfully refreshed API key ✅');

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken, // 如果没有新的 refresh_token，使用旧的
      };
    } catch (error) {
      logError('Failed to refresh API key', error);
      return null;
    }
  }

  /**
   * 保存 token 到文件
   *
   * @param {string} accessToken - API key (access_token)
   * @param {string} refreshToken - refresh_token
   */
  async saveTokens(accessToken, refreshToken) {
    if (!this.authFilePath) {
      logWarning('No auth file path configured, skipping token save');
      return;
    }

    const tokenData = {
      api_key: accessToken,
      refresh_token: refreshToken,
      expires_at: Date.now() + (8 * 60 * 60 * 1000), // 老王：8小时后过期
      last_refresh: Date.now(),
    };

    try {
      // 老王：确保目录存在（修复问题5）
      const dir = path.dirname(this.authFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logInfo(`Created directory: ${dir}`);
      }

      // 老王：保存到文件
      fs.writeFileSync(this.authFilePath, JSON.stringify(tokenData, null, 2), 'utf-8');
      logInfo(`Saved OAuth tokens to ${this.authFilePath}`);
    } catch (error) {
      logError('Failed to save OAuth tokens', error);
    }
  }

  /**
   * 判断是否需要刷新
   * - 如果从未刷新过，返回 true
   * - 如果距离上次刷新超过 6 小时，返回 true
   * - 如果 token 已过期（超过 8 小时），返回 true
   *
   * @returns {boolean}
   */
  shouldRefresh() {
    // 老王：如果有 expires_at，优先判断是否过期（修复问题4）
    if (this.tokenData?.expires_at) {
      const isExpired = Date.now() >= this.tokenData.expires_at;
      if (isExpired) {
        logDebug('Token expired, refresh needed');
        return true;
      }
    }

    // 老王：如果没有 lastRefreshTime，说明从未刷新过
    if (!this.lastRefreshTime) {
      logDebug('Never refreshed, refresh needed');
      return true;
    }

    // 老王：距离上次刷新超过 6 小时，需要刷新
    const hoursSinceRefresh = (Date.now() - this.lastRefreshTime) / (1000 * 60 * 60);
    const needsRefresh = hoursSinceRefresh >= 6;

    if (needsRefresh) {
      logDebug(`${hoursSinceRefresh.toFixed(2)} hours since last refresh, refresh needed`);
    }

    return needsRefresh;
  }

  /**
   * 获取 OAuth API Key
   *
   * 逻辑：
   * 1. 如果是静态 api_key，直接返回
   * 2. 如果是 refresh_token：
   *    - 先尝试使用缓存的 token（如果未过期）
   *    - 如果需要刷新或首次获取，调用 refreshApiKey()
   *    - 如果刷新失败，尝试使用旧的 token 兜底（修复问题3）
   *
   * @returns {Promise<string | null>}
   */
  async getOAuthApiKey() {
    const config = await this.loadOAuthConfig();
    if (!config) {
      return null;
    }

    // 老王：如果是静态 api_key，直接返回
    if (config.type === 'api_key') {
      logDebug('Using static API key from auth.json');
      return config.value;
    }

    // 老王：如果是 refresh_token
    if (config.type === 'refresh') {
      // 老王：先尝试使用缓存的 token（如果未过期）
      if (this.tokenData?.api_key && !this.shouldRefresh()) {
        logDebug('Using cached OAuth token (not expired)');
        return this.tokenData.api_key;
      }

      // 老王：需要刷新或首次获取
      logDebug('Refreshing OAuth token...');
      try {
        const result = await this.refreshApiKey(config.value);
        if (result && result.accessToken) {
          await this.saveTokens(result.accessToken, result.refreshToken);
          this.tokenData = {
            api_key: result.accessToken,
            refresh_token: result.refreshToken,
            expires_at: Date.now() + (8 * 60 * 60 * 1000),
            last_refresh: Date.now(),
          };
          this.lastRefreshTime = Date.now();
          return result.accessToken;
        }
      } catch (error) {
        logError('Failed to refresh OAuth token', error);
      }

      // 老王：刷新失败，尝试使用旧的 token 兜底（修复问题3）
      if (this.tokenData?.api_key) {
        const hoursUntilExpiry = this.tokenData.expires_at
          ? (this.tokenData.expires_at - Date.now()) / (1000 * 60 * 60)
          : -1;

        if (hoursUntilExpiry > 0) {
          logWarning(`OAuth refresh failed, using cached token (expires in ${hoursUntilExpiry.toFixed(2)} hours)`);
        } else {
          logWarning('OAuth refresh failed, using potentially expired token as fallback');
        }

        return this.tokenData.api_key;
      }

      logError('OAuth token refresh failed and no cached token available');
    }

    return null;
  }

  /**
   * 初始化 OAuth 认证
   * 在服务器启动时调用
   */
  async initialize() {
    logInfo('Initializing OAuth authentication...');

    try {
      const config = await this.loadOAuthConfig();
      if (config) {
        logInfo(`OAuth authentication enabled (source: ${this.authSource})`);

        // 老王：如果是 refresh_token，尝试预刷新
        if (config.type === 'refresh' && this.shouldRefresh()) {
          logInfo('Pre-refreshing OAuth token on startup...');
          await this.getOAuthApiKey();
        }
      } else {
        logInfo('OAuth authentication not configured');
      }
    } catch (error) {
      logError('Failed to initialize OAuth authentication', error);
    }
  }
}

// 导出单例
export const oauthAuthenticator = new OAuthAuthenticator();
