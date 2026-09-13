/**
 * Global resource manager
 * Manage resources centrally to prevent memory leaks.
 */

import { logInfo, logError } from '../logger.js';

class ResourceManager {
  constructor() {
    this.timers = new Map();
    this.intervals = new Map();
    this.listeners = new Map();
    this.connections = new Map();
    
    // Register cleanup handlers for process shutdown.
    this.registerExitHandlers();
  }
  
  /**
   * Register a timeout timer.
   */
  addTimer(id, timer) {
    this.timers.set(id, timer);
    return timer;
  }
  
  /**
   * Clear a timeout timer.
   */
  clearTimer(id) {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
  
  /**
   * Register an interval timer.
   */
  addInterval(id, interval) {
    this.intervals.set(id, interval);
    return interval;
  }
  
  /**
   * Clear an interval timer.
   */
  clearInterval(id) {
    const interval = this.intervals.get(id);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(id);
    }
  }
  
  /**
   * Register an event listener.
   */
  addEventListener(id, emitter, event, listener) {
    const key = `${id}_${event}`;
    this.listeners.set(key, { emitter, event, listener });
    emitter.on(event, listener);
  }
  
  /**
   * Remove an event listener.
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
   * Clean up all resources.
   */
  cleanupAll() {
    logInfo('Cleaning up all resources...');
    
    // Clear all timeout timers.
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    
    // Clear all interval timers.
    for (const [id, interval] of this.intervals) {
      clearInterval(interval);
    }
    this.intervals.clear();
    
    // Remove all event listeners.
    for (const [key, item] of this.listeners) {
      item.emitter.removeListener(item.event, item.listener);
    }
    this.listeners.clear();
    
    // Close all connections.
    for (const [id, connection] of this.connections) {
      if (connection.close) connection.close();
      if (connection.destroy) connection.destroy();
      if (connection.end) connection.end();
    }
    this.connections.clear();
    
    logInfo('All resources cleaned up');
  }
  
  /**
   * Register process shutdown handlers.
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

// Singleton instance
const resourceManager = new ResourceManager();

export default resourceManager;
export { resourceManager };
