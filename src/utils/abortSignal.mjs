/**
 * Combine a user-supplied AbortSignal with a timeout.
 * Returns a single AbortSignal that fires when either source aborts.
 * @param {AbortSignal | undefined} userSignal
 * @param {number} timeoutMs
 * @returns {AbortSignal}
 */
export function combineSignals(userSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!userSignal) {
    return timeoutSignal;
  }
  return AbortSignal.any([userSignal, timeoutSignal]);
}

/**
 * Sleep for `ms` milliseconds. Rejects with AbortError if `signal` aborts.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
