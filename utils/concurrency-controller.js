/**
 * Concurrency controller
 * Prevent race conditions and resource contention.
 */

import { logInfo, logError, logWarn } from '../logger.js';

class ConcurrencyController {
  constructor(maxConcurrent = 10) {
    this.maxConcurrent = maxConcurrent;
    this.currentTasks = new Map();
    this.queue = [];
    this.running = 0;
    this.taskIdCounter = 0;
    
    // Lock tracking
    this.locks = new Map();
    this.lockWaiters = new Map();
  }
  
  /**
   * Allocate a unique task ID synchronously within this process.
   */
  getNextId() {
    const id = this.taskIdCounter;
    this.taskIdCounter = id + 1;
    return id;
  }
  
  /**
   * Execute a task subject to the concurrency limit.
   * @param {Function} task - Task function to execute
   * @param {string} taskName - Task name
   */
  async execute(task, taskName = 'unnamed') {
    const taskId = this.getNextId();
    
    return new Promise((resolve, reject) => {
      const taskWrapper = async () => {
        this.running++;
        this.currentTasks.set(taskId, { name: taskName, startTime: Date.now() });
        
        try {
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.running--;
          this.currentTasks.delete(taskId);
          this.processQueue();
        }
      };
      
      if (this.running < this.maxConcurrent) {
        taskWrapper();
      } else {
        this.queue.push(taskWrapper);
      }
    });
  }
  
  /**
   * Process queued tasks.
   */
  processQueue() {
    while (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const task = this.queue.shift();
      task();
    }
  }
  
  /**
   * Acquire an exclusive lock.
   * @param {string} resource - Resource identifier
   * @param {number} timeout - Timeout in milliseconds
   */
  async acquireLock(resource, timeout = 5000) {
    const startTime = Date.now();
    
    while (this.locks.has(resource)) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Lock acquisition timeout for resource: ${resource}`);
      }
      
      // Wait for the lock to be released.
      if (!this.lockWaiters.has(resource)) {
        this.lockWaiters.set(resource, []);
      }
      
      await new Promise(resolve => {
        this.lockWaiters.get(resource).push(resolve);
      });
    }
    
    // Acquire the lock.
    this.locks.set(resource, Date.now());
    return {
      release: () => this.releaseLock(resource)
    };
  }
  
  /**
   * Release the lock.
   * @param {string} resource - Resource identifier
   */
  releaseLock(resource) {
    this.locks.delete(resource);
    
    // Notify a waiter.
    const waiters = this.lockWaiters.get(resource);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift();
      waiter();
      
      if (waiters.length === 0) {
        this.lockWaiters.delete(resource);
      }
    }
  }
  
  /**
   * Get the current status.
   */
  getStatus() {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      locks: Array.from(this.locks.keys()),
      tasks: Array.from(this.currentTasks.values())
    };
  }
  
  /**
   * Wait for all tasks to complete.
   */
  async waitAll() {
    while (this.running > 0 || this.queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

// Create the global instance.
const globalController = new ConcurrencyController(100);

export default ConcurrencyController;
export { globalController, ConcurrencyController };
