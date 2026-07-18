/**
 * @template T
 * @typedef {{
 *   push: (value: T) => void,
 *   close: () => void,
 *   [Symbol.asyncIterator]: () => AsyncIterator<T>,
 * }} AsyncQueue
 */

/**
 * Create an unbounded async queue that converts a push-based producer into a
 * pull-based async iterable. Values pushed while no consumer is waiting are
 * buffered and delivered in FIFO order; pending `next()` calls are resolved
 * immediately when a value is pushed.
 *
 * This hides the push/pull impedance mismatch behind a single AsyncIterable
 * so callers can consume events with `for await`.
 *
 * @template T
 * @returns {AsyncQueue<T>}
 *
 * @example
 * const queue = createAsyncQueue();
 * queue.push("a");
 * for await (const value of queue) {
 *   console.log(value);
 * }
 */
export function createAsyncQueue() {
  /** @type {T[]} */
  const buffer = [];
  /** @type {((result: IteratorResult<T>) => void)[]} */
  const waiters = [];
  let closed = false;

  return {
    /**
     * Enqueue a value. Resolves a pending consumer if one is waiting,
     * otherwise buffers the value. No-op once the queue is closed.
     * @param {T} value
     */
    push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
      } else {
        buffer.push(value);
      }
    },

    /**
     * Close the queue. Buffered values are still delivered, then iteration
     * ends. Pending consumers are resolved with `done: true`.
     */
    close() {
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined, done: true });
      }
    },

    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffer.length > 0) {
            const value = /** @type {T} */ (buffer.shift());
            return Promise.resolve({ value, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
        return() {
          closed = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
