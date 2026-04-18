import { Transform } from "node:stream";

/**
 * Create a Transform that intercepts Ctrl-C (0x03) and Ctrl-D (0x04). When
 * either byte is seen anywhere in a chunk, `onInterrupt()` is invoked and the
 * entire chunk is dropped so that downstream consumers (e.g. readline) never
 * observe it. All other input flows through unchanged.
 *
 * @param {() => void} onInterrupt - Called when Ctrl-C or Ctrl-D is detected
 * @returns {Transform}
 */
export function createInterruptTransform(onInterrupt) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      const data = chunk.toString("utf8");
      if (data.includes("\x03") || data.includes("\x04")) {
        onInterrupt();
        callback();
        return;
      }
      this.push(chunk);
      callback();
    },
  });
}
