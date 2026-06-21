/**
 * @import { Readable, Writable } from "node:stream"
 */

import WIDE_RANGES from "./eastAsianWideRanges.json" with { type: "json" };

/**
 * @typedef {Object} TabContext
 * @property {string} line - Current input line text
 * @property {number} cursor - Cursor position (character index, 0-based)
 * @property {string} prompt - Current prompt string
 * @property {(line: string, cursor?: number) => void} updateLine - Replace the input line
 * @property {() => void} render - Redraw the last prompt line and current input
 */

/**
 * @typedef {Object} LineEditorOptions
 * @property {Readable} input - Input stream (after transform pipeline)
 * @property {Writable & { columns?: number, isTTY?: boolean }} output - Output stream
 * @property {string} prompt - Initial prompt string
 * @property {(line: string) => void} onLine - Called when Enter is pressed
 * @property {() => void} onClose - Called when the input stream ends
 * @property {((ctx: TabContext) => void)} [onTab] - Called when Tab is pressed
 */

/**
 * @typedef {Object} LineEditor
 * @property {(prompt: string) => void} setPrompt
 * @property {() => void} render - Display the full prompt and current input
 * @property {() => string} getPrompt
 * @property {() => string} getLine
 * @property {() => void} clearLine - Clear input buffer and reset cursor
 * @property {(suppress: boolean) => void} setSuppressRefresh
 * @property {() => void} close - Remove listeners
 */

/**
 * Create a custom line editor that replaces readline.Interface.
 *
 * Reads raw keypress data from {@link input}, maintains a single-line input
 * buffer with cursor, and calls {@link onLine} on Enter.
 *
 * @param {LineEditorOptions} options
 * @returns {LineEditor}
 */
export function createLineEditor({
  input,
  output,
  prompt,
  onLine,
  onClose,
  onTab,
}) {
  let currentPrompt = prompt;
  let line = "";
  let cursor = 0;
  let suppressRefresh = false;

  // Whether the prompt area is currently displayed and editable.
  // When true, render() clears the previous prompt area before redrawing.
  // Set to false after Enter (the prompt area is committed to scrollback).
  let active = false;
  let renderedHeight = 0;

  /** Last line of the prompt (the editable line shown next to user input). */
  function getLastPromptLine() {
    const idx = currentPrompt.lastIndexOf("\n");
    return idx === -1 ? currentPrompt : currentPrompt.slice(idx + 1);
  }

  /** Clear the current terminal line and redraw last-prompt-line + input. */
  function refreshLine() {
    if (suppressRefresh) return;
    const lastLine = getLastPromptLine();
    const chars = [...line];
    const beforeCursor = chars.slice(0, cursor).join("");
    const cursorCol =
      charDisplayWidth(lastLine) + charDisplayWidth(beforeCursor);

    output.write("\r\x1b[2K");
    output.write(lastLine + line);
    output.write(`\r\x1b[${cursorCol + 1}G`);
  }

  /**
   * Full render: optionally clear the previous prompt area, then write the
   * entire prompt string and current input.
   */
  function render() {
    if (active && renderedHeight > 0) {
      if (renderedHeight > 1) {
        output.write(`\x1b[${renderedHeight - 1}A`);
      }
      output.write("\r\x1b[J");
    }

    output.write(currentPrompt + line);

    renderedHeight = (currentPrompt + line).split("\n").length;

    const lastLine = getLastPromptLine();
    const chars = [...line];
    const beforeCursor = chars.slice(0, cursor).join("");
    const cursorCol =
      charDisplayWidth(lastLine) + charDisplayWidth(beforeCursor);
    output.write(`\r\x1b[${cursorCol + 1}G`);

    active = true;
  }

  /** @param {Buffer} chunk */
  function handleData(chunk) {
    const data = chunk.toString("utf8");
    let i = 0;
    let dirty = false;

    while (i < data.length) {
      const code = data.charCodeAt(i);

      // --- Escape / CSI sequence ---
      if (code === 0x1b) {
        const result = handleEscapeSequence(data, i);
        if (result.changed) dirty = true;
        i = result.end;
        continue;
      }

      // --- Enter ---
      if (code === 0x0d || code === 0x0a) {
        if (dirty) {
          refreshLine();
          dirty = false;
        }
        const currentLine = line;
        line = "";
        cursor = 0;
        active = false;
        renderedHeight = 0;
        output.write("\n");
        onLine(currentLine);
        i++;
        continue;
      }

      // --- Backspace ---
      if (code === 0x7f || code === 0x08) {
        if (cursor > 0) {
          const chars = [...line];
          chars.splice(cursor - 1, 1);
          line = chars.join("");
          cursor--;
          dirty = true;
        }
        i++;
        continue;
      }

      // --- Tab ---
      if (code === 0x09) {
        if (dirty) {
          refreshLine();
          dirty = false;
        }
        if (onTab) {
          onTab({
            line,
            cursor,
            prompt: currentPrompt,
            updateLine: (newLine, newCursor) => {
              line = newLine;
              cursor = newCursor ?? [...newLine].length;
            },
            render: () => refreshLine(),
          });
        }
        i++;
        continue;
      }

      // --- Ctrl-A  move to start ---
      if (code === 0x01) {
        if (cursor !== 0) {
          cursor = 0;
          dirty = true;
        }
        i++;
        continue;
      }

      // --- Ctrl-E  move to end ---
      if (code === 0x05) {
        const len = [...line].length;
        if (cursor !== len) {
          cursor = len;
          dirty = true;
        }
        i++;
        continue;
      }

      // --- Ctrl-K  kill to end ---
      if (code === 0x0b) {
        const chars = [...line];
        if (cursor < chars.length) {
          line = chars.slice(0, cursor).join("");
          dirty = true;
        }
        i++;
        continue;
      }

      // --- Ctrl-U  kill to start ---
      if (code === 0x15) {
        if (cursor > 0) {
          const chars = [...line];
          line = chars.slice(cursor).join("");
          cursor = 0;
          dirty = true;
        }
        i++;
        continue;
      }

      // --- Ctrl-W  kill word backwards ---
      if (code === 0x17) {
        if (cursor > 0) {
          const chars = [...line];
          let pos = cursor;
          while (pos > 0 && chars[pos - 1] === " ") pos--;
          while (pos > 0 && chars[pos - 1] !== " ") pos--;
          chars.splice(pos, cursor - pos);
          line = chars.join("");
          cursor = pos;
          dirty = true;
        }
        i++;
        continue;
      }

      // --- Printable character (>= 0x20) ---
      if (code >= 0x20) {
        const cp = /** @type {number} */ (data.codePointAt(i));
        const ch = String.fromCodePoint(cp);
        const chars = [...line];
        chars.splice(cursor, 0, ch);
        line = chars.join("");
        cursor++;
        dirty = true;
        i += ch.length; // 1 for BMP, 2 for supplementary plane
        continue;
      }

      // Skip unhandled control characters
      i++;
    }

    if (dirty) {
      refreshLine();
    }
  }

  /**
   * Parse and handle a CSI escape sequence.
   * @param {string} data
   * @param {number} start - Index of the ESC byte
   * @returns {{ end: number, changed: boolean }}
   */
  function handleEscapeSequence(data, start) {
    if (start + 1 >= data.length || data[start + 1] !== "[") {
      return { end: start + 1, changed: false };
    }

    let i = start + 2;
    while (
      i < data.length &&
      data.charCodeAt(i) >= 0x30 &&
      data.charCodeAt(i) <= 0x3f
    ) {
      i++;
    }
    while (
      i < data.length &&
      data.charCodeAt(i) >= 0x20 &&
      data.charCodeAt(i) <= 0x2f
    ) {
      i++;
    }
    if (i >= data.length) {
      return { end: i, changed: false };
    }

    const finalByte = data[i];
    const params = data.slice(start + 2, i);
    i++;

    let changed = false;
    const chars = [...line];

    switch (finalByte) {
      case "C":
        if (cursor < chars.length) {
          cursor++;
          changed = true;
        }
        break;
      case "D":
        if (cursor > 0) {
          cursor--;
          changed = true;
        }
        break;
      case "H":
        if (cursor !== 0) {
          cursor = 0;
          changed = true;
        }
        break;
      case "F":
        if (cursor !== chars.length) {
          cursor = chars.length;
          changed = true;
        }
        break;
      case "~":
        if (params === "3" && cursor < chars.length) {
          chars.splice(cursor, 1);
          line = chars.join("");
          changed = true;
        }
        break;
    }

    return { end: i, changed };
  }

  input.on("data", handleData);
  input.on("end", onClose);

  /** @type {(() => void) | undefined} */
  let removeResizeListener;
  if (output.isTTY) {
    const onResize = () => {
      if (!suppressRefresh && active) {
        refreshLine();
      }
    };
    output.on("resize", onResize);
    removeResizeListener = () => output.removeListener("resize", onResize);
  }

  return {
    setPrompt: (/** @type {string} */ p) => {
      currentPrompt = p;
    },
    render,
    getPrompt: () => currentPrompt,
    getLine: () => line,
    clearLine: () => {
      line = "";
      cursor = 0;
    },
    setSuppressRefresh: (/** @type {boolean} */ suppress) => {
      suppressRefresh = suppress;
    },
    close: () => {
      input.removeListener("data", handleData);
      input.removeListener("end", onClose);
      removeResizeListener?.();
    },
  };
}

// ---------------------------------------------------------------------------
// Display-width helpers (function declarations are hoisted above the export)
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape code pattern
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/**
 * @param {number} code
 * @returns {boolean}
 */
function isWideChar(code) {
  let lo = 0;
  let hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [start, end] = WIDE_RANGES[mid];
    if (code < start) hi = mid - 1;
    else if (code > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * @param {string} str
 * @returns {string}
 */
function stripAnsiCodes(str) {
  return str.replace(ANSI_RE, "");
}

/**
 * @param {string} str
 * @returns {number}
 */
function charDisplayWidth(str) {
  const plain = stripAnsiCodes(str);
  let width = 0;
  for (const ch of plain) {
    const code = /** @type {number} */ (ch.codePointAt(0));
    width += isWideChar(code) ? 2 : 1;
  }
  return width;
}
