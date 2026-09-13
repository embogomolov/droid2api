/**
 * Test log generator
 * Generate logs at different severity levels to verify the log viewer.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Log directory
const LOG_DIR = path.join(__dirname, '..', 'logs');

// Ensure the log directory exists.
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    console.log(`Created log directory: ${LOG_DIR}`);
}

// Get the current date
const today = new Date().toISOString().split('T')[0];
const logFileName = `droid2api_${today}.log`;
const logFilePath = path.join(LOG_DIR, logFileName);

// Log message templates
const logTemplates = [
    { level: 'INFO', messages: [
        'Server started successfully, listening on port 3000',
        'Connected to the database',
        'Configuration file loaded',
        'Key pool initialized: 150 keys available',
        'API routes registered',
        'Cache initialized successfully'
    ]},
    { level: 'SUCCESS', messages: [
        'Key test passed: fk-abc123xxx',
        'User authenticated successfully',
        'API request completed successfully in 123 ms',
        'Bulk import succeeded: 50 keys added',
        'Token usage synchronized successfully',
        'Balance query succeeded: 1234567 tokens remaining'
    ]},
    { level: 'WARNING', messages: [
        'Fewer than 10 keys remain available in the pool',
        'Request rate is approaching the limit',
        'API response time exceeded 1000 ms',
        'Memory usage exceeded 80%',
        'Log file size exceeded 10 MB',
        'Key fk-xyz789 failed 3 consecutive times'
    ]},
    { level: 'ERROR', messages: [
        'Key validation failed: 401 Unauthorized',
        'Database connection failed: Connection timeout',
        'File read failed: ENOENT no such file',
        'API request failed: 500 Internal Server Error',
        'Key pool is empty; cannot process the request',
        'JSON parsing failed: Unexpected token'
    ]}
];

// Generate a timestamp.
function getTimestamp(offsetMinutes = 0) {
    const date = new Date();
    date.setMinutes(date.getMinutes() - offsetMinutes);
    return date.toISOString();
}

// Generate a log entry.
function generateLogEntry(level, message, timestamp) {
    return `[${timestamp}] [${level}] ${message}\n`;
}

// Generate a multiline log entry with a simulated stack trace.
function generateMultilineLog(level, message, timestamp) {
    let log = `[${timestamp}] [${level}] ${message}\n`;
    if (level === 'ERROR') {
        log += '  at Function.processRequest (routes.js:123)\n';
        log += '  at handleRequest (server.js:456)\n';
        log += '  at Layer.handle [as handle_request] (express/lib/router/layer.js:95)\n';
    }
    return log;
}

// Generate test logs.
function generateTestLogs() {
    console.log(`Writing test logs to: ${logFilePath}`);

    let logContent = '';
    let totalLogs = 0;

    // Generate logs covering the last 2 hours.
    for (let i = 120; i >= 0; i -= 5) {
        // Select a random log level and message.
        const template = logTemplates[Math.floor(Math.random() * logTemplates.length)];
        const message = template.messages[Math.floor(Math.random() * template.messages.length)];
        const timestamp = getTimestamp(i);

        // Give error entries a 10% chance of including a multiline stack trace.
        if (Math.random() < 0.1 && template.level === 'ERROR') {
            logContent += generateMultilineLog(template.level, message, timestamp);
        } else {
            logContent += generateLogEntry(template.level, message, timestamp);
        }

        totalLogs++;
    }

    // Add log entries for specific scenarios.
    const scenarios = [
        { level: 'INFO', message: 'GET /v1/chat/completions - Processing request' },
        { level: 'INFO', message: 'Using key: fk-abc...xyz (ID: key_1234567890)' },
        { level: 'SUCCESS', message: 'API call succeeded: 1523 tokens used' },
        { level: 'INFO', message: 'POST /admin/keys - Adding a new key' },
        { level: 'WARNING', message: 'Key fk-test123 expires in 3 days' },
        { level: 'ERROR', message: '402 Payment Required - Insufficient credits for this key' },
        { level: 'INFO', message: 'Automatically disabled key: fk-expired001' },
        { level: 'SUCCESS', message: 'Batch test complete: 120 passed, 5 failed, 2 disabled' }
    ];

    scenarios.forEach((scenario, index) => {
        const timestamp = getTimestamp(-index);
        logContent += generateLogEntry(scenario.level, scenario.message, timestamp);
        totalLogs++;
    });

    // Write the log file.
    fs.writeFileSync(logFilePath, logContent, 'utf-8');
    console.log(`✅ Generated ${totalLogs} test log entries`);

    // Generate a log file for yesterday to test date selection.
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
    console.log(`✅ Created yesterday's test log file: ${yesterdayLogFile}`);

    // Count entries by log level.
    console.log('\nEntries by log level:');
    logTemplates.forEach(template => {
        const count = (logContent.match(new RegExp(`\\[${template.level}\\]`, 'g')) || []).length;
        console.log(`  ${template.level}: ${count} entries`);
    });

    console.log('\nTesting instructions:');
    console.log('1. Start the server: npm start');
    console.log('2. Open the admin interface: http://localhost:3000');
    console.log('3. Sign in with the admin access key');
    console.log('4. Open the "Logs" tab');
    console.log('5. Test filtering, search, pagination, and other log viewer features');
}

// Generate the logs.
generateTestLogs();

// Watch mode (optional)
if (process.argv[2] === '--watch') {
    console.log('\nEntering watch mode; a new log entry will be generated every 10 seconds...');
    setInterval(() => {
        const timestamp = getTimestamp(0);
        const template = logTemplates[Math.floor(Math.random() * logTemplates.length)];
        const message = template.messages[Math.floor(Math.random() * template.messages.length)];
        const logEntry = generateLogEntry(template.level, message + ' (live)', timestamp);

        fs.appendFileSync(logFilePath, logEntry, 'utf-8');
        console.log(`New log entry: [${template.level}] ${message}`);
    }, 10000);
}
