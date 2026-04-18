import { Transform } from "node:stream";

/**
 * Create a Transform that intercepts Ctrl-C (0x03) and Ctrl-D (0x04). When
 * either byte is seen anywhere in a chunk, the corresponding callback is
 * invoked and the entire chunk is dropped so that downstream consumers (e.g.
 * readline) never observe it. All other input flows through unchanged.
 *
 * If both bytes appear in the same chunk, Ctrl-C is handled first.
 *
 * @param {object} handlers
 * @param {() => void} handlers.onCtrlC - Called when Ctrl-C is detected
 * @param {() => void} handlers.onCtrlD - Called when Ctrl-D is detected
 * @returns {Transform}
 */
export function createInterruptTransform({ onCtrlC, onCtrlD }) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      const data = chunk.toString("utf8");
      if (data.includes("\x03")) {
        onCtrlC();
        callback();
        return;
      }
      if (data.includes("\x04")) {
        onCtrlD();
        callback();
        return;
      }
      this.push(chunk);
      callback();
    },
  });
}
