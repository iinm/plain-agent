import { Transform } from "node:stream";

/**
 * Create a Transform that intercepts Ctrl-C (0x03), Ctrl-D (0x04), and an
 * optional "voice toggle" byte (default Ctrl-O, 0x0f). When one of those
 * bytes is seen anywhere in a chunk, the corresponding callback is invoked
 * and the entire chunk is dropped so that downstream consumers (e.g.
 * readline) never observe it. All other input flows through unchanged.
 *
 * Priority when multiple handled bytes appear in the same chunk:
 * Ctrl-C > Ctrl-D > voice toggle.
 *
 * @param {object} handlers
 * @param {() => void} handlers.onCtrlC - Called when Ctrl-C is detected
 * @param {() => void} handlers.onCtrlD - Called when Ctrl-D is detected
 * @param {() => void} [handlers.onVoiceToggle]
 *   Called when the voice toggle byte is detected.
 * @param {number} [handlers.voiceToggleByte]
 *   Byte value for the voice toggle key. Defaults to 0x0f (Ctrl-O).
 * @returns {Transform}
 */
export function createInterruptTransform({
  onCtrlC,
  onCtrlD,
  onVoiceToggle,
  voiceToggleByte = 0x0f,
}) {
  const voiceToggleChar = String.fromCharCode(voiceToggleByte);
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
      if (onVoiceToggle && data.includes(voiceToggleChar)) {
        onVoiceToggle();
        callback();
        return;
      }
      this.push(chunk);
      callback();
    },
  });
}
