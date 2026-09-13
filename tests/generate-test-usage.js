/**
 * Generate sample token usage data
 * Used to test the visualization interface
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create the data directory at the project root
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log('✅ Created data directory');
}

// Generate simulated usage data
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

    // Generate dates for the last 7 days
    for (let i = 6; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        dates.push(date.toISOString().split('T')[0]);
    }

    // Generate usage data for each key
    keys.forEach((key, index) => {
        const maskedKey = `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
        usage[maskedKey] = {
            total_tokens: Math.floor(Math.random() * 1000000) + 50000,
            total_requests: Math.floor(Math.random() * 1000) + 100,
            daily: {},
            hourly: {},
            last_updated: new Date().toISOString()
        };

        // Generate daily data
        dates.forEach(date => {
            usage[maskedKey].daily[date] = {
                tokens: Math.floor(Math.random() * 100000) + 5000,
                requests: Math.floor(Math.random() * 100) + 10
            };
        });

        // Generate hourly data for today
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

// Generate balance data (optional)
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

// Save usage data
const usageFile = path.join(dataDir, 'factory_usage.json');
const usageData = {
    usage: generateUsageData(),
    timestamp: new Date().toISOString()
};
fs.writeFileSync(usageFile, JSON.stringify(usageData, null, 2));
console.log('✅ Generated sample usage data:', usageFile);

// Save balance data
const balanceFile = path.join(dataDir, 'factory_balance.json');
const balanceData = {
    balances: generateBalanceData(),
    last_sync: new Date().toISOString()
};
fs.writeFileSync(balanceFile, JSON.stringify(balanceData, null, 2));
console.log('✅ Generated sample balance data:', balanceFile);

// Show statistics for the generated data
const stats = Object.values(usageData.usage).reduce((acc, curr) => {
    acc.totalTokens += curr.total_tokens;
    acc.totalRequests += curr.total_requests;
    return acc;
}, { totalTokens: 0, totalRequests: 0 });

console.log('\n📊 Generated test data statistics:');
console.log(`  - Number of keys: ${Object.keys(usageData.usage).length}`);
console.log(`  - Total token usage: ${stats.totalTokens.toLocaleString()}`);
console.log(`  - Total request count: ${stats.totalRequests.toLocaleString()}`);
console.log('\n🎉 Test data generated! Restart the server to see the visualizations in the UI.');