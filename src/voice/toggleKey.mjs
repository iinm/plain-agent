/**
 * @typedef {Object} VoiceToggleKey
 * @property {number} byte
 * @property {string} label
 */

// Bytes reserved for other terminal/readline uses — cannot be used as a voice toggle.
//   0x03 = Ctrl-C (SIGINT)
//   0x04 = Ctrl-D (EOF / readline exit)
//   0x09 = Ctrl-I (Tab)
//   0x0a = Ctrl-J (LF / Enter)
//   0x0d = Ctrl-M (CR / Enter)
//   0x11 = Ctrl-Q (XON: resume terminal output)
//   0x13 = Ctrl-S (XOFF: suspend terminal output)
const RESERVED_TERMINAL_BYTES = new Set([
  0x03, 0x04, 0x09, 0x0a, 0x0d, 0x11, 0x13,
]);

/**
 * Parse a "ctrl-<char>" binding into the raw byte the terminal sends in
 * raw mode. Only Ctrl-<char> is supported because it is the only family
 * the pre-readline pipeline can recognize without a full key decoder.
 *
 * @param {string | undefined} spec
 * @returns {VoiceToggleKey}
 */
export function parseVoiceToggleKey(spec) {
  const raw = (spec ?? "ctrl-o").trim().toLowerCase();

  const match = /^ctrl-(.)$/.exec(raw);
  if (!match) {
    throw new Error(
      `Invalid voiceInput.toggleKey "${spec}". Expected "ctrl-<char>".`,
    );
  }

  const ch = match[1];
  const code = ch.charCodeAt(0);

  // Subtracting a fixed offset from the character's ASCII code yields the
  // control byte (0x01–0x1f) the terminal sends for that Ctrl combination.
  let byte;
  if (code >= 0x61 && code <= 0x7a) {
    // a–z (0x61–0x7a): subtract 0x60 → 0x01 (Ctrl-A) – 0x1a (Ctrl-Z)
    byte = code - 0x60;
  } else if (code >= 0x5b && code <= 0x5f) {
    // [ \ ] ^ _ (0x5b–0x5f): subtract 0x40 → 0x1b (Ctrl-[) – 0x1f (Ctrl-_)
    byte = code - 0x40;
  } else {
    throw new Error(
      `Unsupported voiceInput.toggleKey "${spec}". Use ctrl-<letter> or ctrl-<[ \\ ] ^ _>.`,
    );
  }

  if (RESERVED_TERMINAL_BYTES.has(byte)) {
    throw new Error(
      `voiceInput.toggleKey "${spec}" conflicts with a reserved terminal/readline key.`,
    );
  }

  return { byte, label: `Ctrl-${ch.toUpperCase()}` };
}
