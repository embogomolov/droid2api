/**
 * 🚀 droid2api Server entry point
 *
 * Startup mode selection:
 * - Default: single-process mode (fast startup)
 * - Cluster: set CLUSTER_MODE=true for multiple processes (high concurrency)
 *
 * Environment variables:
 * - CLUSTER_MODE=true     // Enable cluster mode
 * - CLUSTER_WORKERS=4     // Worker count (defaults to CPU core count)
 */

import 'dotenv/config';
import cluster from 'cluster';
import os from 'os';

// BaSui: 🎯 Detect startup mode
const CLUSTER_MODE = process.env.CLUSTER_MODE === 'true';
const CLUSTER_WORKERS = parseInt(process.env.CLUSTER_WORKERS || os.cpus().length);

// ========== Cluster mode (primary process) ==========
if (CLUSTER_MODE && cluster.isPrimary) {
  const { logInfo, logError } = await import('./logger.js');
  const redisCache = (await import('./utils/redis-cache.js')).default;

  logInfo(`🚀 Starting in cluster mode...`);
  logInfo(`📊 CPU core count: ${os.cpus().length}`);
  logInfo(`👷 Worker process count: ${CLUSTER_WORKERS}`);

  // Connect to Redis (if configured)
  if (process.env.REDIS_HOST) {
    try {
      await redisCache.connect();
    } catch (err) {
      logError('Redis connection failed; caching is disabled', err);
    }
  }

  // Create worker processes
  const workers = new Map();
  let shuttingDown = false;

  for (let i = 0; i < CLUSTER_WORKERS; i++) {
    const worker = cluster.fork();
    workers.set(worker.id, {
      worker,
      restarts: 0,
      lastRestart: Date.now()
    });

    logInfo(`✅ Worker ${worker.process.pid} started (${i + 1}/${CLUSTER_WORKERS})`);
  }

  // Automatically restart workers when they exit
  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) return;
    const workerInfo = workers.get(worker.id);

    if (signal) {
      logError(`Worker ${worker.process.pid} terminated by signal ${signal}`);
    } else if (code !== 0) {
      logError(`Worker ${worker.process.pid} exited with code: ${code}`);
    } else {
      logInfo(`Worker ${worker.process.pid} exited normally`);
    }

    // Check restart frequency to prevent an endless restart loop
    const now = Date.now();
    if (workerInfo && now - workerInfo.lastRestart < 60000) {
      workerInfo.restarts++;
    } else if (workerInfo) {
      workerInfo.restarts = 0;
    }

    if (workerInfo && workerInfo.restarts > 5) {
      logError(`Worker ${worker.process.pid} restarted more than 5 times in 1 minute; stopping automatic restarts`);
      workers.delete(worker.id);
      return;
    }

    // Restart worker
    logInfo(`🔄 Restarting Worker...`);
    const newWorker = cluster.fork();

    workers.set(newWorker.id, {
      worker: newWorker,
      restarts: workerInfo ? workerInfo.restarts : 0,
      lastRestart: now
    });

    if (workerInfo) {
      workers.delete(worker.id);
    }

    logInfo(`✅ Worker ${newWorker.process.pid} started (restart)`);
  });

  // Graceful shutdown handling
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`\n Received ${signal}; shutting down gracefully...`);

    // Stop accepting new connections
    const exits = [...workers.values()].filter(({ worker }) => !worker.isDead()).map(({ worker }) =>
      new Promise(resolve => { worker.once('exit', resolve); if (worker.isConnected()) worker.send('shutdown'); else worker.kill(); }));

    // Wait for all workers to exit
    const shutdownTimeout = setTimeout(() => {
      logError('⚠️ Graceful shutdown timed out; forcing exit');
      for (const { worker } of workers.values()) if (!worker.isDead()) worker.kill();
      process.exit(1);
    }, 30000); // 30-second timeout

    try {
      await Promise.all(exits);
      // Close the Redis connection
      if (process.env.REDIS_HOST) {
        await redisCache.disconnect();
      }

      logInfo('✅ All connections closed');
      clearTimeout(shutdownTimeout);
      process.exit(0);
    } catch (error) {
      logError('Error closing connections', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  // Zero-downtime reload (USR2 signal)
  process.on('SIGUSR2', () => {
    logInfo('🔄 Reload signal received; starting a zero-downtime reload...');

    const workersArray = Array.from(workers.values());
    let reloadedCount = 0;

    // Restart workers one at a time so at least one remains available
    const reloadNext = () => {
      if (reloadedCount >= workersArray.length) {
        logInfo('✅ All workers reloaded');
        return;
      }

      const { worker } = workersArray[reloadedCount];
      reloadedCount++;

      // Send the reload signal
      worker.send('shutdown');

      // Wait for the worker to exit and restart automatically (handled by the exit event)
      setTimeout(reloadNext, 2000); // 2 seconds before reloading the next worker
    };

    reloadNext();
  });

  logInfo(`✅ Cluster started. All ${CLUSTER_WORKERS} workers are running`);
  logInfo(`💡 Tips: `);
  logInfo(`   - Send SIGUSR2 for a zero-downtime reload: kill -USR2 ${process.pid}`);
  logInfo(`   - Send SIGTERM for graceful shutdown: kill -TERM ${process.pid}`);

} else {
  // ========== Single-process mode or worker process ==========

  const express = await import('express');
  const { loadConfig, isDevMode, getPort, getTokenSyncConfig } = await import('./config.js');
  const { logInfo, logError, logWarning, logDebug } = await import('./logger.js');
  const router = (await import('./routes.js')).default;
  const { initializeAuth, default: keyPoolManager } = await import('./auth.js');
  const adminRouter = (await import('./api/admin-routes.js')).default;
  const tokenUsageRouter = (await import('./api/token-usage-routes.js')).default;
  const statsRouter = (await import('./api/stats-routes.js')).default;
  const logStreamRouter = (await import('./api/log-stream-routes.js')).default;
  const keywordFilterRouter = (await import('./api/keyword-filter-routes.js')).default;
  const statsTrackerMiddleware = (await import('./middleware/stats-tracker.js')).default;
  const { logCollectorMiddleware } = await import('./middleware/log-collector.js');
  const { requestBodyMiddleware } = await import('./middleware/request-body.js');
  const redisCache = (await import('./utils/redis-cache.js')).default;
  const { startDailyResetScheduler, stopDailyResetScheduler, onDateChange } = await import('./utils/daily-reset-scheduler.js');
  const { startTokenSyncScheduler, stopTokenSyncScheduler } = await import('./utils/token-sync-scheduler.js');
  const fileWriterManager = (await import('./utils/async-file-writer.js')).default;
  const tokenUsageManager = (await import('./utils/token-usage-manager.js')).default;
  const { destroyPool } = await import('./utils/http-client.js');
  const { getWindowSync } = await import('./utils/window-sync.js');
  const windowSync = getWindowSync(keyPoolManager);

  const app = express.default();
  let server, shuttingDown = false;
  const backgroundTimers = new Set();
  const scheduleInterval = (...args) => { const timer = setInterval(...args); backgroundTimers.add(timer); return timer; };
  const scheduleTimeout = (...args) => { const timer = setTimeout(...args); backgroundTimers.add(timer); return timer; };
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`Received ${signal}; stopping server...`);
    const deadline = setTimeout(() => { console.error('Shutdown timed out after 10 seconds'); process.exit(1); }, 10000);
    let drainTimeout;
    try {
      for (const timer of backgroundTimers) clearTimeout(timer);
      stopDailyResetScheduler();
      stopTokenSyncScheduler();
      await windowSync.stop();
      if (server?.listening) {
        // SSE clients must not hold shutdown open indefinitely.
        await new Promise(resolve => {
          server.close(resolve);
          drainTimeout = setTimeout(() => server.closeAllConnections(), 1500);
        });
        clearTimeout(drainTimeout);
      }
      destroyPool();
      tokenUsageManager.destroy();
      await redisCache.disconnect();
      await new Promise(resolve => setImmediate(resolve));
      await keyPoolManager.saveKeyPoolImmediately();
      console.log('Flushing all pending writes...');
      await fileWriterManager.destroyAll();
      console.log('All pending writes flushed; server stopped');
      clearTimeout(deadline);
      process.exit(0);
    } catch (error) {
      console.error('Shutdown failed:', error.message);
      process.exit(1);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => void shutdown(signal));
  if (CLUSTER_MODE) process.on('message', message => { if (message === 'shutdown') void shutdown('cluster shutdown'); });

  // BaSui: Override res.json to force UTF-8 encoding for all JSON responses and prevent garbled non-ASCII text
  app.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return originalJson(data);
    };
    next();
  });

  // API Access control middleware
  function apiKeyAuth(req, res, next) {
    // BaSui: Skip admin APIs, the root path, and static files (matched by extension)
    // Admin APIs and root path
    if (req.path === '/' || req.path.startsWith('/admin') || req.path.startsWith('/factory')) {
      return next();
    }

    // Static files (match by extension rather than hard-coding filenames)
    const staticFileExtensions = ['.html', '.css', '.js', '.ico', '.png', '.jpg', '.svg', '.woff', '.woff2', '.ttf'];
    if (staticFileExtensions.some(ext => req.path.endsWith(ext))) {
      return next();
    }

    const clientApiKey = req.headers['x-api-key'] || req.headers['authorization'];
    const validApiKey = process.env.API_ACCESS_KEY;

    // Skip authentication if no access key is configured
    if (!validApiKey || validApiKey === 'your-secure-access-key-here') {
      return next();
    }

    // Validate the key format: Bearer xxx or a plain key xxx
    const cleanClientKey = clientApiKey?.replace('Bearer ', '').trim();
    const cleanValidKey = validApiKey.trim();

    if (!cleanClientKey || cleanClientKey !== cleanValidKey) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing API access key'
      });
    }

    // This credential authenticates the local proxy, not Factory.
    delete req.headers.authorization;
    delete req.headers['x-api-key'];
    next();
  }

  // BaSui: Register static file serving before API authentication to prevent authentication from blocking assets
  app.use(express.default.static('public'));

  // Claude Code's unauthenticated connection-warming probe carries no model request.
  app.head('/api/hello', (req, res) => res.status(204).end());

  // Apply API access control
  app.use(apiKeyAuth);

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Admin-Key, anthropic-version');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // BaSui: Log collection middleware (register before routes)
  app.use(logCollectorMiddleware);
  app.use(requestBodyMiddleware);

  // BaSui: Request statistics middleware (register before routes)
  app.use(statsTrackerMiddleware);

  app.use(router);

  // Factory Token usage management API routes
  app.use('/admin/token', tokenUsageRouter);

  // Token statistics API routes (new accurate statistics)
  const tokenStatsRouter = (await import('./api/token-stats-routes.js')).default;
  app.use('/admin/token-stats', tokenStatsRouter);

  // BaSui: Request statistics API routes
  app.use('/admin/stats', statsRouter);

  // BaSui: Live log stream API routes
  app.use('/admin', logStreamRouter);

  // BaSui: Keyword filter management API routes
  app.use('/admin/keyword-filter', keywordFilterRouter);

  // Admin API routes
  app.use('/admin', adminRouter);

  // BaSui: Static file serving was registered before authentication above; remove this duplicate registration

  app.get('/', (req, res) => {
    res.json({
      name: 'droid2api',
      version: '1.4.0',
      description: 'OpenAI Compatible API Proxy',
      mode: CLUSTER_MODE ? 'cluster' : 'single',
      endpoints: [
        'GET /v1/models',
        'POST /v1/chat/completions',
        'POST /v1/responses',
        'POST /v1/messages',
        'POST /v1/messages/count_tokens'
      ]
    });
  });

  // Handle automatic browser requests for favicon.ico to avoid repeated 404 logs
  app.get('/favicon.ico', (req, res) => {
    res.status(204).end(); // 204 No Content, Return no content
  });

  // 404 handling: catch unmatched routes, excluding admin paths with their own error handling
  app.use((req, res, next) => {
    // BaSui: Skip /admin paths, which have their own error handling
    if (req.path.startsWith('/admin')) {
      return next();
    }

    const errorInfo = {
      timestamp: new Date().toISOString(),
      method: req.method,
      url: req.originalUrl || req.url,
      path: req.path,
      query: req.query,
      params: req.params,
      body: req.body,
      headers: {
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
        'origin': req.headers['origin'],
        'referer': req.headers['referer']
      },
      ip: req.ip || req.connection.remoteAddress
    };

    console.error('\n' + '='.repeat(80));
    console.error('❌ Invalid request URL');
    console.error('='.repeat(80));
    console.error(`Time: ${errorInfo.timestamp}`);
    console.error(`Method: ${errorInfo.method}`);
    console.error(`URL: ${errorInfo.url}`);
    console.error(`Path: ${errorInfo.path}`);

    if (Object.keys(errorInfo.query).length > 0) {
      console.error(`Query parameters: ${JSON.stringify(errorInfo.query, null, 2)}`);
    }

    if (errorInfo.body && Object.keys(errorInfo.body).length > 0) {
      console.error(`Request body: ${JSON.stringify(errorInfo.body, null, 2)}`);
    }

    console.error(`Client IP: ${errorInfo.ip}`);
    console.error(`User-Agent: ${errorInfo.headers['user-agent'] || 'N/A'}`);

    if (errorInfo.headers.referer) {
      console.error(`Origin: ${errorInfo.headers.referer}`);
    }

    console.error('='.repeat(80) + '\n');

    logError('Invalid request path', errorInfo);

    res.status(404).json({
      error: 'Not Found',
      message: `Route ${req.method} ${req.path} does not exist`,
      timestamp: errorInfo.timestamp,
      availableEndpoints: [
        'GET /v1/models',
        'POST /v1/chat/completions',
        'POST /v1/responses',
        'POST /v1/messages',
        'POST /v1/messages/count_tokens'
      ]
    });
  });

  // Error-handling middleware
  app.use((err, req, res, next) => {
    logError('Unhandled error', err);
    res.status(500).json({
      error: 'Internal server error',
      message: isDevMode() ? err.message : undefined
    });
  });

  // Start the server
  (async () => {
    try {
      loadConfig();
      logInfo('Configuration loaded successfully');
      logInfo(`Dev mode: ${isDevMode()}`);

      if (CLUSTER_MODE) {
        logInfo(`Cluster mode: Worker ${process.pid}`);
      }

      // Connect to Redis (worker or single-process mode)
      if (!CLUSTER_MODE && process.env.REDIS_HOST) {
        try {
          await redisCache.connect();
        } catch (err) {
          // Redis connection failure must not prevent startup
        }
      }

      // Initialize auth system (load and setup API key if needed)
      // This won't throw error if no auth config is found - will use client auth
      await initializeAuth();
      if (shuttingDown) return;
      windowSync.start();

      // BaSui: Start the daily reset scheduler to perform cleanup when the date changes
      startDailyResetScheduler(60000); // Check for date changes every minute

      // BaSui: Register a callback triggered by a date change
      onDateChange(() => {
        logInfo('🌅 Date changed. The requests-today counter has been reset to 0');
        logInfo('   Note: total_requests remains cumulative; today_requests has been reset to zero');
      });

      // BaSui: Start automatic token synchronization using configuration settings
      const tokenSyncConfig = getTokenSyncConfig();
      
      if (tokenSyncConfig.enabled) {
        logInfo(`🔄 Starting automatic token synchronization (interval: ${tokenSyncConfig.interval_minutes} minutes)...`);
        
        const intervalMs = tokenSyncConfig.interval_minutes * 60 * 1000;
        const timeoutMs = tokenSyncConfig.startup_timeout_seconds * 1000;
        
        if (tokenSyncConfig.on_startup && timeoutMs > 0) {
          // Wait for the initial synchronization at startup
          const syncResult = await new Promise((resolve) => {
            // Start the scheduler and synchronize immediately
            startTokenSyncScheduler({
              intervalMs: intervalMs,
              immediate: true
            });
            
            // Wait for the initial synchronization to finish
            const checkInterval = scheduleInterval(async () => {
              const { default: tokenSyncScheduler } = await import('./utils/token-sync-scheduler.js');
              const status = tokenSyncScheduler.getSyncStatus();
              
              if (!status.inProgress && status.lastSyncTime) {
                clearInterval(checkInterval);
                resolve(status);
              }
            }, 500);
            
            // Handle timeout
            scheduleTimeout(() => {
              clearInterval(checkInterval);
              resolve({ timeout: true });
            }, timeoutMs);
          });
          
          if (syncResult.timeout) {
            logWarning(`⚠️ Token initial synchronization timed out (${tokenSyncConfig.startup_timeout_seconds} seconds); continuing server startup while synchronization runs in the background`);
          } else {
            logInfo(`✅ Token automatic synchronization scheduler started and initial synchronization completed`);
          }
        } else {
          // Start without waiting
          startTokenSyncScheduler({
            intervalMs: intervalMs,
            immediate: tokenSyncConfig.on_startup
          });
          logInfo(`✅ Token automatic synchronization scheduler started (${tokenSyncConfig.on_startup ? 'syncing immediately' : 'waiting for the first interval'})`);
        }
      } else {
        logWarning('⚠️ Token automatic synchronization is disabled (TOKEN_SYNC_ENABLED=false)');
        logInfo('💡 Token-usage-based selection algorithms, such as least-token-used, will fall back to basic round-robin selection');
      }

      if (shuttingDown) return;
      // Background model calls spend quota; require an explicit operator opt-in.
      if (process.env.AUTOMATIC_KEY_TESTS === 'true') {
        // 🔓 Start scheduled automatic unban checks
        const AUTO_UNBAN_CHECK_INTERVAL = 60 * 60 * 1000; // Check every hour
        scheduleInterval(async () => {
          try {
            logDebug('🔓 Running automatic unban check...');
            const unbannedCount = await keyPoolManager.checkAutoUnban();
            if (unbannedCount > 0) {
              logInfo(`🔓 Automatic unban check completed: ${unbannedCount} keys unbanned`);
            }
          } catch (error) {
            logError('Automatic unban check failed', error);
          }
        }, AUTO_UNBAN_CHECK_INTERVAL);
      
        // Run a check at startup
        scheduleTimeout(async () => {
          try {
            logDebug('🔓 Running automatic unban check at startup...');
            const unbannedCount = await keyPoolManager.checkAutoUnban();
            if (unbannedCount > 0) {
              logInfo(`🔓 Startup automatic unban: ${unbannedCount} keys unbanned`);
            }
          } catch (error) {
            logError('Startup automatic unban check failed', error);
          }
        }, 5000); // Run 5 seconds after startup

        logInfo('🔓 Automatic unban checks started (once per hour)');

        const isAutoTestLeader = !CLUSTER_MODE || (cluster.isWorker && cluster.worker?.id === 1);
        if (isAutoTestLeader) {
          // 🧪 Automatically test enabled keys every hour so keys returning HTTP 402 are promptly banned
          const HOURLY_KEY_TEST_INTERVAL = 60 * 60 * 1000; // 1 hour
          let hourlyKeyTestRunning = false;

          const runHourlyKeyTest = async (trigger = 'scheduled') => {
            if (hourlyKeyTestRunning) {
              logWarning(`🧪 Automatic key testing is still running; skipping this trigger (${trigger})`);
              return;
            }

            hourlyKeyTestRunning = true;
            const startedAt = Date.now();
            logInfo(`🧪 Automatic key testing started (trigger: ${trigger}, enabled keys only)...`);

            try {
              const results = await keyPoolManager.testAllKeys(null, null, {
                includeDisabled: false,
                sourceLabel: `${trigger}-auto`
              });

              const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
              logInfo(`🧪 Automatic key testing finished: total ${results.total}, succeeded ${results.success}, failed ${results.failed}, banned ${results.banned}, elapsed ${elapsed}s`);
            } catch (error) {
              logError('Automatic key testing failed', error);
            } finally {
              hourlyKeyTestRunning = false;
            }
          };

          scheduleInterval(() => runHourlyKeyTest('hourly'), HOURLY_KEY_TEST_INTERVAL);
          scheduleTimeout(() => runHourlyKeyTest('startup'), 15_000);
          logInfo('🧪 Automatic key test scheduler started (hourly, enabled keys only)');
        } else {
          logInfo('🧪 Automatic key test scheduler runs only in the single process or first worker; skipping this process');
        }

      } else {
        logInfo('Automatic model-based key tests are disabled; quota refresh and request failover remain active');
      }

      const PORT = getPort();

      if (!CLUSTER_MODE) {
        logInfo(`Starting server on port ${PORT}...`);
      }

      server = app.listen(PORT)
        .on('listening', () => {
          if (CLUSTER_MODE) {
            logInfo(`Worker ${process.pid} listening on port ${PORT}`);
          } else {
            logInfo(`Server running on http://localhost:${PORT}`);
            logInfo('Available endpoints:');
            logInfo('  GET  /v1/models');
            logInfo('  POST /v1/chat/completions');
            logInfo('  POST /v1/responses');
            logInfo('  POST /v1/messages');
            logInfo('  POST /v1/messages/count_tokens');
            logInfo('  GET  /admin/* (Key Pool Management)');
          }
        })
        .on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            console.error(`\n${'='.repeat(80)}`);
            console.error(`ERROR: Port ${PORT} is already in use!`);
            console.error('');
            console.error('Please choose one of the following options:');
            console.error(`  1. Stop the process using port ${PORT}:`);
            console.error(`     lsof -ti:${PORT} | xargs kill`);
            console.error('');
            console.error('  2. Change the port in data/config.json:');
            console.error('     Edit data/config.json and modify the "port" field');
            console.error(`${'='.repeat(80)}\n`);
            process.exit(1);
          } else {
            logError('Failed to start server', err);
            process.exit(1);
          }
        });


    } catch (error) {
      logError('Failed to start server', error);
      process.exit(1);
    }
  })();
}
