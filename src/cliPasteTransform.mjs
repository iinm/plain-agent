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
  const text = input.replace(/\[pasted#([a-f0-9]{6})\]/g, (match, hash) => {
    const content = pastedContentStore.get(hash);
    if (content !== undefined) {
      pastedContentStore.delete(hash); // Clean up after use
      contexts.push(
        `<context location="pasted#${hash}">\n${content}\n</context>`,
      );
    }
    return match; // Keep placeholder in text
  });

  // Append contexts to the end of input
  if (contexts.length > 0) {
    return [text, ...contexts].join("\n\n");
  }

  return text;
}

/**
 * Create a Transform stream to handle bracketed paste before readline.
 * @param {() => void} onCtrlC - Called when Ctrl-C or Ctrl-D is detected
 * @returns {Transform}
 */
export function createPasteTransform(onCtrlC) {
  let inPasteMode = false;
  let pasteBuffer = "";

  return new Transform({
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
            // End of paste
            pasteBuffer += data.slice(0, endIdx);
            data = data.slice(endIdx + BRACKETED_PASTE_END.length);
            inPasteMode = false;

            // Handle paste content
            if (pasteBuffer) {
              // Remove trailing newline for single-line paste detection
              const trimmedPaste = pasteBuffer.replace(/\n$/, "");

              // For single-line paste, insert directly without placeholder
              if (!trimmedPaste.includes("\n")) {
                this.push(trimmedPaste);
              } else {
                // For multi-line paste, use placeholder
                const hash = generatePasteHash(pasteBuffer);
                pastedContentStore.set(hash, pasteBuffer);
                this.push(`[pasted#${hash}] `);
              }
            }
            pasteBuffer = "";
          } else {
            // Still in paste mode
            pasteBuffer += data;
            break;
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
            break;
          }
        }
      }

      callback();
    },
  });
}
