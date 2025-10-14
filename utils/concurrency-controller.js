/**
 * 并发控制器
 * 防止竞态条件和资源争抢
 */

import { logInfo, logError, logWarn } from '../logger.js';

class ConcurrencyController {
  constructor(maxConcurrent = 10) {
    this.maxConcurrent = maxConcurrent;
    this.currentTasks = new Map();
    this.queue = [];
    this.running = 0;
    this.taskIdCounter = 0;
    
    // 锁机制
    this.locks = new Map();
    this.lockWaiters = new Map();
  }
  
  /**
   * 获取唯一的任务ID（线程安全）
   */
  getNextId() {
    const id = this.taskIdCounter;
    this.taskIdCounter = id + 1;
    return id;
  }
  
  /**
   * 执行并发任务
   * @param {Function} task - 要执行的任务函数
   * @param {string} taskName - 任务名称
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
   * 处理队列中的任务
   */
  processQueue() {
    while (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const task = this.queue.shift();
      task();
    }
  }
  
  /**
   * 获取互斥锁
   * @param {string} resource - 资源标识
   * @param {number} timeout - 超时时间（毫秒）
   */
  async acquireLock(resource, timeout = 5000) {
    const startTime = Date.now();
    
    while (this.locks.has(resource)) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Lock acquisition timeout for resource: ${resource}`);
      }
      
      // 等待锁释放
      if (!this.lockWaiters.has(resource)) {
        this.lockWaiters.set(resource, []);
      }
      
      await new Promise(resolve => {
        this.lockWaiters.get(resource).push(resolve);
      });
    }
    
    // 获取锁
    this.locks.set(resource, Date.now());
    return {
      release: () => this.releaseLock(resource)
    };
  }
  
  /**
   * 释放锁
   * @param {string} resource - 资源标识
   */
  releaseLock(resource) {
    this.locks.delete(resource);
    
    // 通知等待者
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
   * 获取当前状态
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
   * 等待所有任务完成
   */
  async waitAll() {
    while (this.running > 0 || this.queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

// 创建全局实例
const globalController = new ConcurrencyController(100);

export default ConcurrencyController;
export { globalController, ConcurrencyController };
