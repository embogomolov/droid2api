import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { logDebug, logError } from '../logger.js';

/**
 * Asynchronous batched file writer 🚀
 *
 * Core performance optimizations:
 * - Debounced writes: combine repeated writes under high concurrency.
 * - Asynchronous I/O: avoid blocking the main thread.
 * - Atomic replacement: write a temporary file, then rename it to protect data.
 * - Automatic backups: protect against data corruption.
 *
 * Use cases:
 * - Frequent key pool updates (usage counts change on every request).
 * - Persisting token statistics in real time.
 * - Request statistics logs.
 */

class AsyncFileWriter {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.debounceTime = options.debounceTime || 1000;  // Default debounce interval: 1 second
    this.maxRetries = options.maxRetries || 3;         // Maximum write attempts
    this.retryDelay = options.retryDelay || 500;       // Retry delay

    this.pendingData = null;      // Pending data
    this.writeTimer = null;       // Write timer
    this.isWriting = false;       // Whether a write is in progress
    this.writeQueue = [];         // Write queue
  }

  /**
   * Write data asynchronously with debouncing.
   * @param {object} data - Data to write
   * @returns {Promise<void>}
   */
  async write(data) {
    // BaSui: Store pending data; later writes replace earlier pending data.
    this.pendingData = data;

    // Batch from the first pending update. Continuous traffic must not postpone
    // persistence indefinitely by restarting the timer on every request.
    return new Promise((resolve, reject) => {
      
    // 🔧 Fix: Bound the queue size to prevent memory leaks.
    if (this.writeQueue.length > 1000) {
      const error = new Error('Write queue overflow - too many pending writes');
      logError('AsyncFileWriter queue overflow', error);
      reject(error);
      return;
    }

    this.writeQueue.push({ resolve, reject });

      if (!this.writeTimer) this.writeTimer = setTimeout(async () => {
        this.writeTimer = null;
        await this._flushWrite();
      }, this.debounceTime);
    });
  }

  /**
   * Write immediately, bypassing the debounce delay.
   * @param {object} data - Data to write
   * @returns {Promise<void>}
   */
  async writeImmediately(data) {
    this.pendingData = data;

    // BaSui: Clear the debounce timer.
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }

    return new Promise((resolve, reject) => {
      this.writeQueue.push({ resolve, reject });
      void this._flushWrite();
    });
  }

  /**
   * Perform the actual write with retries.
   * @private
   */
  async _flushWrite() {
    // BaSui: Prevent concurrent writes with a lock flag.
    if (this.isWriting) {
      // 🔧 BaSui fix: Use DEBUG level to avoid noisy logs.
      logDebug(`[FileWriter] Write in progress for ${this.filePath}, will retry after debounce`);
      return;
    }

    if (!this.pendingData) {
      return;  // No data to write.
    }

    this.isWriting = true;
    let finishWrite;
    this.activeWrite = new Promise(resolve => { finishWrite = resolve; });
    const dataToWrite = this.pendingData;
    const queueToNotify = [...this.writeQueue];
    this.pendingData = null;
    this.writeQueue = [];

    let lastError = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          logDebug(`Retrying file write: ${this.filePath} (attempt ${attempt + 1}/${this.maxRetries})`);
          await this._sleep(this.retryDelay);
        }

        // BaSui: Write atomically using a temporary file and rename.
        await this._atomicWrite(dataToWrite);

        logDebug(`File written successfully: ${this.filePath}${attempt > 0 ? ` (after ${attempt + 1} attempts)` : ''}`);

        // BaSui: Resolve all waiting promises.
        queueToNotify.forEach(({ resolve }) => resolve());

        this.isWriting = false;
        this.lastWriteError = null;
        finishWrite();
        if (this.pendingData) void this._flushWrite();
        return;  // Write succeeded.
      } catch (error) {
        lastError = error;
        logError(`File write failed (attempt ${attempt + 1}/${this.maxRetries}): ${this.filePath}`, error);
      }
    }

    // BaSui: All write attempts failed.
    this.isWriting = false;
    this.lastWriteError = lastError;
    finishWrite();
    const errorMsg = `File write failed after ${this.maxRetries} attempts: ${this.filePath} - ${lastError.message}`;
    logError(errorMsg, lastError);

    // BaSui: Reject all waiting promises.
    queueToNotify.forEach(({ reject }) => reject(new Error(errorMsg)));
    if (this.pendingData) void this._flushWrite();
  }

  /**
   * Atomic write using a temporary file and rename.
   * @private
   */
  async _atomicWrite(data) {
    const jsonData = JSON.stringify(data, null, 2);
    const tempPath = this.filePath + '.tmp';
    const backupPath = this.filePath + '.bak';

    // 1. Write the temporary file.
    await fs.writeFile(tempPath, jsonData, 'utf-8');

    // 2. Verify that the written data matches the intended content.
    const written = await fs.readFile(tempPath, 'utf-8');
    if (written !== jsonData) {
      throw new Error('Write verification failed: file contents do not match');
    }

    // 3. Back up the existing file, if present.
    try {
      await fs.access(this.filePath);
      await fs.copyFile(this.filePath, backupPath);
    } catch (err) {
      // The file does not exist; no backup is needed.
    }

    // 4. Rename atomically so a process crash does not leave a partially replaced file.
    await fs.rename(tempPath, this.filePath);
  }

  /**
   * Delay helper
   * @private
   */
  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Dispose of the writer on application exit.
   */
  async destroy() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }

    // Wait for the active write as well as any batch queued behind it.
    while (this.isWriting || this.pendingData) {
      if (this.isWriting) await this.activeWrite;
      else await this._flushWrite();
    }
    if (this.lastWriteError) throw this.lastWriteError;
  }
}

/**
 * Global file writer manager (singleton)
 */
class FileWriterManager {
  constructor() {
    this.writers = new Map();
  }

  /**
   * Get or create a file writer.
   * @param {string} filePath - File path
   * @param {object} options - Configuration options
   * @returns {AsyncFileWriter}
   */
  getWriter(filePath, options = {}) {
    if (!this.writers.has(filePath)) {
      this.writers.set(filePath, new AsyncFileWriter(filePath, options));
    }
    return this.writers.get(filePath);
  }

  /**
   * Dispose of all file writers.
   */
  async destroyAll() {
    const destroyPromises = [];
    for (const writer of this.writers.values()) {
      destroyPromises.push(writer.destroy());
    }
    await Promise.all(destroyPromises);
    this.writers.clear();
  }
}

// BaSui: Global singleton
const fileWriterManager = new FileWriterManager();

// 🔧 Fix: Flush all pending writes on process exit to prevent data loss.
async function flushAllWriters() {
  try {
    console.log('Flushing all pending writes...');
    await fileWriterManager.destroyAll();
    console.log('All pending writes flushed');
  } catch (error) {
    console.error('Error flushing writes:', error);
  }
}

// Register process shutdown hooks.
// The server owns signals and flushes after stopping connections and producers.
process.on('beforeExit', flushAllWriters);

export { AsyncFileWriter, fileWriterManager };
export default fileWriterManager;
