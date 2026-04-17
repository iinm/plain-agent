import { Transform } from "node:stream";

// Bracketed paste mode sequences
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

// Store for pasted content
const pastedContentStore = new Map();

/**
 * Generate a short hash for paste reference
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
 * Resolve paste placeholders and append context tags
 * @param {string} input
 * @returns {string}
 */
export function resolvePastePlaceholders(input) {
  /** @type {string[]} */
  const contexts = [];

  // Collect paste content for context tags while keeping placeholders
  const text = input.replace(
    /\[Pasted text #([a-f0-9]{6}),/g,
    (match, hash) => {
      const content = pastedContentStore.get(hash);
      if (content !== undefined) {
        pastedContentStore.delete(hash); // Clean up after use
        contexts.push(`<context id="pasted#${hash}">\n${content}\n</context>`);
      }
      return match; // Keep placeholder in text
    },
  );

  // Append contexts to the end of input
  if (contexts.length > 0) {
    return [text, ...contexts].join("\n\n");
  }

  return text;
}

// Time to wait for a continuation paste chunk before flushing the paste buffer.
// Some terminals split large pastes into multiple bracketed paste sequences
// (e.g. `\x1b[200~...\x1b[201~\x1b[200~...\x1b[201~`) that arrive back-to-back.
// Holding the paste briefly lets us merge them into a single placeholder.
const PASTE_MERGE_WINDOW_MS = 20;

/**
 * Create a Transform stream to handle bracketed paste before readline.
 * @param {() => void} onCtrlC - Called when Ctrl-C or Ctrl-D is detected
 * @returns {Transform}
 */
export function createPasteTransform(onCtrlC) {
  let inPasteMode = false;
  let pasteBuffer = "";
  // True when a paste just ended and we are waiting to see if the next data
  // continues it (i.e. starts with another BRACKETED_PASTE_START).
  let awaitingMerge = false;
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

  const flushPaste = () => {
    clearMergeTimer();
    awaitingMerge = false;
    if (pasteBuffer) {
      // Remove trailing newline for single-line paste detection
      const trimmedPaste = pasteBuffer.replace(/\n$/, "");

      // For single-line paste, insert directly without placeholder
      if (!trimmedPaste.includes("\n")) {
        transform.push(trimmedPaste);
      } else {
        // For multi-line paste, use placeholder
        const hash = generatePasteHash(pasteBuffer);
        pastedContentStore.set(hash, pasteBuffer);
        const lines = pasteBuffer.split("\n");
        transform.push(`[Pasted text #${hash}, ${lines.length} lines]`);
      }
    }
    pasteBuffer = "";
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
        if (inPasteMode) {
          const endIdx = data.indexOf(BRACKETED_PASTE_END);
          if (endIdx !== -1) {
            // End of (this chunk of) paste. Hold the buffer briefly in case
            // another paste chunk follows immediately and should be merged.
            pasteBuffer += data.slice(0, endIdx);
            data = data.slice(endIdx + BRACKETED_PASTE_END.length);
            inPasteMode = false;
            awaitingMerge = true;
          } else {
            // Still in paste mode
            pasteBuffer += data;
            data = "";
          }
        } else if (awaitingMerge) {
          // If the next data starts with another paste start marker, treat it
          // as a continuation of the previous paste and merge.
          if (data.startsWith(BRACKETED_PASTE_START)) {
            data = data.slice(BRACKETED_PASTE_START.length);
            inPasteMode = true;
            awaitingMerge = false;
            clearMergeTimer();
          } else {
            // Not a continuation; flush pending paste, then process this data.
            flushPaste();
          }
        } else {
          const startIdx = data.indexOf(BRACKETED_PASTE_START);
          if (startIdx !== -1) {
            // Start of paste
            // Output any data before the paste
            if (startIdx > 0) {
              this.push(data.slice(0, startIdx));
            }
            data = data.slice(startIdx + BRACKETED_PASTE_START.length);
            inPasteMode = true;
            pasteBuffer = "";
          } else {
            // Normal data
            this.push(data);
            data = "";
          }
        }
      }

      // If the chunk ended while still awaiting a continuation, schedule a
      // short timer to flush the pending paste if nothing else arrives.
      if (awaitingMerge && !mergeTimer) {
        mergeTimer = setTimeout(() => {
          mergeTimer = null;
          flushPaste();
        }, PASTE_MERGE_WINDOW_MS);
      }

      callback();
    },

    flush(callback) {
      if (awaitingMerge) {
        flushPaste();
      }
      callback();
    },
  });

  return transform;
}
