/**
 * 原子计数器
 * 防止并发计数错误
 */

class AtomicCounter {
  constructor(initialValue = 0) {
    this._value = initialValue;
    this._lock = false;
    this._waiters = [];
  }
  
  /**
   * 获取当前值
   */
  get value() {
    return this._value;
  }
  
  /**
   * 原子递增
   */
  async increment() {
    await this._acquireLock();
    try {
      const oldValue = this._value;
      this._value = oldValue + 1;
      return this._value;
    } finally {
      this._releaseLock();
    }
  }
  
  /**
   * 原子递减
   */
  async decrement() {
    await this._acquireLock();
    try {
      const oldValue = this._value;
      this._value = oldValue - 1;
      return this._value;
    } finally {
      this._releaseLock();
    }
  }
  
  /**
   * 原子加法
   */
  async add(delta) {
    await this._acquireLock();
    try {
      const oldValue = this._value;
      this._value = oldValue + delta;
      return this._value;
    } finally {
      this._releaseLock();
    }
  }
  
  /**
   * 比较并交换
   */
  async compareAndSwap(expectedValue, newValue) {
    await this._acquireLock();
    try {
      if (this._value === expectedValue) {
        this._value = newValue;
        return true;
      }
      return false;
    } finally {
      this._releaseLock();
    }
  }
  
  /**
   * 获取锁
   */
  async _acquireLock() {
    while (this._lock) {
      await new Promise(resolve => {
        this._waiters.push(resolve);
      });
    }
    this._lock = true;
  }
  
  /**
   * 释放锁
   */
  _releaseLock() {
    this._lock = false;
    if (this._waiters.length > 0) {
      const waiter = this._waiters.shift();
      waiter();
    }
  }
}

export default AtomicCounter;
export { AtomicCounter };
