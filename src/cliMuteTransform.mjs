import { Transform } from "node:stream";

/**
 * Create a Transform that swallows all chunks while `isMuted()` returns true,
 * and passes them through unchanged while it returns false.
 *
 * Intended to sit between `createInterruptTransform` and the paste handler so
 * that callers can fully silence regular stdin input during special modes
 * (e.g. while a voice input session is recording) without coupling that
 * concern to the interrupt-detection logic.
 *
 * @param {object} options
 * @param {() => boolean} options.isMuted
 *   Called for each incoming chunk; when true the chunk is dropped.
 * @returns {Transform}
 */
export function createMuteTransform({ isMuted }) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (!isMuted()) {
        this.push(chunk);
      }
      callback();
    },
  });
}
