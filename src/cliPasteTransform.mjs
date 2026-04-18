import { Transform } from "node:stream";

// Bracketed paste mode sequences
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

// Time to wait for a continuation paste chunk before flushing the paste buffer.
// Some terminals split large pastes into multiple bracketed paste sequences
// (e.g. `\x1b[200~...\x1b[201~\x1b[200~...\x1b[201~`) that arrive back-to-back.
// Holding the paste briefly lets us merge them into a single placeholder.
const PASTE_MERGE_WINDOW_MS = 20;

// Paste state machine:
//   IDLE    - normal passthrough
//   PASTE   - inside a BRACKETED_PASTE_START ... BRACKETED_PASTE_END sequence
//   PENDING - just saw an END; waiting to see if the next data continues the
//             paste (another START immediately follows) or not.
/** @typedef {"IDLE" | "PASTE" | "PENDING"} PasteState */

/**
 * Generate a short hash for paste reference.
 * @param {string} content
 * @returns {string}
 */
function generatePasteHash(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(6, "0").slice(0, 6);
}

/**
 * @typedef {object} PasteHandler
 * @property {Transform} transform
 *   Transform stream to pipe stdin through. Emits placeholders for multi-line
 *   pastes and raw text for single-line pastes / typed input.
 * @property {(input: string) => string} resolvePlaceholders
 *   Given a string containing placeholders produced by `transform`, append a
 *   `<context id="pasted#HASH">...</context>` block for each referenced paste
 *   and consume the stored content. Unknown placeholders are left untouched.
 */

/**
 * Create a bracketed-paste handler. The handler owns its own content store so
 * pastes from one handler instance cannot interfere with another (and state
 * does not leak across tests).
 *
 * @param {() => void} onCtrlC - Called when Ctrl-C or Ctrl-D is detected
 * @returns {PasteHandler}
 */
export function createPasteHandler(onCtrlC) {
  /** @type {Map<string, string>} */
  const pastedContentStore = new Map();

  /** @type {PasteState} */
  let state = "IDLE";
  let pasteBuffer = "";
  /** @type {NodeJS.Timeout | null} */
  let mergeTimer = null;
  /** @type {Transform} */
  let transform;

  const clearMergeTimer = () => {
    if (mergeTimer) {
      clearTimeout(mergeTimer);
      mergeTimer = null;
    }
  };

  const flushPasteBuffer = () => {
    clearMergeTimer();
    if (pasteBuffer) {
      // Strip a trailing newline so a paste like "foo\n" is treated as single-line.
      const trimmed = pasteBuffer.replace(/\n$/, "");
      if (trimmed.includes("\n")) {
        // Multi-line: emit a placeholder and stash the content for later.
        const hash = generatePasteHash(pasteBuffer);
        pastedContentStore.set(hash, pasteBuffer);
        const lineCount = pasteBuffer.split("\n").length;
        transform.push(`[Pasted text #${hash}, ${lineCount} lines]`);
      } else {
        transform.push(trimmed);
      }
    }
    pasteBuffer = "";
    state = "IDLE";
  };

  transform = new Transform({
    transform(chunk, _encoding, callback) {
      /** @type {string} */
      let data = chunk.toString("utf8");

      // Handle Ctrl-C and Ctrl-D
      if (data.includes("\x03") || data.includes("\x04")) {
        onCtrlC();
        callback();
        return;
      }

      while (data.length > 0) {
        if (state === "PASTE") {
          const endIdx = data.indexOf(BRACKETED_PASTE_END);
          if (endIdx === -1) {
            pasteBuffer += data;
            data = "";
          } else {
            // End of (this chunk of) paste. Hold briefly in case another paste
            // chunk follows immediately and should be merged.
            pasteBuffer += data.slice(0, endIdx);
            data = data.slice(endIdx + BRACKETED_PASTE_END.length);
            state = "PENDING";
          }
        } else if (state === "PENDING") {
          if (data.startsWith(BRACKETED_PASTE_START)) {
            // Continuation of the previous paste; keep appending to pasteBuffer.
            data = data.slice(BRACKETED_PASTE_START.length);
            clearMergeTimer();
            state = "PASTE";
          } else {
            // Not a continuation; flush, then re-process this data as IDLE.
            flushPasteBuffer();
          }
        } else {
          // IDLE
          const startIdx = data.indexOf(BRACKETED_PASTE_START);
          if (startIdx === -1) {
            this.push(data);
            data = "";
          } else {
            this.push(data.slice(0, startIdx));
            data = data.slice(startIdx + BRACKETED_PASTE_START.length);
            state = "PASTE";
          }
        }
      }

      // If the chunk ended while still waiting for a possible continuation,
      // schedule a short timer to flush the pending paste if nothing arrives.
      if (state === "PENDING" && !mergeTimer) {
        mergeTimer = setTimeout(() => {
          mergeTimer = null;
          flushPasteBuffer();
        }, PASTE_MERGE_WINDOW_MS);
      }

      callback();
    },

    flush(callback) {
      if (state === "PENDING") {
        flushPasteBuffer();
      }
      callback();
    },
  });

  /**
   * @param {string} input
   * @returns {string}
   */
  const resolvePlaceholders = (input) => {
    /** @type {string[]} */
    const contexts = [];

    // Collect paste content for context tags while keeping placeholders.
    const text = input.replace(
      /\[Pasted text #([a-f0-9]{6}),/g,
      (match, hash) => {
        const content = pastedContentStore.get(hash);
        if (content !== undefined) {
          pastedContentStore.delete(hash); // Clean up after use
          contexts.push(
            `<context id="pasted#${hash}">\n${content}\n</context>`,
          );
        }
        return match; // Keep placeholder in text
      },
    );

    if (contexts.length > 0) {
      return [text, ...contexts].join("\n\n");
    }
    return text;
  };

  return { transform, resolvePlaceholders };
}
