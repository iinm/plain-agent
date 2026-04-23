import { spawn, spawnSync } from "node:child_process";

/**
 * @typedef {Object} VoiceRecorderConfig
 * @property {string} command
 * @property {string[]} args
 *   Must write raw 16-bit little-endian mono PCM to stdout at the sample
 *   rate required by the chosen provider (24 kHz for OpenAI, 16 kHz for
 *   Gemini).
 */

/**
 * @typedef {Object} VoiceSessionCallbacks
 * @property {(text: string) => void} onTranscript
 * @property {(error: Error) => void} onError
 * @property {() => void} [onClose]
 */

/**
 * @typedef {Object} VoiceSession
 * @property {() => Promise<void>} stop
 */

/**
 * @typedef {Object} VoiceToggleKey
 * @property {number} byte
 * @property {string} label
 */

/**
 * @typedef {Object} RecorderHandle
 * @property {() => void} stop
 */

export const VOICE_DEBUG = process.env.PLAIN_VOICE_DEBUG === "1";

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

/**
 * @param {number} sampleRate
 * @returns {VoiceRecorderConfig[]}
 */
export function getRecorderCandidates(sampleRate) {
  const rate = String(sampleRate);
  const isMac = process.platform === "darwin";
  /** @type {VoiceRecorderConfig[]} */
  const candidates = [];

  if (!isMac) {
    candidates.push({
      command: "arecord",
      args: ["-q", "-f", "S16_LE", "-c", "1", "-r", rate, "-t", "raw"],
    });
  }

  candidates.push({
    command: "sox",
    args: [
      "-q",
      "-d",
      "-b",
      "16",
      "-c",
      "1",
      "-r",
      rate,
      "-e",
      "signed-integer",
      "-t",
      "raw",
      "-",
    ],
  });

  const ffmpegInput = isMac
    ? ["-f", "avfoundation", "-i", ":0"]
    : ["-f", "alsa", "-i", "default"];
  candidates.push({
    command: "ffmpeg",
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      ...ffmpegInput,
      "-ac",
      "1",
      "-ar",
      rate,
      "-f",
      "s16le",
      "-",
    ],
  });

  return candidates;
}

/**
 * @param {VoiceRecorderConfig[]} candidates
 * @returns {VoiceRecorderConfig | null}
 */
export function detectRecorder(candidates) {
  return candidates.find((c) => isCommandAvailable(c.command)) ?? null;
}

/**
 * @param {string} command
 */
export function isCommandAvailable(command) {
  if (process.platform === "win32") {
    const result = spawnSync("where", [command], { stdio: "ignore" });
    return result.status === 0;
  }
  const result = spawnSync("sh", ["-c", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

/**
 * Spawn a recorder subprocess that emits raw PCM on stdout, and wire its
 * lifecycle events to the provided callbacks. This is purely transport
 * plumbing — it knows nothing about any specific STT provider.
 *
 * @param {object} options
 * @param {VoiceRecorderConfig} options.recorder
 * @param {(chunk: Buffer) => void} options.onAudio
 * @param {(error: Error) => void} options.onError
 * @param {() => void} options.onExit - Called after the recorder subprocess exits (for any reason).
 * @returns {RecorderHandle}
 */
export function startRecorder({ recorder, onAudio, onError, onExit }) {
  const child = spawn(recorder.command, recorder.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  /** @type {string[]} */
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  child.on("error", (err) => {
    const suffix =
      /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT"
        ? ` (command "${recorder.command}" not found)`
        : "";
    onError(new Error(`Recorder failed to start${suffix}: ${err.message}`));
  });

  child.on("exit", (code, signal) => {
    if (code !== 0 && signal === null) {
      const stderrText = stderrChunks.join("").trim();
      onError(
        new Error(
          `Recorder "${recorder.command}" exited with code ${code}${
            stderrText ? `: ${stderrText}` : ""
          }`,
        ),
      );
    }
    onExit();
  });

  child.stdout.on("data", onAudio);

  return {
    stop() {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Report an error asynchronously and return an already-terminated session.
 *
 * @param {VoiceSessionCallbacks} callbacks
 * @param {Error} error
 * @returns {VoiceSession}
 */
export function failVoiceSessionAsync(callbacks, error) {
  queueMicrotask(() => {
    callbacks.onError(error);
    callbacks.onClose?.();
  });
  return { stop: async () => {} };
}

/**
 * Drop whitespace sitting between two CJK characters. Some providers return
 * Japanese transcripts with morpheme-separating spaces ("そう 、 声 で");
 * mixed strings like "Windows を使う" keep their inter-script spaces.
 *
 * @returns {{ push: (text: string) => string, flush: () => string }}
 */
export function createCJKSpaceNormalizer() {
  let prevChar = "";
  let pendingSpaces = "";
  const isSpace = (/** @type {string} */ c) =>
    c === " " || c === "\t" || c === "\u3000";

  return {
    push(text) {
      let out = "";
      for (const ch of text) {
        if (isSpace(ch)) {
          pendingSpaces += ch;
          continue;
        }
        if (pendingSpaces.length > 0) {
          if (!(isCJKChar(prevChar) && isCJKChar(ch))) {
            out += pendingSpaces;
          }
          pendingSpaces = "";
        }
        out += ch;
        prevChar = ch;
      }
      return out;
    },
    flush() {
      const out = pendingSpaces;
      pendingSpaces = "";
      prevChar = "";
      return out;
    },
  };
}

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isCJKChar(ch) {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x3000 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x2ffff)
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isObjectLike(value) {
  return typeof value === "object" && value !== null;
}
