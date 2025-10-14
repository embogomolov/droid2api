/**
 * 🚀 droid2api 服务器入口
 *
 * 智能启动模式：
 * - 默认：单进程模式（快速启动）
 * - 集群：设置 CLUSTER_MODE=true 启用多进程（高并发）
 *
 * 环境变量配置：
 * - CLUSTER_MODE=true     // 启用集群模式
 * - CLUSTER_WORKERS=4     // Worker进程数（默认=CPU核心数）
 */

import 'dotenv/config';
import cluster from 'cluster';
import os from 'os';

// BaSui：🎯 智能启动模式检测
const CLUSTER_MODE = process.env.CLUSTER_MODE === 'true';
const CLUSTER_WORKERS = parseInt(process.env.CLUSTER_WORKERS || os.cpus().length);

// ========== 集群模式（主进程） ==========
if (CLUSTER_MODE && cluster.isPrimary) {
  const { logInfo, logError } = await import('./logger.js');
  const redisCache = (await import('./utils/redis-cache.js')).default;

  logInfo(`🚀 集群模式启动中...`);
  logInfo(`📊 CPU核心数: ${os.cpus().length}`);
  logInfo(`👷 Worker进程数: ${CLUSTER_WORKERS}`);

  // 连接 Redis（如果配置了）
  if (process.env.REDIS_HOST) {
    try {
      await redisCache.connect();
    } catch (err) {
      logError('Redis连接失败，缓存功能已禁用', err);
    }
  }

  // 创建 Worker 进程
  const workers = new Map();

  for (let i = 0; i < CLUSTER_WORKERS; i++) {
    const worker = cluster.fork();
    workers.set(worker.id, {
      worker,
      restarts: 0,
      lastRestart: Date.now()
    });

    logInfo(`✅ Worker ${worker.process.pid} 已启动 (${i + 1}/${CLUSTER_WORKERS})`);
  }

  // Worker 进程退出时自动重启
  cluster.on('exit', (worker, code, signal) => {
    const workerInfo = workers.get(worker.id);

    if (signal) {
      logError(`Worker ${worker.process.pid} 被信号 ${signal} 终止`);
    } else if (code !== 0) {
      logError(`Worker ${worker.process.pid} 退出，退出码: ${code}`);
    } else {
      logInfo(`Worker ${worker.process.pid} 正常退出`);
    }

    // 检查重启频率（防止无限重启）
    const now = Date.now();
    if (workerInfo && now - workerInfo.lastRestart < 60000) {
      workerInfo.restarts++;
    } else if (workerInfo) {
      workerInfo.restarts = 0;
    }

    if (workerInfo && workerInfo.restarts > 5) {
      logError(`Worker ${worker.process.pid} 在1分钟内重启超过5次，停止自动重启`);
      workers.delete(worker.id);
      return;
    }

    // 重启 worker
    logInfo(`🔄 正在重启 Worker...`);
    const newWorker = cluster.fork();

    workers.set(newWorker.id, {
      worker: newWorker,
      restarts: workerInfo ? workerInfo.restarts : 0,
      lastRestart: now
    });

    if (workerInfo) {
      workers.delete(worker.id);
    }

    logInfo(`✅ Worker ${newWorker.process.pid} 已启动 (重启)`);
  });

  // 优雅退出处理
  const shutdown = async (signal) => {
    logInfo(`\n收到 ${signal} 信号，正在优雅关闭...`);

    // 停止接受新连接
    for (const { worker } of workers.values()) {
      worker.send('shutdown');
    }

    // 等待所有 worker 退出
    const shutdownTimeout = setTimeout(() => {
      logError('⚠️ 优雅关闭超时，强制退出');
      process.exit(1);
    }, 30000); // 30秒超时

    try {
      // 关闭 Redis 连接
      if (process.env.REDIS_HOST) {
        await redisCache.disconnect();
      }

      logInfo('✅ 所有连接已关闭');
      clearTimeout(shutdownTimeout);
      process.exit(0);
    } catch (error) {
      logError('关闭连接时出错', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 零停机重载（USR2 信号）
  process.on('SIGUSR2', () => {
    logInfo('🔄 收到重载信号，开始零停机重载...');

    const workersArray = Array.from(workers.values());
    let reloadedCount = 0;

    // 逐个重启 worker（保证始终有进程在服务）
    const reloadNext = () => {
      if (reloadedCount >= workersArray.length) {
        logInfo('✅ 所有 Worker 已重载完成');
        return;
      }

      const { worker } = workersArray[reloadedCount];
      reloadedCount++;

      // 发送重载信号
      worker.send('shutdown');

      // 等待 worker 退出后自动重启（由 exit 事件处理）
      setTimeout(reloadNext, 2000); // 2秒后重载下一个
    };

    reloadNext();
  });

  logInfo(`✅ 集群启动完成！所有 ${CLUSTER_WORKERS} 个 Worker 正在运行`);
  logInfo(`💡 提示：`);
  logInfo(`   - 发送 SIGUSR2 信号进行零停机重载: kill -USR2 ${process.pid}`);
  logInfo(`   - 发送 SIGTERM 信号优雅退出: kill -TERM ${process.pid}`);

} else {
  // ========== 单进程模式 或 Worker 进程 ==========

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
  const redisCache = (await import('./utils/redis-cache.js')).default;
  const { startDailyResetScheduler, onDateChange } = await import('./utils/daily-reset-scheduler.js');
  const { startTokenSyncScheduler } = await import('./utils/token-sync-scheduler.js');

  const app = express.default();

  app.use(express.default.json({ limit: '50mb' }));
  app.use(express.default.urlencoded({ extended: true, limit: '50mb' }));

  // BaSui：覆盖res.json方法，强制所有JSON响应使用UTF-8编码，不然中文显示成SB乱码
  app.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return originalJson(data);
    };
    next();
  });

  // API访问控制中间件
  function apiKeyAuth(req, res, next) {
    // BaSui：跳过管理API、根路径和所有静态文件（通过扩展名匹配）
    // 管理API和根路径
    if (req.path === '/' || req.path.startsWith('/admin') || req.path.startsWith('/factory')) {
      return next();
    }

    // 静态文件（通过扩展名匹配，避免硬编码每个文件名）
    const staticFileExtensions = ['.html', '.css', '.js', '.ico', '.png', '.jpg', '.svg', '.woff', '.woff2', '.ttf'];
    if (staticFileExtensions.some(ext => req.path.endsWith(ext))) {
      return next();
    }

    const clientApiKey = req.headers['x-api-key'] || req.headers['authorization'];
    const validApiKey = process.env.API_ACCESS_KEY;

    // 如果未配置访问密钥,跳过验证
    if (!validApiKey || validApiKey === 'your-secure-access-key-here') {
      return next();
    }

    // 验证密钥格式: Bearer xxx 或直接 xxx
    const cleanClientKey = clientApiKey?.replace('Bearer ', '').trim();
    const cleanValidKey = validApiKey.trim();

    if (!cleanClientKey || cleanClientKey !== cleanValidKey) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing API access key'
      });
    }

    next();
  }

  // BaSui: 静态文件服务必须在API认证中间件之前，避免认证拦截
  app.use(express.default.static('public'));

  // 应用API访问控制
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

  // BaSui: 日志收集中间件（必须在路由之前注册）
  app.use(logCollectorMiddleware);

  // BaSui: 请求统计追踪中间件（必须在路由之前注册）
  app.use(statsTrackerMiddleware);

  app.use(router);

  // Factory Token使用量管理API路由
  app.use('/admin/token', tokenUsageRouter);

  // Token统计API路由（新的准确统计）
  const tokenStatsRouter = (await import('./api/token-stats-routes.js')).default;
  app.use('/admin/token-stats', tokenStatsRouter);

  // BaSui: 请求统计API路由
  app.use('/admin/stats', statsRouter);

  // BaSui: 实时日志流API路由
  app.use('/admin', logStreamRouter);

  // BaSui: 关键词过滤管理API路由
  app.use('/admin/keyword-filter', keywordFilterRouter);

  // 管理API路由
  app.use('/admin', adminRouter);

  // BaSui: 静态文件服务已在认证中间件之前注册（见第239行），此行已删除避免重复

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

  // 处理favicon.ico请求，避免404日志刷屏（这个SB浏览器总是自动请求）
  app.get('/favicon.ico', (req, res) => {
    res.status(204).end(); // 204 No Content，不返回任何内容
  });

  // 404 处理 - 捕获所有未匹配的路由（排除 admin 路径，让 admin 路由自己处理）
  app.use((req, res, next) => {
    // BaSui: 跳过 /admin 路径，这些路由有自己的错误处理
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
    console.error('❌ 非法请求地址');
    console.error('='.repeat(80));
    console.error(`时间: ${errorInfo.timestamp}`);
    console.error(`方法: ${errorInfo.method}`);
    console.error(`地址: ${errorInfo.url}`);
    console.error(`路径: ${errorInfo.path}`);

    if (Object.keys(errorInfo.query).length > 0) {
      console.error(`查询参数: ${JSON.stringify(errorInfo.query, null, 2)}`);
    }

    if (errorInfo.body && Object.keys(errorInfo.body).length > 0) {
      console.error(`请求体: ${JSON.stringify(errorInfo.body, null, 2)}`);
    }

    console.error(`客户端IP: ${errorInfo.ip}`);
    console.error(`User-Agent: ${errorInfo.headers['user-agent'] || 'N/A'}`);

    if (errorInfo.headers.referer) {
      console.error(`来源: ${errorInfo.headers.referer}`);
    }

    console.error('='.repeat(80) + '\n');

    logError('Invalid request path', errorInfo);

    res.status(404).json({
      error: 'Not Found',
      message: `路径 ${req.method} ${req.path} 不存在`,
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

  // 错误处理中间件
  app.use((err, req, res, next) => {
    logError('Unhandled error', err);
    res.status(500).json({
      error: 'Internal server error',
      message: isDevMode() ? err.message : undefined
    });
  });

  // 启动服务器
  (async () => {
    try {
      loadConfig();
      logInfo('Configuration loaded successfully');
      logInfo(`Dev mode: ${isDevMode()}`);

      if (CLUSTER_MODE) {
        logInfo(`Cluster mode: Worker ${process.pid}`);
      }

      // 连接 Redis（Worker 进程或单进程模式）
      if (!CLUSTER_MODE && process.env.REDIS_HOST) {
        try {
          await redisCache.connect();
        } catch (err) {
          // Redis连接失败不影响系统启动
        }
      }

      // Initialize auth system (load and setup API key if needed)
      // This won't throw error if no auth config is found - will use client auth
      await initializeAuth();

      // BaSui：启动每日重置调度器，确保日期切换时自动清理
      startDailyResetScheduler(60000); // 每1分钟检查一次日期变化

      // BaSui：注册日期切换回调（当日期切换时触发）
      onDateChange(() => {
        logInfo('🌅 日期已切换！"今日请求"统计已自动重置为0');
        logInfo('   注意：total_requests 保持累计值，today_requests 已清零');
      });

      // BaSui：启动 Token 自动同步调度器（从配置读取）
      const tokenSyncConfig = getTokenSyncConfig();
      
      if (tokenSyncConfig.enabled) {
        logInfo(`🔄 启动 Token 自动同步调度器（间隔: ${tokenSyncConfig.interval_minutes} 分钟）...`);
        
        const intervalMs = tokenSyncConfig.interval_minutes * 60 * 1000;
        const timeoutMs = tokenSyncConfig.startup_timeout_seconds * 1000;
        
        if (tokenSyncConfig.on_startup && timeoutMs > 0) {
          // 启动时等待首次同步完成
          const syncResult = await new Promise((resolve) => {
            // 启动调度器（立即执行一次同步）
            startTokenSyncScheduler({
              intervalMs: intervalMs,
              immediate: true
            });
            
            // 等待首次同步完成
            const checkInterval = setInterval(async () => {
              const { default: tokenSyncScheduler } = await import('./utils/token-sync-scheduler.js');
              const status = tokenSyncScheduler.getSyncStatus();
              
              if (!status.inProgress && status.lastSyncTime) {
                clearInterval(checkInterval);
                resolve(status);
              }
            }, 500);
            
            // 超时处理
            setTimeout(() => {
              clearInterval(checkInterval);
              resolve({ timeout: true });
            }, timeoutMs);
          });
          
          if (syncResult.timeout) {
            logWarning(`⚠️ Token 首次同步超时（${tokenSyncConfig.startup_timeout_seconds}秒），服务器继续启动（后台同步将继续进行）`);
          } else {
            logInfo(`✅ Token 自动同步调度器已启动并完成首次同步`);
          }
        } else {
          // 不等待，直接启动
          startTokenSyncScheduler({
            intervalMs: intervalMs,
            immediate: tokenSyncConfig.on_startup
          });
          logInfo(`✅ Token 自动同步调度器已启动（${tokenSyncConfig.on_startup ? '立即同步' : '等待第一个周期'}）`);
        }
      } else {
        logWarning('⚠️ Token 自动同步已禁用（TOKEN_SYNC_ENABLED=false）');
        logInfo('💡 依赖 Token 使用量的轮询算法（如 least-token-used）将降级为简单轮询');
      }

      // 🔓 启动自动解封检查定时任务
      const AUTO_UNBAN_CHECK_INTERVAL = 60 * 60 * 1000; // 每小时检查一次
      setInterval(async () => {
        try {
          logDebug('🔓 执行自动解封检查...');
          const unbannedCount = await keyPoolManager.checkAutoUnban();
          if (unbannedCount > 0) {
            logInfo(`🔓 自动解封检查完成: ${unbannedCount} 个密钥已解封`);
          }
        } catch (error) {
          logError('自动解封检查失败', error);
        }
      }, AUTO_UNBAN_CHECK_INTERVAL);
      
      // 启动时立即执行一次检查
      setTimeout(async () => {
        try {
          logDebug('🔓 启动时执行自动解封检查...');
          const unbannedCount = await keyPoolManager.checkAutoUnban();
          if (unbannedCount > 0) {
            logInfo(`🔓 启动时自动解封: ${unbannedCount} 个密钥已解封`);
          }
        } catch (error) {
          logError('启动时自动解封检查失败', error);
        }
      }, 5000); // 启动5秒后执行
      
      logInfo('🔓 自动解封检查已启动（每小时检查一次）');

      const isAutoTestLeader = !CLUSTER_MODE || (cluster.isWorker && cluster.worker?.id === 1);
      if (isAutoTestLeader) {
        // 🧪 每小时自动测试启用密钥，确保402及时被拉黑
        const HOURLY_KEY_TEST_INTERVAL = 60 * 60 * 1000; // 1小时
        let hourlyKeyTestRunning = false;

        const runHourlyKeyTest = async (trigger = 'scheduled') => {
          if (hourlyKeyTestRunning) {
            logWarning(`🧪 自动密钥测试仍在执行，跳过本次触发（${trigger}）`);
            return;
          }

          hourlyKeyTestRunning = true;
          const startedAt = Date.now();
          logInfo(`🧪 自动密钥测试启动（触发：${trigger}，仅测试启用密钥）...`);

          try {
            const results = await keyPoolManager.testAllKeys(null, null, {
              includeDisabled: false,
              sourceLabel: `${trigger}-auto`
            });

            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
            logInfo(`🧪 自动密钥测试完成：总计 ${results.total}，成功 ${results.success}，失败 ${results.failed}，封禁 ${results.banned}，耗时 ${elapsed}s`);
          } catch (error) {
            logError('自动密钥测试失败', error);
          } finally {
            hourlyKeyTestRunning = false;
          }
        };

        setInterval(() => runHourlyKeyTest('hourly'), HOURLY_KEY_TEST_INTERVAL);
        setTimeout(() => runHourlyKeyTest('startup'), 15_000);
        logInfo('🧪 自动密钥测试调度器已启动（每小时执行一次，仅启用密钥）');
      } else {
        logInfo('🧪 自动密钥测试调度器仅在主进程/首个 Worker 执行，当前进程跳过');
      }

      const PORT = getPort();

      if (!CLUSTER_MODE) {
        logInfo(`Starting server on port ${PORT}...`);
      }

      const server = app.listen(PORT)
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

      // 监听主进程的关闭信号（集群模式）
      if (CLUSTER_MODE) {
        process.on('message', (msg) => {
          if (msg === 'shutdown') {
            logInfo(`Worker ${process.pid} 收到关闭信号，正在优雅关闭...`);

            // 停止接受新连接
            server.close(() => {
              logInfo(`Worker ${process.pid} 关闭完成`);
              process.exit(0);
            });

            // 强制退出超时
            setTimeout(() => {
              logError(`Worker ${process.pid} 关闭超时，强制退出`);
              process.exit(1);
            }, 5000); // 5秒超时
          }
        });
      }

    } catch (error) {
      logError('Failed to start server', error);
      process.exit(1);
    }
  })();
}
