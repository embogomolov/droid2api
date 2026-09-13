/**
 * Frontend performance utilities
 * Address rendering failures and performance issues
 * @author BaSui
 */

// ==================== DOM rendering optimization ====================

/**
 * Batch DOM updates using DocumentFragment to reduce layout recalculation
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
 * Virtual scrolling: render only items in and around the visible viewport
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
        
        // Create a spacer element
        this.spacer = document.createElement('div');
        this.spacer.style.position = 'absolute';
        this.spacer.style.top = '0';
        this.spacer.style.left = '0';
        this.spacer.style.width = '1px';
        this.spacer.style.visibility = 'hidden';
        this.container.appendChild(this.spacer);
        
        // Create the content container
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
        const buffer = 5; // Number of extra rows to render outside the viewport
        
        this.visibleStart = Math.max(0, Math.floor(this.scrollTop / this.itemHeight) - buffer);
        this.visibleEnd = Math.min(
            this.items.length,
            Math.ceil((this.scrollTop + containerHeight) / this.itemHeight) + buffer
        );

        // Clear the content
        this.content.innerHTML = '';
        
        // Batch insertions using DocumentFragment
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

// ==================== Debouncing and throttling ====================

/**
 * Debounce: defer execution until calls stop for the specified interval
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
 * Throttle: limit execution frequency
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
 * RAF throttle: limit execution to animation frames
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

// ==================== Memory management ====================

/**
 * Object pool: reuse objects to reduce garbage collection pressure
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

// ==================== Lazy loading ====================

/**
 * Lazy loading for images
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

// ==================== Rendering optimization ====================

/**
 * Chunked rendering: split large tasks into smaller batches
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

        // Schedule work during idle periods using requestIdleCallback
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
            // Fallback implementation
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

// ==================== Cache management ====================

/**
 * LRU cache: evict the least recently used entry
 */
class LRUCache {
    constructor(maxSize = 100) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return undefined;
        
        const value = this.cache.get(key);
        // Move to the end to mark as most recently used
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Remove the least recently used entry
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    clear() {
        this.cache.clear();
    }
}

// ==================== Web Worker support ====================

/**
 * Worker pool: manage multiple Web Workers
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

// ==================== Expose the utilities as a global object ====================

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

console.log('✅ Performance utilities loaded - BaSui');
