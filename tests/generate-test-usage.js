/**
 * 生成测试用的Token使用量数据
 * 用于测试可视化界面
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 创建data目录（在项目根目录）
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log('✅ 创建data目录');
}

// 生成模拟的使用量数据
const generateUsageData = () => {
    const usage = {};
    const keys = [
        'fk-1234567890abcdef',
        'fk-abcdefghijk1234',
        'fk-xyz9876543210',
        'fk-test123456789',
        'fk-prod987654321'
    ];

    const today = new Date();
    const dates = [];

    // 生成最近7天的日期
    for (let i = 6; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        dates.push(date.toISOString().split('T')[0]);
    }

    // 为每个密钥生成使用数据
    keys.forEach((key, index) => {
        const maskedKey = `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
        usage[maskedKey] = {
            total_tokens: Math.floor(Math.random() * 1000000) + 50000,
            total_requests: Math.floor(Math.random() * 1000) + 100,
            daily: {},
            hourly: {},
            last_updated: new Date().toISOString()
        };

        // 生成每日数据
        dates.forEach(date => {
            usage[maskedKey].daily[date] = {
                tokens: Math.floor(Math.random() * 100000) + 5000,
                requests: Math.floor(Math.random() * 100) + 10
            };
        });

        // 生成今天的小时数据
        const todayDate = dates[dates.length - 1];
        for (let hour = 0; hour <= new Date().getHours(); hour++) {
            const hourKey = `${todayDate}T${hour.toString().padStart(2, '0')}:00`;
            usage[maskedKey].hourly[hourKey] = {
                tokens: Math.floor(Math.random() * 10000) + 1000,
                requests: Math.floor(Math.random() * 20) + 1
            };
        }
    });

    return usage;
};

// 生成余额数据（可选）
const generateBalanceData = () => {
    const balances = {};
    const keys = [
        'fk-1234567890abcdef',
        'fk-abcdefghijk1234',
        'fk-xyz9876543210',
        'fk-test123456789',
        'fk-prod987654321'
    ];

    keys.forEach(key => {
        balances[key] = {
            credits: Math.floor(Math.random() * 100) + 10,
            subscription_tokens: Math.floor(Math.random() * 10000000) + 1000000,
            subscription_requests: Math.floor(Math.random() * 100000) + 10000,
            cached_at: new Date().toISOString()
        };
    });

    return balances;
};

// 保存使用量数据
const usageFile = path.join(dataDir, 'factory_usage.json');
const usageData = {
    usage: generateUsageData(),
    timestamp: new Date().toISOString()
};
fs.writeFileSync(usageFile, JSON.stringify(usageData, null, 2));
console.log('✅ 生成测试使用量数据:', usageFile);

// 保存余额数据
const balanceFile = path.join(dataDir, 'factory_balance.json');
const balanceData = {
    balances: generateBalanceData(),
    last_sync: new Date().toISOString()
};
fs.writeFileSync(balanceFile, JSON.stringify(balanceData, null, 2));
console.log('✅ 生成测试余额数据:', balanceFile);

// 显示生成的数据统计
const stats = Object.values(usageData.usage).reduce((acc, curr) => {
    acc.totalTokens += curr.total_tokens;
    acc.totalRequests += curr.total_requests;
    return acc;
}, { totalTokens: 0, totalRequests: 0 });

console.log('\n📊 生成的测试数据统计:');
console.log(`  - 密钥数量: ${Object.keys(usageData.usage).length}`);
console.log(`  - 总Token使用量: ${stats.totalTokens.toLocaleString()}`);
console.log(`  - 总请求次数: ${stats.totalRequests.toLocaleString()}`);
console.log('\n🎉 测试数据生成完成！重启服务器后即可在前端看到可视化效果。');