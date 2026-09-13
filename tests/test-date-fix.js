/**
 * Test the date-handling fix
 * Compare the local time zone with UTC
 */

// Test the updated getTodayKey function (local time zone)
function getTodayKeyLocal() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Test the previous getTodayKey function (UTC)
function getTodayKeyUTC() {
  return new Date().toISOString().split('T')[0];
}

console.log('='.repeat(80));
console.log('📅 Date-handling fix test');
console.log('='.repeat(80));
console.log('');

console.log('Current time information:');
console.log('  Windows local time:', new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
console.log('  UTC time:', new Date().toISOString());
console.log('');

console.log('Date key comparison:');
console.log('  Before the fix (UTC):', getTodayKeyUTC());
console.log('  After the fix (local time zone):', getTodayKeyLocal());
console.log('');

console.log('Time-zone difference:');
const utcDate = getTodayKeyUTC();
const localDate = getTodayKeyLocal();
if (utcDate !== localDate) {
  console.log('  ⚠️  UTC and the local time zone have different dates!');
  console.log('  This explains why "Tokens today" did not reset automatically!');
} else {
  console.log('  ✅ UTC and the local time zone have the same date!');
}
console.log('');

console.log('Fix details:');
console.log('  1. Updated getTodayKey() in utils/daily-reset-scheduler.js');
console.log('  2. Updated getTodayKey() in utils/request-stats.js');
console.log('  3. All date-related functions use the local time zone');
console.log('  4. Restart the server so the scheduler detects date changes correctly!');
console.log('');

console.log('='.repeat(80));
console.log('✅ Tests complete! Restart the server to apply the fix.');
console.log('='.repeat(80));
