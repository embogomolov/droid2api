/**
 * Daily reset scheduler
 * Check for date changes and trigger statistics cleanup after midnight.
 *
 * BaSui: Ensure "Requests today" resets correctly when the date changes.
 * Works even when the server runs continuously without restarting. 😎
 */

import { logInfo, logDebug } from '../logger.js';

let lastCheckedDate = null;
let checkInterval = null;

/**
 * Get the current date as YYYY-MM-DD.
 * BaSui: Use local time rather than UTC so the date changes at local midnight.
 */
function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Check whether the date has changed.
 * @returns {boolean} True if the date has changed
 */
function checkDateChange() {
  const currentDate = getTodayKey();

  if (lastCheckedDate === null) {
    // Initialize on the first check.
    lastCheckedDate = currentDate;
    logDebug(`📅 Daily reset scheduler initialized: ${currentDate}`);
    return false;
  }

  if (currentDate !== lastCheckedDate) {
    // The date has changed.
    logInfo(`🌅 Date change detected: ${lastCheckedDate} → ${currentDate}`);
    lastCheckedDate = currentDate;
    return true;
  }

  return false;
}

/**
 * Callbacks to run when the date changes
 */
const onDateChangeCallbacks = [];

/**
 * Register a date-change callback
 * @param {Function} callback - Callback function
 */
export function onDateChange(callback) {
  if (typeof callback === 'function') {
    onDateChangeCallbacks.push(callback);
    logDebug(`✅ Registered date-change callback: ${callback.name || 'anonymous'}`);
  }
}

/**
 * Run all date-change callbacks.
 */
function triggerDateChangeCallbacks() {
  logInfo(`🔔 Running ${onDateChangeCallbacks.length} date-change callbacks`);

  onDateChangeCallbacks.forEach((callback, index) => {
    try {
      callback();
      logDebug(`  ✅ Callback #${index + 1} completed successfully`);
    } catch (error) {
      logInfo(`  ❌ Callback #${index + 1} failed: ${error.message}`);
    }
  });
}

/**
 * Start the daily reset scheduler.
 * @param {number} checkIntervalMs - Check interval in milliseconds; defaults to 1 minute
 */
export function startDailyResetScheduler(checkIntervalMs = 60000) {
  if (checkInterval) {
    logDebug('⚠️  Daily reset scheduler is already running; skipping startup');
    return;
  }

  // Initialize the current date.
  lastCheckedDate = getTodayKey();
  logInfo(`🚀 Daily reset scheduler started (check interval: ${checkIntervalMs / 1000} seconds)`);
  logInfo(`📅 Current date: ${lastCheckedDate}`);

  // Check periodically for a date change.
  checkInterval = setInterval(() => {
    const dateChanged = checkDateChange();

    if (dateChanged) {
      // The date changed; run all callbacks.
      triggerDateChangeCallbacks();
    }
  }, checkIntervalMs);

  // Ensure the timer is cleared on process exit.
  process.on('exit', () => {
    stopDailyResetScheduler();
  });
}

/**
 * Stop the daily reset scheduler.
 */
export function stopDailyResetScheduler() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    logInfo('🛑 Daily reset scheduler stopped');
  }
}

/**
 * Get the scheduler status.
 * @returns {Object} Scheduler status information
 */
export function getSchedulerStatus() {
  return {
    isRunning: checkInterval !== null,
    lastCheckedDate,
    currentDate: getTodayKey(),
    registeredCallbacks: onDateChangeCallbacks.length
  };
}

export default {
  startDailyResetScheduler,
  stopDailyResetScheduler,
  onDateChange,
  getSchedulerStatus
};
