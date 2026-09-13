/**
 * Atomic counter
 * Prevent incorrect counts during concurrent operations.
 */

class AtomicCounter {
  constructor(initialValue = 0) {
    this._value = initialValue;
    this._lock = false;
    this._waiters = [];
  }
  
  /**
   * Get the current value.
   */
  get value() {
    return this._value;
  }
  
  /**
   * Increment atomically.
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
   * Decrement atomically.
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
   * Add atomically.
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
   * Compare and swap.
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
   * Acquire the lock.
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
   * Release the lock.
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
