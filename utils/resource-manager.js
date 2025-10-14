/**
 * 全局资源管理器
 * 防止内存泄漏，统一管理所有资源
 */

import { logInfo, logError } from '../logger.js';

class ResourceManager {
  constructor() {
    this.timers = new Map();
    this.intervals = new Map();
    this.listeners = new Map();
    this.connections = new Map();
    
    // 注册进程退出清理
    this.registerExitHandlers();
  }
  
  /**
   * 注册定时器
   */
  addTimer(id, timer) {
    this.timers.set(id, timer);
    return timer;
  }
  
  /**
   * 清理定时器
   */
  clearTimer(id) {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
  
  /**
   * 注册间隔定时器
   */
  addInterval(id, interval) {
    this.intervals.set(id, interval);
    return interval;
  }
  
  /**
   * 清理间隔定时器
   */
  clearInterval(id) {
    const interval = this.intervals.get(id);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(id);
    }
  }
  
  /**
   * 注册事件监听器
   */
  addEventListener(id, emitter, event, listener) {
    const key = `${id}_${event}`;
    this.listeners.set(key, { emitter, event, listener });
    emitter.on(event, listener);
  }
  
  /**
   * 移除事件监听器
   */
  removeEventListener(id, event) {
    const key = `${id}_${event}`;
    const item = this.listeners.get(key);
    if (item) {
      item.emitter.removeListener(item.event, item.listener);
      this.listeners.delete(key);
    }
  }
  
  /**
   * 清理所有资源
   */
  cleanupAll() {
    logInfo('Cleaning up all resources...');
    
    // 清理所有定时器
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    
    // 清理所有间隔定时器
    for (const [id, interval] of this.intervals) {
      clearInterval(interval);
    }
    this.intervals.clear();
    
    // 清理所有事件监听器
    for (const [key, item] of this.listeners) {
      item.emitter.removeListener(item.event, item.listener);
    }
    this.listeners.clear();
    
    // 清理所有连接
    for (const [id, connection] of this.connections) {
      if (connection.close) connection.close();
      if (connection.destroy) connection.destroy();
      if (connection.end) connection.end();
    }
    this.connections.clear();
    
    logInfo('All resources cleaned up');
  }
  
  /**
   * 注册进程退出处理
   */
  registerExitHandlers() {
    const cleanup = () => {
      this.cleanupAll();
    };
    
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    process.on('beforeExit', cleanup);
  }
}

// 单例模式
const resourceManager = new ResourceManager();

export default resourceManager;
export { resourceManager };
