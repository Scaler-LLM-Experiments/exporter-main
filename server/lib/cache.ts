import crypto from 'crypto';

/**
 * Simple in-memory cache for AI responses
 * Can be upgraded to Redis for multi-instance deployments
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

class MemoryCache {
  private cache = new Map<string, CacheEntry<any>>();
  private hitCount = 0;
  private missCount = 0;

  /**
   * Generate a cache key from input data
   */
  generateKey(data: any): string {
    const json = JSON.stringify(data);
    return crypto.createHash('sha256').update(json).digest('hex');
  }

  /**
   * Get cached value if it exists and hasn't expired
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      this.missCount++;
      return null;
    }

    // Check if expired
    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      this.missCount++;
      return null;
    }

    this.hitCount++;
    console.log(`[Cache] HIT ${key.substring(0, 12)}... (age: ${((now - entry.timestamp) / 1000).toFixed(1)}s)`);
    return entry.data as T;
  }

  /**
   * Store value in cache with TTL (time to live in ms)
   */
  set<T>(key: string, data: T, ttl: number = 24 * 60 * 60 * 1000): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    });
    console.log(`[Cache] SET ${key.substring(0, 12)}... (TTL: ${(ttl / 1000 / 60).toFixed(0)}min)`);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
    console.log('[Cache] Cleared all entries');
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.hitCount + this.missCount;
    const hitRate = total > 0 ? ((this.hitCount / total) * 100).toFixed(1) : '0.0';

    return {
      size: this.cache.size,
      hits: this.hitCount,
      misses: this.missCount,
      hitRate: `${hitRate}%`,
      entries: Array.from(this.cache.keys()).map(key => ({
        key: key.substring(0, 16) + '...',
        age: ((Date.now() - this.cache.get(key)!.timestamp) / 1000).toFixed(0) + 's'
      }))
    };
  }

  /**
   * Clean up expired entries (run periodically)
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[Cache] Cleanup: removed ${cleaned} expired entries`);
    }

    return cleaned;
  }
}

// Export singleton instance
export const aiCache = new MemoryCache();

// Run cleanup every 10 minutes
setInterval(() => {
  aiCache.cleanup();
}, 10 * 60 * 1000);

// Log stats every hour
setInterval(() => {
  console.log('[Cache] Stats:', aiCache.getStats());
}, 60 * 60 * 1000);
