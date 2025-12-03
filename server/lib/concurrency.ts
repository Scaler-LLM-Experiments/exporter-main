import pLimit from 'p-limit';

// Concurrency limiters for different operations
export const renameLimiter = pLimit(10);  // 10 concurrent rename calls
export const imageLimiter = pLimit(5);    // 5 concurrent image generations

/**
 * Process an array of items with controlled concurrency
 * @param items - Array of items to process
 * @param processFn - Async function to process each item
 * @param limiter - p-limit instance for concurrency control
 * @returns Promise resolving to array of results
 */
export async function processWithConcurrency<T, R>(
  items: T[],
  processFn: (item: T, index: number) => Promise<R>,
  limiter: ReturnType<typeof pLimit>
): Promise<PromiseSettledResult<R>[]> {
  const promises = items.map((item, index) =>
    limiter(() => processFn(item, index))
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
