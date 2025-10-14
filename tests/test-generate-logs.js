/**
 * 日志生成测试脚本
 * 用于生成不同级别的测试日志，验证日志查看功能
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 日志目录
const LOG_DIR = path.join(__dirname, '..', 'logs');

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    console.log(`创建日志目录: ${LOG_DIR}`);
}

// 获取当前日期
const today = new Date().toISOString().split('T')[0];
const logFileName = `droid2api_${today}.log`;
const logFilePath = path.join(LOG_DIR, logFileName);

// 日志模板
const logTemplates = [
    { level: 'INFO', messages: [
        '服务器启动成功，监听端口 3000',
        '数据库连接成功',
        '配置文件加载完成',
        '密钥池初始化成功，当前可用密钥: 150',
        'API 路由注册完成',
        '缓存系统初始化成功'
    ]},
    { level: 'SUCCESS', messages: [
        '密钥测试成功: fk-abc123xxx',
        '用户认证成功',
        'API 请求处理成功，耗时 123ms',
        '批量导入密钥成功，新增 50 个密钥',
        'Token 使用量同步成功',
        '余额查询成功，剩余 Token: 1234567'
    ]},
    { level: 'WARNING', messages: [
        '密钥池剩余可用密钥不足 10 个',
        '请求速率接近限制',
        'API 响应时间超过 1000ms',
        '内存使用率超过 80%',
        '日志文件大小超过 10MB',
        '密钥 fk-xyz789 连续失败 3 次'
    ]},
    { level: 'ERROR', messages: [
        '密钥验证失败: 401 Unauthorized',
        '数据库连接失败: Connection timeout',
        '文件读取失败: ENOENT no such file',
        'API 请求失败: 500 Internal Server Error',
        '密钥池为空，无法处理请求',
        'JSON 解析失败: Unexpected token'
    ]}
];

// 生成时间戳
function getTimestamp(offsetMinutes = 0) {
    const date = new Date();
    date.setMinutes(date.getMinutes() - offsetMinutes);
    return date.toISOString();
}

// 生成日志条目
function generateLogEntry(level, message, timestamp) {
    return `[${timestamp}] [${level}] ${message}\n`;
}

// 生成多行日志（模拟堆栈追踪）
function generateMultilineLog(level, message, timestamp) {
    let log = `[${timestamp}] [${level}] ${message}\n`;
    if (level === 'ERROR') {
        log += '  at Function.processRequest (routes.js:123)\n';
        log += '  at handleRequest (server.js:456)\n';
        log += '  at Layer.handle [as handle_request] (express/lib/router/layer.js:95)\n';
    }
    return log;
}

// 生成测试日志
function generateTestLogs() {
    console.log(`生成测试日志到: ${logFilePath}`);

    let logContent = '';
    let totalLogs = 0;

    // 生成过去 2 小时的日志
    for (let i = 120; i >= 0; i -= 5) {
        // 随机选择日志级别和消息
        const template = logTemplates[Math.floor(Math.random() * logTemplates.length)];
        const message = template.messages[Math.floor(Math.random() * template.messages.length)];
        const timestamp = getTimestamp(i);

        // 10% 概率生成多行日志（错误堆栈）
        if (Math.random() < 0.1 && template.level === 'ERROR') {
            logContent += generateMultilineLog(template.level, message, timestamp);
        } else {
            logContent += generateLogEntry(template.level, message, timestamp);
        }

        totalLogs++;
    }

    // 生成一些额外的特定场景日志
    const scenarios = [
        { level: 'INFO', message: 'GET /v1/chat/completions - 开始处理请求' },
        { level: 'INFO', message: '使用密钥: fk-abc...xyz (ID: key_1234567890)' },
        { level: 'SUCCESS', message: 'API 调用成功，使用 Token: 1523' },
        { level: 'INFO', message: 'POST /admin/keys - 添加新密钥' },
        { level: 'WARNING', message: '密钥 fk-test123 即将过期（剩余 3 天）' },
        { level: 'ERROR', message: '402 Payment Required - 密钥余额不足' },
        { level: 'INFO', message: '自动封禁密钥: fk-expired001' },
        { level: 'SUCCESS', message: '批量测试完成: 成功 120, 失败 5, 封禁 2' }
    ];

    scenarios.forEach((scenario, index) => {
        const timestamp = getTimestamp(-index);
        logContent += generateLogEntry(scenario.level, scenario.message, timestamp);
        totalLogs++;
    });

    // 写入日志文件
    fs.writeFileSync(logFilePath, logContent, 'utf-8');
    console.log(`✅ 成功生成 ${totalLogs} 条测试日志`);

    // 生成昨天的日志文件（测试日期选择功能）
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    const yesterdayLogFile = path.join(LOG_DIR, `droid2api_${yesterdayStr}.log`);

    let yesterdayContent = '';
    for (let i = 0; i < 50; i++) {
        const template = logTemplates[Math.floor(Math.random() * logTemplates.length)];
        const message = template.messages[Math.floor(Math.random() * template.messages.length)];
        const timestamp = new Date(yesterday.getTime() - i * 60000).toISOString();
        yesterdayContent += generateLogEntry(template.level, message, timestamp);
    }

    fs.writeFileSync(yesterdayLogFile, yesterdayContent, 'utf-8');
    console.log(`✅ 成功生成昨天的测试日志文件: ${yesterdayLogFile}`);

    // 统计日志级别分布
    console.log('\n日志级别分布:');
    logTemplates.forEach(template => {
        const count = (logContent.match(new RegExp(`\\[${template.level}\\]`, 'g')) || []).length;
        console.log(`  ${template.level}: ${count} 条`);
    });

    console.log('\n测试提示:');
    console.log('1. 启动服务器: npm start');
    console.log('2. 访问管理界面: http://localhost:3000');
    console.log('3. 使用管理员密钥登录');
    console.log('4. 点击 "日志查看" Tab');
    console.log('5. 测试筛选、搜索、分页等功能');
}

// 执行生成
generateTestLogs();

// 监听模式（可选）
if (process.argv[2] === '--watch') {
    console.log('\n进入监听模式，每 10 秒生成新日志...');
    setInterval(() => {
        const timestamp = getTimestamp(0);
        const template = logTemplates[Math.floor(Math.random() * logTemplates.length)];
        const message = template.messages[Math.floor(Math.random() * template.messages.length)];
        const logEntry = generateLogEntry(template.level, message + ' (实时)', timestamp);

        fs.appendFileSync(logFilePath, logEntry, 'utf-8');
        console.log(`新日志: [${template.level}] ${message}`);
    }, 10000);
}