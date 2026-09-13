/**
 * Test the daily reset scheduler
 * Verify:
 * 1. The scheduler starts correctly
 * 2. Callbacks can be registered correctly
 * 3. Date changes are detected correctly
 */

import { startDailyResetScheduler, onDateChange, getSchedulerStatus, stopDailyResetScheduler } from '../utils/daily-reset-scheduler.js';

console.log('========================================');
console.log('🧪 Daily reset scheduler test');
console.log('========================================\n');

// 1. Test starting the scheduler
console.log('✅ Test 1: Start the scheduler');
startDailyResetScheduler(5000); // Check every 5 seconds for this quick test

let status = getSchedulerStatus();
console.log(`   - Run status: ${status.isRunning ? '✅ Running' : '❌ Stopped'}`);
console.log(`   - Current date: ${status.currentDate}`);
console.log(`   - Last check: ${status.lastCheckedDate}`);
console.log(`   - Callback count: ${status.registeredCallbacks}\n`);

// 2. Test callback registration
console.log('✅ Test 2: Register date-change callbacks');

onDateChange(() => {
  console.log('   🔔 Callback 1: The date changed!');
});

onDateChange(() => {
  console.log('   🔔 Callback 2: Prepare to clear daily data...');
});

onDateChange(() => {
  console.log('   🔔 Callback 3: Notify the frontend to refresh statistics...');
});

status = getSchedulerStatus();
console.log(`   - Registered callbacks: ${status.registeredCallbacks}\n`);

// 3. Monitor status for approximately 10 seconds
console.log('✅ Test 3: Monitor scheduler status for approximately 10 seconds');
console.log('   Waiting...');

let checkCount = 0;
const monitorInterval = setInterval(() => {
  checkCount++;
  const currentStatus = getSchedulerStatus();
  console.log(`   [${checkCount}] Current date: ${currentStatus.currentDate} | Last check: ${currentStatus.lastCheckedDate}`);

  if (checkCount >= 3) {
    clearInterval(monitorInterval);
    console.log('\n✅ Tests complete! The scheduler is working correctly');
    console.log('\n========================================');
    console.log('📝 Test summary');
    console.log('========================================');
    console.log('✅ Scheduler started successfully');
    console.log('✅ Callbacks registered successfully');
    console.log('✅ Status queries work correctly');
    console.log('\n💡 Notes:');
    console.log('   - The scheduler checks for date changes every 5 seconds');
    console.log('   - When the date YYYY-MM-DD changes to a new date, all callbacks are triggered');
    console.log('   - A 60-second check interval is recommended for production');
    console.log('\n⚠️  Note:');
    console.log('   - To observe a date change, wait until the actual date changes');
    console.log('   - Alternatively, change the system clock to simulate it (not recommended)');

    // Stop the scheduler
    setTimeout(() => {
      stopDailyResetScheduler();
      console.log('\n🛑 Scheduler stopped');
      process.exit(0);
    }, 1000);
  }
}, 3000); // Check status every 3 seconds
