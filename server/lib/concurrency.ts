/**
 * Simple concurrency limiter to avoid p-limit ESM/CommonJS issues
 */
class ConcurrencyLimiter {
  private queue: Array<() => void> = [];
  private activeCount = 0;

  constructor(private limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.activeCount >= this.limit) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }

    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      const resolve = this.queue.shift();
      if (resolve) resolve();
    }
  }
}

// Concurrency limiters for different operations
export const renameLimiter = new ConcurrencyLimiter(10);  // 10 concurrent rename calls
export const imageLimiter = new ConcurrencyLimiter(5);    // 5 concurrent image generations

/**
 * Process an array of items with controlled concurrency
 * @param items - Array of items to process
 * @param processFn - Async function to process each item
 * @param limiter - ConcurrencyLimiter instance for concurrency control
 * @returns Promise resolving to array of results
 */
export async function processWithConcurrency<T, R>(
  items: T[],
  processFn: (item: T, index: number) => Promise<R>,
  limiter: ConcurrencyLimiter
): Promise<PromiseSettledResult<R>[]> {
  const promises = items.map((item, index) =>
    limiter.run(() => processFn(item, index))
  );

  return Promise.allSettled(promises);
}

/**
 * Process items in batches with a delay between batches
 * Useful if you want to be extra cautious about API load
 */
export async function processBatched<T, R>(
  items: T[],
  batchSize: number,
  processFn: (item: T) => Promise<R>,
  delayMs: number = 0
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(item => processFn(item))
    );
    results.push(...batchResults);

    // Optional delay between batches
    if (delayMs > 0 && i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}
