/**
 * 前端性能优化工具库
 * 解决渲染失败和性能问题
 * @author BaSui
 */

// ==================== DOM渲染优化 ====================

/**
 * 批量DOM更新 - 使用DocumentFragment减少重排
 */
class BatchDOMUpdater {
    constructor() {
        this.queue = [];
        this.isScheduled = false;
        this.fragment = null;
    }

    add(operation) {
        this.queue.push(operation);
        if (!this.isScheduled) {
            this.isScheduled = true;
            requestAnimationFrame(() => this.flush());
        }
    }

    flush() {
        const fragment = document.createDocumentFragment();
        this.queue.forEach(op => op(fragment));
        this.queue = [];
        this.isScheduled = false;
    }
}

/**
 * 虚拟滚动实现 - 只渲染可见区域的元素
 */
class VirtualScroller {
    constructor(container, itemHeight, renderItem) {
        this.container = container;
        this.itemHeight = itemHeight;
        this.renderItem = renderItem;
        this.items = [];
        this.scrollTop = 0;
        this.visibleStart = 0;
        this.visibleEnd = 0;
        this.scrollHandler = this.handleScroll.bind(this);
        this.init();
    }

    init() {
        this.container.style.position = 'relative';
        this.container.style.overflow = 'auto';
        this.container.addEventListener('scroll', this.scrollHandler, { passive: true });
        
        // 创建占位元素
        this.spacer = document.createElement('div');
        this.spacer.style.position = 'absolute';
        this.spacer.style.top = '0';
        this.spacer.style.left = '0';
        this.spacer.style.width = '1px';
        this.spacer.style.visibility = 'hidden';
        this.container.appendChild(this.spacer);
        
        // 创建内容容器
        this.content = document.createElement('div');
        this.content.style.position = 'relative';
        this.container.appendChild(this.content);
    }

    setItems(items) {
        this.items = items;
        this.spacer.style.height = `${items.length * this.itemHeight}px`;
        this.render();
    }

    handleScroll() {
        this.scrollTop = this.container.scrollTop;
        requestAnimationFrame(() => this.render());
    }

    render() {
        const containerHeight = this.container.clientHeight;
        const buffer = 5; // 额外渲染的行数
        
        this.visibleStart = Math.max(0, Math.floor(this.scrollTop / this.itemHeight) - buffer);
        this.visibleEnd = Math.min(
            this.items.length,
            Math.ceil((this.scrollTop + containerHeight) / this.itemHeight) + buffer
        );

        // 清空内容
        this.content.innerHTML = '';
        
        // 使用DocumentFragment批量插入
        const fragment = document.createDocumentFragment();
        
        for (let i = this.visibleStart; i < this.visibleEnd; i++) {
            const item = this.items[i];
            const element = this.renderItem(item, i);
            element.style.position = 'absolute';
            element.style.top = `${i * this.itemHeight}px`;
            element.style.left = '0';
            element.style.right = '0';
            fragment.appendChild(element);
        }
        
        this.content.appendChild(fragment);
    }

    destroy() {
        this.container.removeEventListener('scroll', this.scrollHandler);
    }
}

// ==================== 防抖和节流 ====================

/**
 * 防抖函数 - 延迟执行
 */
function debounce(func, wait = 300) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * 节流函数 - 限制执行频率
 */
function throttle(func, limit = 100) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

/**
 * RAF节流 - 使用requestAnimationFrame节流
 */
function rafThrottle(func) {
    let ticking = false;
    return function(...args) {
        if (!ticking) {
            ticking = true;
            requestAnimationFrame(() => {
                func.apply(this, args);
                ticking = false;
            });
        }
    };
}

// ==================== 内存管理 ====================

/**
 * 对象池 - 复用对象减少GC压力
 */
class ObjectPool {
    constructor(createFn, resetFn, maxSize = 100) {
        this.createFn = createFn;
        this.resetFn = resetFn;
        this.maxSize = maxSize;
        this.pool = [];
    }

    acquire() {
        if (this.pool.length > 0) {
            return this.pool.pop();
        }
        return this.createFn();
    }

    release(obj) {
        if (this.pool.length < this.maxSize) {
            this.resetFn(obj);
            this.pool.push(obj);
        }
    }

    clear() {
        this.pool = [];
    }
}

// ==================== 懒加载 ====================

/**
 * 图片懒加载
 */
class LazyLoader {
    constructor(options = {}) {
        this.options = {
            root: null,
            rootMargin: '50px',
            threshold: 0.01,
            ...options
        };
        this.observer = null;
        this.init();
    }

    init() {
        if ('IntersectionObserver' in window) {
            this.observer = new IntersectionObserver(
                this.handleIntersection.bind(this),
                this.options
            );
        }
    }

    handleIntersection(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const target = entry.target;
                const src = target.dataset.src;
                if (src) {
                    target.src = src;
                    target.removeAttribute('data-src');
                    this.observer.unobserve(target);
                }
            }
        });
    }

    observe(element) {
        if (this.observer) {
            this.observer.observe(element);
        }
    }

    observeAll(selector = '[data-src]') {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => this.observe(el));
    }

    disconnect() {
        if (this.observer) {
            this.observer.disconnect();
        }
    }
}

// ==================== 渲染优化 ====================

/**
 * 分片渲染 - 将大任务分成小块
 */
class ChunkRenderer {
    constructor(data, renderFn, options = {}) {
        this.data = data;
        this.renderFn = renderFn;
        this.options = {
            chunkSize: 10,
            delay: 0,
            onProgress: null,
            onComplete: null,
            ...options
        };
        this.currentIndex = 0;
        this.isRunning = false;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.currentIndex = 0;
        this.processNextChunk();
    }

    processNextChunk() {
        if (!this.isRunning || this.currentIndex >= this.data.length) {
            this.isRunning = false;
            if (this.options.onComplete) {
                this.options.onComplete();
            }
            return;
        }

        const chunk = this.data.slice(
            this.currentIndex,
            this.currentIndex + this.options.chunkSize
        );

        // 使用requestIdleCallback优化
        if ('requestIdleCallback' in window) {
            requestIdleCallback(deadline => {
                while (deadline.timeRemaining() > 0 && chunk.length > 0) {
                    const item = chunk.shift();
                    this.renderFn(item, this.currentIndex++);
                }
                
                if (this.options.onProgress) {
                    this.options.onProgress(this.currentIndex, this.data.length);
                }

                if (this.options.delay > 0) {
                    setTimeout(() => this.processNextChunk(), this.options.delay);
                } else {
                    this.processNextChunk();
                }
            });
        } else {
            // 降级方案
            requestAnimationFrame(() => {
                chunk.forEach((item, i) => {
                    this.renderFn(item, this.currentIndex++);
                });

                if (this.options.onProgress) {
                    this.options.onProgress(this.currentIndex, this.data.length);
                }

                setTimeout(() => this.processNextChunk(), this.options.delay);
            });
        }
    }

    stop() {
        this.isRunning = false;
    }
}

// ==================== 缓存管理 ====================

/**
 * LRU缓存 - 最近最少使用缓存
 */
class LRUCache {
    constructor(maxSize = 100) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return undefined;
        
        const value = this.cache.get(key);
        // 移到最后（最近使用）
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // 删除最旧的
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    clear() {
        this.cache.clear();
    }
}

// ==================== Web Worker 支持 ====================

/**
 * Worker池 - 管理多个Worker
 */
class WorkerPool {
    constructor(workerScript, poolSize = 4) {
        this.workerScript = workerScript;
        this.poolSize = poolSize;
        this.workers = [];
        this.queue = [];
        this.init();
    }

    init() {
        for (let i = 0; i < this.poolSize; i++) {
            const worker = new Worker(this.workerScript);
            worker.isBusy = false;
            worker.onmessage = (e) => this.handleMessage(worker, e);
            this.workers.push(worker);
        }
    }

    handleMessage(worker, event) {
        worker.isBusy = false;
        if (worker.resolve) {
            worker.resolve(event.data);
            worker.resolve = null;
        }
        this.processQueue();
    }

    execute(data) {
        return new Promise((resolve) => {
            const availableWorker = this.workers.find(w => !w.isBusy);
            
            if (availableWorker) {
                availableWorker.isBusy = true;
                availableWorker.resolve = resolve;
                availableWorker.postMessage(data);
            } else {
                this.queue.push({ data, resolve });
            }
        });
    }

    processQueue() {
        if (this.queue.length === 0) return;
        
        const availableWorker = this.workers.find(w => !w.isBusy);
        if (availableWorker) {
            const { data, resolve } = this.queue.shift();
            availableWorker.isBusy = true;
            availableWorker.resolve = resolve;
            availableWorker.postMessage(data);
        }
    }

    terminate() {
        this.workers.forEach(worker => worker.terminate());
        this.workers = [];
        this.queue = [];
    }
}

// ==================== 导出全局对象 ====================

window.PerformanceUtils = {
    BatchDOMUpdater,
    VirtualScroller,
    debounce,
    throttle,
    rafThrottle,
    ObjectPool,
    LazyLoader,
    ChunkRenderer,
    LRUCache,
    WorkerPool
};

console.log('✅ 性能优化工具库已加载 - BaSui');
