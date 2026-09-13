/**
 * OAuth authentication module
 *
 * Features:
 * - Supports the DROID_REFRESH_KEY environment variable
 * - Supports file-based authentication via data/auth.json (project-level, Docker-friendly)
 * - Supports file-based authentication via ~/.factory/auth.json (user-level fallback)
 * - WorkOS OAuth automatic refresh (6-hour interval, 8-hour validity)
 * - Falls back to the previous token if refresh fails
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
   * Load authentication credentials from DROID_REFRESH_KEY or auth.json
   * Priority: DROID_REFRESH_KEY > data/auth.json > ~/.factory/auth.json
   *
   * 🔧 BaSui: Return null without an error when no refresh_token is configured!
   */
  async loadOAuthConfig() {
    // 1️⃣ Check the DROID_REFRESH_KEY environment variable
    const envRefreshKey = process.env.DROID_REFRESH_KEY;
    if (envRefreshKey && envRefreshKey.trim() !== '') {
      logInfo('Using refresh token from DROID_REFRESH_KEY');
      this.authSource = 'env';
      // Lao Wang: Save to project-level data/auth.json (Docker-friendly)
      this.authFilePath = path.join(__dirname, 'data', 'auth.json');
      return { type: 'refresh', value: envRefreshKey.trim() };
    }

    // 2️⃣ Check data/auth.json (project-level, preferred)⭐
    const projectAuthPath = path.join(__dirname, 'data', 'auth.json');
    if (fs.existsSync(projectAuthPath)) {
      try {
        const authData = JSON.parse(fs.readFileSync(projectAuthPath, 'utf-8'));
        logInfo('Using auth from data/auth.json (project-level)');
        this.authSource = 'project-file';
        this.authFilePath = projectAuthPath;

        // Lao Wang: Restore lastRefreshTime to determine whether refresh is needed
        if (authData.last_refresh) {
          this.lastRefreshTime = authData.last_refresh;
        }

        // 🔧 BaSui: Fix field loading: use refresh_token first to determine whether credentials can be cached
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

    // 3️⃣ Check ~/.factory/auth.json (user-level fallback)
    // 🔧 BaSui: Add an environment switch: SKIP_FACTORY_AUTH=true disables user-level configuration loading
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

          // Lao Wang: Restore lastRefreshTime
          if (authData.last_refresh) {
            this.lastRefreshTime = authData.last_refresh;
          }

          // 🔧 BaSui: Fix field loading: use refresh_token first to determine whether credentials can be cached
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
   * WorkOS OAuth refresh logic
   * Call the WorkOS API to refresh access_token
   *
   * @param {string} refreshToken - refresh_token
   * @returns {Promise<{accessToken: string, refreshToken: string} | null>}
   */
  async refreshApiKey(refreshToken) {
    const url = 'https://api.workos.com/user_management/authenticate';

    logInfo('Refreshing API key via WorkOS OAuth...');

    // 🔧 Fix, BaSui: Check whether WORKOS_CLIENT_ID is configured
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

        // 🔧 Fix, BaSui: Provide clearer error messages
        if (response.status === 400 && errorText.includes('invalid_client')) {
          logError('❌ OAuth authentication failed. Possible causes: ');
          logError('  1. WORKOS_CLIENT_ID environment variable is missing or incorrect');
          logError('  2. refresh_token has expired or is invalid');
          logError('  3. WorkOS API configuration has changed');
          logError('💡 Tip: Check the environment variables or contact the administrator');
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
        refreshToken: data.refresh_token || refreshToken, // Reuse the previous refresh_token if no new one is returned
      };
    } catch (error) {
      logError('Failed to refresh API key', error);
      return null;
    }
  }

  /**
   * Save tokens to a file
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
      expires_at: Date.now() + (8 * 60 * 60 * 1000), // Lao Wang: Expires after 8 hours
      last_refresh: Date.now(),
    };

    try {
      // Lao Wang: Ensure the directory exists (fix for issue 5)
      const dir = path.dirname(this.authFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logInfo(`Created directory: ${dir}`);
      }

      // Lao Wang: Save to a file
      fs.writeFileSync(this.authFilePath, JSON.stringify(tokenData, null, 2), 'utf-8');
      logInfo(`Saved OAuth tokens to ${this.authFilePath}`);
    } catch (error) {
      logError('Failed to save OAuth tokens', error);
    }
  }

  /**
   * Determine whether a refresh is needed
   * - If never refreshed, return true
   * - If more than 6 hours have elapsed since the last refresh, return true
   * - If the token has expired (after 8 hours), return true
   *
   * @returns {boolean}
   */
  shouldRefresh() {
    // Lao Wang: Check expires_at first when present (fix for issue 4)
    if (this.tokenData?.expires_at) {
      const isExpired = Date.now() >= this.tokenData.expires_at;
      if (isExpired) {
        logDebug('Token expired, refresh needed');
        return true;
      }
    }

    // Lao Wang: Missing lastRefreshTime means the token has never been refreshed
    if (!this.lastRefreshTime) {
      logDebug('Never refreshed, refresh needed');
      return true;
    }

    // Lao Wang: Refresh when more than 6 hours have elapsed since the last refresh
    const hoursSinceRefresh = (Date.now() - this.lastRefreshTime) / (1000 * 60 * 60);
    const needsRefresh = hoursSinceRefresh >= 6;

    if (needsRefresh) {
      logDebug(`${hoursSinceRefresh.toFixed(2)} hours since last refresh, refresh needed`);
    }

    return needsRefresh;
  }

  /**
   * Get the OAuth API Key
   *
   * Logic:
   * 1. Return a static api_key directly
   * 2. If using a refresh_token:
   *    - Try the cached token first (if it has not expired)
   *    - Call refreshApiKey() when a refresh or initial token is needed
   *    - If refresh fails, try the previous token as a fallback (fix for issue 3)
   *
   * @returns {Promise<string | null>}
   */
  async getOAuthApiKey() {
    const config = await this.loadOAuthConfig();
    if (!config) {
      return null;
    }

    // Lao Wang: Return a static api_key directly
    if (config.type === 'api_key') {
      logDebug('Using static API key from auth.json');
      return config.value;
    }

    // Lao Wang: If using a refresh_token
    if (config.type === 'refresh') {
      // Lao Wang: Try the cached token first (if it has not expired)
      if (this.tokenData?.api_key && !this.shouldRefresh()) {
        logDebug('Using cached OAuth token (not expired)');
        return this.tokenData.api_key;
      }

      // Lao Wang: Refresh or initial token retrieval is needed
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

      // Lao Wang: If refresh fails, try the previous token as a fallback (fix for issue 3)
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
   * Initialize OAuth authentication
   * Called at server startup
   */
  async initialize() {
    logInfo('Initializing OAuth authentication...');

    try {
      const config = await this.loadOAuthConfig();
      if (config) {
        logInfo(`OAuth authentication enabled (source: ${this.authSource})`);

        // Lao Wang: Try refreshing in advance when using a refresh_token
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

// Export the singleton
export const oauthAuthenticator = new OAuthAuthenticator();
