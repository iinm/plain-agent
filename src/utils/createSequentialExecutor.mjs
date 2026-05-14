/**
 * Create a sequential executor that enqueues async operations
 * and executes them in order.
 *
 * @returns {(fn: () => Promise<void> | void) => Promise<void>}
 *   A function that enqueues an operation and returns a promise
 *   that resolves when all queued operations (including this one) complete.
 *
 * @example
 * const enqueue = createSequentialExecutor();
 *
 * // These will execute in order, even if called from different event handlers
 * enqueue(() => console.log("first"));
 * enqueue(async () => { await something(); });
 * enqueue(() => console.log("second"));
 */
export function createSequentialExecutor() {
  /** @type {Promise<void>} */
  let chain = Promise.resolve();

  return (fn) => {
    chain = chain.then(fn).catch((err) => {
      // Prevent unhandled rejection, but log the error
      console.error("Sequential executor error:", err);
    });
    return chain;
  };
}
