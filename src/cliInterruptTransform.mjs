import { Transform } from "node:stream";

/**
 * Create a Transform that intercepts Ctrl-C (0x03), Ctrl-D (0x04), and
 * Ctrl-G (0x07). When one of those bytes is seen anywhere in a chunk, the
 * corresponding callback is invoked and the entire chunk is dropped so that
 * downstream consumers (e.g. readline) never observe it. All other input
 * flows through unchanged.
 *
 * Priority when multiple handled bytes appear in the same chunk:
 * Ctrl-C > Ctrl-D > Ctrl-G.
 *
 * When `shouldSwallowOthers()` returns true, chunks that do not contain a
 * handled control byte are also dropped. This lets callers fully mute stdin
 * during special modes (e.g. while a voice input session is recording) while
 * still responding to Ctrl-C / Ctrl-D / Ctrl-G.
 *
 * @param {object} handlers
 * @param {() => void} handlers.onCtrlC - Called when Ctrl-C is detected
 * @param {() => void} handlers.onCtrlD - Called when Ctrl-D is detected
 * @param {() => void} [handlers.onCtrlG] - Called when Ctrl-G is detected
 * @param {() => boolean} [handlers.shouldSwallowOthers]
 *   Optional predicate; when true, non-handled chunks are dropped.
 * @returns {Transform}
 */
export function createInterruptTransform({
  onCtrlC,
  onCtrlD,
  onCtrlG,
  shouldSwallowOthers,
}) {
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
      if (onCtrlG && data.includes("\x07")) {
        onCtrlG();
        callback();
        return;
      }
      if (shouldSwallowOthers?.()) {
        callback();
        return;
      }
      this.push(chunk);
      callback();
    },
  });
}
