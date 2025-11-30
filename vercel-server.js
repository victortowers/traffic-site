const { createClient } = require('@vercel/kv');
const LRU = require('lru-cache');

const API_KEY = process.env.TOMTOM_API_KEY;

/**
 * @typedef {'kv' | 'memory'} CacheStrategy
 * Cache implementation strategy - 'kv' for Vercel KV, 'memory' for in-memory cache
 */

/**
 * @typedef {'closed' | 'open' | 'half-open'} CircuitState
 * Circuit breaker state machine states
 */

/**
 * @typedef {Object} CacheEntry
 * @property {any} value - The cached value
 * @property {string} etag - Cache validation tag
 * @property {number} expiresAt - Expiration timestamp in milliseconds
 */

// Circuit breaker state
const circuitBreaker = {
  /** @type {CircuitState} */
  state: 'closed', // Initial state - closed allows normal operation
  failureCount: 0,
  lastFailure: 0,
  /** @type {number} Threshold of failures per minute to open circuit */
  threshold: 5,
  /** @type {number} Cooldown period in ms before attempting half-open state */
  cooldown: 30000,
};

// Error tracking
const errorStats = {
  counts: { get: 0, set: 0, delete: 0 },
  lastUpdated: Date.now(),
};

/**
 * Tracks errors and manages circuit breaker state transitions
 * @param {'get' | 'set' | 'delete'} operation - The cache operation that failed
 * @throws {Error} If invalid operation type is provided
 */
function trackError(operation) {
  // Runtime type validation
  if (!['get', 'set', 'delete'].includes(operation)) {
    throw new Error(`Invalid operation type: ${operation}`);
  }

  errorStats.counts[operation] = (errorStats.counts[operation] || 0) + 1;
  
  // Check if we need to trip the circuit
  if (errorStats.counts[operation] >= circuitBreaker.threshold &&
      Date.now() - errorStats.lastUpdated < 60000) {
    circuitBreaker.state = 'open';
    circuitBreaker.lastFailure = Date.now();
    console.error(`Circuit breaker tripped to OPEN state due to ${errorStats.counts[operation]} ${operation} errors`);
  }
  
  // Reset counters every minute
  if (Date.now() - errorStats.lastUpdated > 60000) {
    errorStats.counts = { get: 0, set: 0, delete: 0 };
    errorStats.lastUpdated = Date.now();
  }
}

// Fallback in-memory cache for circuit breaker OPEN state
/**
 * Fallback cache implementation using LRU
 * @type {{
 *   get: (key: string) => CacheEntry | null,
 *   set: (key: string, value: any, ttl?: number) => void,
 *   delete: (key: string) => void
 * }}
 */
const fallbackCache = new LRU({ max: 100 });
const fallbackCacheImpl = {
  /**
   * Retrieves an entry from fallback cache
   * @param {string} key - Cache key
   * @returns {CacheEntry | null} Cached entry or null if not found
   */
  get: (key) => {
    const entry = fallbackCache.get(key);
    return entry ? { value: entry.value, etag: entry.etag, expiresAt: entry.expiresAt } : null;
  },
  
  /**
   * Stores an entry in fallback cache
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} [ttl=3600] - Time-to-live in seconds (default: 1 hour)
   */
  set: (key, value, ttl = 3600) => {
    const etag = generateETag(value);
    const expiresAt = Date.now() + ttl * 1000;
    fallbackCache.set(key, { value, etag, expiresAt }, { ttl: ttl * 1000 });
  },
  
  /**
   * Deletes an entry from fallback cache
   * @param {string} key - Cache key to delete
   */
  delete: (key) => fallbackCache.delete(key)
};

let cache = null;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  // Production - use Vercel KV
  const kvClient = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  
  const primaryCache = {
    /**
     * Get cached entry with metadata
     * @param {string} key Cache key
     * @returns {Promise<CacheEntry|null>} Cached entry or null
     */
    /**
     * Get cached entry with metadata from Vercel KV
     * @param {string} key - Cache key
     * @returns {Promise<CacheEntry|null>} Cached entry or null
     * @throws {Error} When underlying KV operation fails
     * @example
     * const entry = await primaryCache.get('my-key');
     * if (entry) console.log(entry.value);
     */
    get: async (key) => {
      try {
        const entry = await kvClient.get(key);
        return entry ? JSON.parse(entry) : null;
      } catch (err) {
        console.error(`KV get error for key ${key}:`, err);
        trackError('get');
        return null;
      }
    },
    
    /**
     * Set cached value with TTL and generated ETag
     * @param {string} key Cache key
     * @param {string} value Value to cache
     * @param {number} [ttl=3600] Time-to-live in seconds (default: 1 hour)
     * @returns {Promise<void>}
     */
    /**
     * Set cached value in Vercel KV with TTL and generated ETag
     * @param {string} key - Cache key
     * @param {any} value - Value to cache
     * @param {number} [ttl=3600] - Time-to-live in seconds (default: 1 hour)
     * @returns {Promise<void>}
     * @throws {Error} When underlying KV operation fails
     * @example
     * await primaryCache.set('my-key', { data: 'value' }, 60);
     */
    set: async (key, value, ttl = 3600) => {
      try {
        const etag = generateETag(value);
        const expires = Date.now() + ttl * 1000;
        await kvClient.set(key, JSON.stringify({ value, etag, expires }), { ex: ttl });
      } catch (err) {
        console.error(`KV set error for key ${key}:`, err);
        trackError('set');
      }
    },
    
    /**
     * Delete cached entry
     * @param {string} key Cache key
     * @returns {Promise<void>}
     */
    /**
     * Delete cached entry from Vercel KV
     * @param {string} key - Cache key to delete
     * @returns {Promise<void>}
     * @throws {Error} When underlying KV operation fails
     */
    delete: async (key) => {
      try {
        await kvClient.del(key);
      } catch (err) {
        console.error(`KV delete error for key ${key}:`, err);
        trackError('delete');
      }
    }
  };
  cache = {
    get: async (key) => {
      // Check circuit state
      if (circuitBreaker.state === 'open') {
        if (Date.now() - circuitBreaker.lastFailure > circuitBreaker.cooldown) {
          circuitBreaker.state = 'half-open';
        } else {
          return fallbackCacheImpl.get(key);
        }
      }
      
      try {
        const result = await primaryCache.get(key);
        if (circuitBreaker.state === 'half-open') {
          circuitBreaker.state = 'closed';
          circuitBreaker.failureCount = 0;
        }
        return result;
      } catch (err) {
        if (circuitBreaker.state === 'half-open') {
          circuitBreaker.state = 'open';
          circuitBreaker.lastFailure = Date.now();
        }
        throw err;
      }
    },
    
    set: async (key, value, ttl) => {
      if (circuitBreaker.state === 'open') {
        fallbackCacheImpl.set(key, value, ttl);
        return;
      }
      
      try {
        await primaryCache.set(key, value, ttl);
        if (circuitBreaker.state === 'HALF_OPEN') {
          circuitBreaker.state = 'closed';
          circuitBreaker.failureCount = 0;
        }
      } catch (err) {
        fallbackCacheImpl.set(key, value, ttl);
        throw err;
      }
    },
    
    delete: async (key) => {
      if (circuitBreaker.state === 'open') {
        fallbackCacheImpl.delete(key);
        return;
      }
      
      try {
        await primaryCache.delete(key);
        if (circuitBreaker.state === 'half-open') {
          circuitBreaker.state = 'closed';
          circuitBreaker.failureCount = 0;
        }
      } catch (err) {
        throw err;
      }
    }
  };
} else {
  // Development - use in-memory LRU cache
  const lruCache = new LRU({ max: 500 });
  cache = {
    /**
     * Get cached entry with metadata
     * @param {string} key Cache key
     * @returns {CacheEntry|null} Cached entry or null
     */
    get: (key) => {
      try {
        const entry = lruCache.get(key);
        return entry ? { value: entry.value, etag: entry.etag, expiresAt: entry.expiresAt } : null;
      } catch (err) {
        console.error(`LRU get error for key ${key}:`, err);
        return null;
      }
    },
    
    /**
     * Set cached value with TTL and generated ETag
     * @param {string} key Cache key
     * @param {string} value Value to cache
     * @param {number} [ttl=3600] Time-to-live in seconds (default: 1 hour)
     */
    set: (key, value, ttl = 3600) => {
      try {
        const etag = generateETag(value);
        const expires = Date.now() + ttl * 1000;
        lruCache.set(key, { value, etag, expiresAt: Date.now() + ttl * 1000 }, { ttl: ttl * 1000 });
      } catch (err) {
        console.error(`LRU set error for key ${key}:`, err);
      }
    },
    
    /**
     * Delete cached entry
     * @param {string} key Cache key
     */
    delete: (key) => {
      try {
        lruCache.delete(key);
      } catch (err) {
        console.error(`LRU delete error for key ${key}:`, err);
      }
    }
  };
}

/**
 * Generate simple ETag from value
 * @param {string} value
 * @returns {string} ETag
 */
/**
 * Generates ETag from value content and timestamp
 * @param {any} value - Value to generate ETag for
 * @returns {string} ETag in format "size-hextimestamp"
 * @example
 * const etag = generateETag('cache-value'); // "a-189fe3a"
 */
function generateETag(value) {
  // Runtime type validation
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
    value = JSON.stringify(value);
  }
  return `"${Buffer.from(value).length.toString(16)}-${Date.now().toString(16)}"`;
}

const activeDownloads = new Map();

module.exports = async function handler(req, res) {
  const { method, url, query } = req;

  // Root endpoint
  if (url === '/' || url === '/index.html') {
    res.statusCode = 200;
    res.end('Tile server operational');
    return;
  }

  // Tile endpoint
  if (method === 'GET' && url.startsWith('/tile')) {
    const x = parseInt(query.x, 10);
    const y = parseInt(query.y, 10);
    const z = parseInt(query.z, 10);

    if (
      isNaN(x) || !Number.isInteger(x) ||
      isNaN(y) || !Number.isInteger(y) ||
      isNaN(z) || !Number.isInteger(z)
    ) {
      res.statusCode = 400;
      res.end('Invalid or missing x, y, z query parameters');
      return;
    }

    const cacheKey = `tile:${z}_${x}_${y}`;
    const nocache = query.nocache === 'true';

    try {
      // Cache lookup (skip if nocache=true)
      if (!nocache) {
        const cached = await cache.get(cacheKey);
        if (cached) {
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('ETag', cached.etag);
          res.setHeader('X-Cache-Expiry', new Date(cached.expiresAt).toISOString());
          res.end(Buffer.from(cached.value, 'base64'));
          return;
        }
      }

      // Coalesce duplicate requests
      if (activeDownloads.has(cacheKey)) {
        await new Promise(resolve => activeDownloads.get(cacheKey).push(resolve));
        return;
      }

      const waiters = [];
      activeDownloads.set(cacheKey, waiters);

      const tileUrl = `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.png?key=${API_KEY}`;

      const fetchModule = await import('node-fetch');
      const fetch = fetchModule.default;

      const tileResp = await fetch(tileUrl);
      if (!tileResp.ok) throw new Error(`Tile fetch failed: ${tileResp.status}`);

      const buffer = await tileResp.arrayBuffer();
      const tileData = Buffer.from(buffer).toString('base64');

      // Only cache successful responses (200-299)
      if (tileResp.status >= 200 && tileResp.status < 300) {
        await cache.set(cacheKey, tileData, 300); // Default TTL 300s
        res.setHeader('X-Cache-Expiry', new Date(Date.now() + 300000).toISOString());
      }

      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from(tileData, 'base64'));

      for (const waiter of waiters) waiter();
    } catch (err) {
      res.statusCode = 500;
      res.end(err.message);
    } finally {
      activeDownloads.delete(cacheKey);
    }
    return;
  }

  // Fallback
  res.statusCode = 404;
  res.end('Not found');
};