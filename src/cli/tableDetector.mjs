import { formatMarkdownTable } from "./formatter.mjs";

/**
 * @typedef {{ output: string[], warnings: string[] }} DetectorResult
 */

/**
 * Creates a table detector for detecting and formatting markdown tables
 * in streaming text output. This is a pure logic module with no I/O side effects.
 *
 * @param {(lines: string[]) => string} [formatTable=formatMarkdownTable] - Table formatting function (injectable for testing)
 * @returns {{ feed: (chunk: string) => DetectorResult, forceFlush: () => DetectorResult }}
 */
export function createTableDetector(formatTable = formatMarkdownTable) {
  /** @type {string} - Accumulated incomplete line */
  let pendingLine = "";
  /** @type {string[]} - Lines of the current table being detected */
  const tableLines = [];
  /** @type {boolean} - Inside a code block (```) */
  let inCodeBlock = false;
  const MAX_TABLE_LINES = 200;

  /**
   * Feed a text chunk to the detector.
   * @param {string} chunk
   * @returns {DetectorResult}
   */
  function feed(chunk) {
    if (chunk.length === 0) return { output: [], warnings: [] };
    pendingLine += chunk;

    /** @type {string[]} */
    const output = [];
    /** @type {string[]} */
    const warnings = [];

    // Process complete lines (those containing newlines)
    while (pendingLine.includes("\n")) {
      const idx = pendingLine.indexOf("\n");
      const line = pendingLine.slice(0, idx); // Exclude the newline
      pendingLine = pendingLine.slice(idx + 1);
      const result = processLine(`${line}\n`); // Add newline back for output
      output.push(...result.output);
      warnings.push(...result.warnings);
    }

    // If not buffering a table and pendingLine has no pipe, output immediately
    // This ensures non-table text is streamed without delay
    if (tableLines.length === 0 && !pendingLine.includes("|")) {
      output.push(pendingLine);
      pendingLine = "";
    }

    return { output, warnings };
  }

  /**
   * Force flush any pending content (call on turn end).
   * @returns {DetectorResult}
   */
  function forceFlush() {
    /** @type {string[]} */
    const output = [];
    /** @type {string[]} */
    const warnings = [];

    // Process any remaining pending line
    if (pendingLine.length > 0) {
      // If we have a table buffer, add pending line to it or output directly
      if (tableLines.length > 0) {
        tableLines.push(`${pendingLine}\n`);
      } else {
        output.push(pendingLine);
      }
      pendingLine = "";
    }
    const flushResult = flushTable();
    output.push(...flushResult.output);
    warnings.push(...flushResult.warnings);

    return { output, warnings };
  }

  /**
   * Process a complete line.
   * @param {string} line - Line including trailing newline
   * @returns {DetectorResult}
   */
  function processLine(line) {
    /** @type {string[]} */
    const output = [];
    /** @type {string[]} */
    const warnings = [];

    // Code block detection
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      const flushResult = flushTable(); // Code block terminates any ongoing table
      output.push(...flushResult.output);
      warnings.push(...flushResult.warnings);
      output.push(line);
      return { output, warnings };
    }

    if (inCodeBlock) {
      output.push(line);
      return { output, warnings };
    }

    // Table start: line begins with pipe
    if (isTableStart(line)) {
      tableLines.push(line);

      // Buffer limit check
      if (tableLines.length > MAX_TABLE_LINES) {
        const flushResult = flushTableAsIs();
        output.push(...flushResult.output);
        warnings.push(...flushResult.warnings);
      }
      return { output, warnings };
    }

    // Table continuation: line contains pipe (for rows without leading pipe)
    if (tableLines.length > 0 && isTableContinuation(line)) {
      tableLines.push(line);
      if (tableLines.length > MAX_TABLE_LINES) {
        const flushResult = flushTableAsIs();
        output.push(...flushResult.output);
        warnings.push(...flushResult.warnings);
      }
      return { output, warnings };
    }

    // Table ended: format and flush buffer, then output current line
    const flushResult = flushTable();
    output.push(...flushResult.output);
    warnings.push(...flushResult.warnings);
    output.push(line);
    return { output, warnings };
  }

  /**
   * Flush table buffer with formatting.
   * @returns {DetectorResult}
   */
  function flushTable() {
    if (tableLines.length === 0) return { output: [], warnings: [] };

    /** @type {string[]} */
    const output = [];
    /** @type {string[]} */
    const warnings = [];

    // Separate trailing empty lines (preserve spacing after table)
    /** @type {string[]} */
    const trailingEmpty = [];
    while (tableLines.length > 0 && tableLines.at(-1)?.trim() === "") {
      const line = tableLines.pop();
      if (line !== undefined) trailingEmpty.unshift(line);
    }

    if (tableLines.length > 0) {
      // Remove trailing newlines for formatting, then add them back
      const rawLines = tableLines.map((l) =>
        l.endsWith("\n") ? l.slice(0, -1) : l,
      );
      try {
        const formatted = formatTable(rawLines);
        output.push(`${formatted}\n`);
      } catch (err) {
        // Fallback: output raw lines if formatting fails
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`Warning: Table formatting failed: ${message}`);
        for (const line of tableLines) {
          output.push(line);
        }
      }
    }

    tableLines.length = 0;

    // Output trailing empty lines
    for (const empty of trailingEmpty) {
      output.push(empty);
    }

    return { output, warnings };
  }

  /**
   * Flush table buffer without formatting (for oversized tables).
   * @returns {DetectorResult}
   */
  function flushTableAsIs() {
    if (tableLines.length === 0) return { output: [], warnings: [] };
    const output = [...tableLines];
    tableLines.length = 0;
    return { output, warnings: [] };
  }

  /**
   * Check if a line starts a table.
   * @param {string} line
   * @returns {boolean}
   */
  function isTableStart(line) {
    const trimmed = line.trimStart();
    return trimmed.startsWith("|");
  }

  /**
   * Check if a line continues a table.
   * This is a heuristic: any line containing a pipe character is considered
   * a potential table row. This may produce false positives for non-table
   * content with pipes (e.g., "Choose A | B | C").
   * @param {string} line
   * @returns {boolean}
   */
  function isTableContinuation(line) {
    return line.includes("|");
  }

  return { feed, forceFlush };
}
