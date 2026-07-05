/**
 * @import { Tool } from '../tool'
 * @import { PatchBlock, PatchFileInput } from './patchFile'
 */

import fs from "node:fs/promises";
import { diffLines } from "../utils/diffLines.mjs";
import { lineHash } from "../utils/lineHash.mjs";
import { noThrow } from "../utils/noThrow.mjs";

/**
 * @param {string} [nonce]
 * @returns {Tool}
 */
export function createPatchFileTool(
  nonce = Math.random().toString(36).substring(2, 5),
) {
  return {
    def: {
      name: "patch_file",
      description: `Modify a file by replacing or inserting content.
When editing multiple locations in the same file, include all blocks in a single patch string rather than making multiple separate calls.
      `.trim(),
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
          },
          patch: {
            description: `
Format — a single patch string may contain multiple blocks:
REPLACE ${nonce} {start}:{startHash}-{end}:{endHash}
replacement for lines {start}-{end}
REPLACE ${nonce} {N}:{hash}
replace just that one line
REPLACE ${nonce} {start}:{startHash}-{end}:{endHash}
(empty body deletes the range)
INSERT_AFTER ${nonce} {N}:{afterHash}
new content after line N
INSERT_AFTER ${nonce} 0
content at beginning of file

- Each block's content starts right after its header line and ends at the next header or the end of the string. Any blank lines between the header and the content become part of the replacement.
- The nonce "${nonce}" is constant; always use the exact value shown above.
- Hashes are 2-character hex hashes of each line's full content as shown by read_file.
            `.trim(),
            type: "string",
          },
        },
        required: ["filePath", "patch"],
      },
    },

    /**
     * @param {PatchFileInput} input
     * @returns {Promise<string | Error>}
     */
    impl: async (input) =>
      await noThrow(async () => {
        const { filePath, patch } = input;
        const blocks = parseBlocks(patch, nonce);
        if (blocks.length === 0) {
          throw new Error(
            `No patch blocks found. Each block must start with "REPLACE ${nonce} ..." or "INSERT_AFTER ${nonce} ...".`,
          );
        }

        const original = await fs.readFile(filePath, "utf8");
        const newContent = applyBlocks(original, blocks);
        await fs.writeFile(filePath, newContent);

        const diff = formatDiff(
          diffLines(splitLines(original), splitLines(newContent)),
        );
        return `Patched file: ${filePath}\n${diff}`;
      }),

    /**
     * @param {Record<string, unknown>} input
     * @returns {Record<string, unknown>}
     */
    maskApprovalInput: (input) => {
      const patchFileInput = /** @type {PatchFileInput} */ (input);
      return {
        filePath: patchFileInput.filePath,
      };
    },
  };
}

/**
 * Parse a patch string into a list of patch blocks.
 * @param {string} patch
 * @param {string} nonce
 * @returns {PatchBlock[]}
 */
export function parseBlocks(patch, nonce) {
  const replacePrefix = `REPLACE ${nonce} `;
  const insertPrefix = `INSERT_AFTER ${nonce} `;
  const lines = patch.split("\n");
  // Drop trailing empty element produced by split() when patch ends with \n.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  // Find all header line indices
  /** @type {number[]} */
  const headerIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i].startsWith(replacePrefix) ||
      lines[i].startsWith(insertPrefix)
    ) {
      headerIndices.push(i);
    }
  }

  if (headerIndices.length === 0) {
    throw new Error(
      `No patch blocks found. Each block must start with "REPLACE ${nonce} ..." or "INSERT_AFTER ${nonce} ...".`,
    );
  }

  /** @type {PatchBlock[]} */
  const blocks = [];
  for (let i = 0; i < headerIndices.length; i++) {
    const headerLineIdx = headerIndices[i];
    const headerLine = lines[headerLineIdx];

    /** @type {"replace" | "insert"} */
    let op;
    let headerArgs;
    if (headerLine.startsWith(replacePrefix)) {
      op = "replace";
      headerArgs = headerLine.slice(replacePrefix.length);
    } else {
      op = "insert";
      headerArgs = headerLine.slice(insertPrefix.length);
    }

    const header = parseHeaderArgs(headerArgs, op);

    // Body: from the line after the header to the line before the next header (or EOF)
    const bodyStart = headerLineIdx + 1;
    const bodyEnd =
      i + 1 < headerIndices.length ? headerIndices[i + 1] : lines.length;
    const body = lines.slice(bodyStart, bodyEnd);

    if (op === "insert" && body.length === 0) {
      throw new Error(
        "Insert block has empty body. Use a replace block to delete content.",
      );
    }
    blocks.push({ ...header, body });
  }
  return blocks;
}

/**
 * @param {string} original
 * @param {PatchBlock[]} blocks
 * @returns {string}
 */
export function applyBlocks(original, blocks) {
  const hasTrailingNewline = original.endsWith("\n");
  const lines = original.split("\n");
  // Drop the trailing empty element produced by split() for both
  // newline-terminated content and an empty input. This keeps line counts
  // consistent with read_file (an empty file reports 0 lines).
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const totalLines = lines.length;

  validateBlocks(blocks, totalLines);
  detectConflicts(blocks);

  // Sort for bottom-up application.
  // - Higher splice index first.
  // - Tie: replace before insert (replace must run first so insert can
  //   land at the same splice position post-replace).
  // - Tie among inserts at the same point: later-in-source first, so the
  //   first-in-source block ends up topmost in the inserted stack.
  const indexed = blocks.map((block, sourceIdx) => ({
    block,
    sourceIdx,
    spliceIndex: spliceIndexOf(block),
  }));
  indexed.sort((a, b) => {
    if (a.spliceIndex !== b.spliceIndex) {
      return b.spliceIndex - a.spliceIndex;
    }
    if (a.block.op !== b.block.op) {
      return a.block.op === "replace" ? -1 : 1;
    }
    return b.sourceIdx - a.sourceIdx;
  });

  for (const { block } of indexed) {
    if (block.op === "replace") {
      const end = block.end;
      const actualStart = lines[block.start - 1];
      const expectedStartHash = block.startHash;
      const actualStartHash = lineHash(actualStart ?? "");
      if (actualStartHash !== expectedStartHash) {
        throw new Error(
          `Hash verification failed at line ${block.start}: expected hash ${expectedStartHash} but got ${actualStartHash} for line ${JSON.stringify(actualStart)}. The line numbers may be stale; re-read the file with read_file.`,
        );
      }
      const actualEnd = lines[end - 1];
      const expectedEndHash = block.endHash;
      const actualEndHash = lineHash(actualEnd ?? "");
      if (actualEndHash !== expectedEndHash) {
        throw new Error(
          `Hash verification failed at line ${end}: expected hash ${expectedEndHash} but got ${actualEndHash} for line ${JSON.stringify(actualEnd)}. The line numbers may be stale; re-read the file with read_file.`,
        );
      }
      const removeCount = end - block.start + 1;
      lines.splice(block.start - 1, removeCount, ...block.body);
    } else {
      if (block.after > 0) {
        const actualAfter = lines[block.after - 1];
        const expectedAfterHash = block.afterHash;
        const actualAfterHash = lineHash(actualAfter ?? "");
        if (actualAfterHash !== expectedAfterHash) {
          throw new Error(
            `Hash verification failed at line ${block.after}: expected hash ${expectedAfterHash} but got ${actualAfterHash} for line ${JSON.stringify(actualAfter)}. The line numbers may be stale; re-read the file with read_file.`,
          );
        }
      }
      lines.splice(block.after, 0, ...block.body);
    }
  }

  let result = lines.join("\n");
  if (hasTrailingNewline) {
    result += "\n";
  }
  return result;
}

/**
 * @param {string} headerArgs
 * @param {"replace" | "insert"} op
 * @returns {{ op: "replace"; start: number; end: number; startHash: string; endHash: string } | { op: "insert"; after: number; afterHash: string }}
 */
function parseHeaderArgs(headerArgs, op) {
  if (op === "replace") {
    // Replace form: "{start}:{startHash}-{end}:{endHash}"
    const rangeMatch = headerArgs.match(
      /^(\d+):([a-f0-9]{2})-(\d+):([a-f0-9]{2})\s*$/,
    );

    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[3]);
      if (start < 1) {
        throw new Error(
          `Invalid replace range "${headerArgs}": start must be >= 1.`,
        );
      }
      if (end < start) {
        throw new Error(
          `Invalid replace range "${headerArgs}": end (${end}) must be >= start (${start}).`,
        );
      }
      return {
        op: "replace",
        start,
        end,
        startHash: rangeMatch[2],
        endHash: rangeMatch[4],
      };
    }

    // Replace form: "{N}:{hash}" (single line replace — shorthand for N:hash-N:hash)
    const singleMatch = headerArgs.match(/^(\d+):([a-f0-9]{2})\s*$/);
    if (singleMatch) {
      const start = Number(singleMatch[1]);
      if (start < 1) {
        throw new Error(
          `Invalid replace range "${headerArgs}": start must be >= 1.`,
        );
      }
      return {
        op: "replace",
        start,
        end: start,
        startHash: singleMatch[2],
        endHash: singleMatch[2],
      };
    }

    throw new Error(
      `Invalid replace header arguments: ${JSON.stringify(headerArgs)}. Expected "{start}:{startHash}-{end}:{endHash}" or "{N}:{hash}".`,
    );
  }

  // op === "insert"
  // Insert form: "0" (no hash — there is no line 0 to verify)
  if (/^0\s*$/.test(headerArgs)) {
    return { op: "insert", after: 0, afterHash: "" };
  }

  // Insert form: "{N}:{afterHash}"
  const insertMatch = headerArgs.match(/^(\d+):([a-f0-9]{2})\s*$/);

  if (insertMatch) {
    return {
      op: "insert",
      after: Number(insertMatch[1]),
      afterHash: insertMatch[2],
    };
  }

  throw new Error(
    `Invalid insert header arguments: ${JSON.stringify(headerArgs)}. Expected "{N}:{afterHash}" or "0".`,
  );
}

/**
 * @param {PatchBlock} block
 * @returns {number}
 */
function spliceIndexOf(block) {
  return block.op === "replace" ? block.start - 1 : block.after;
}

/**
 * @param {PatchBlock[]} blocks
 * @param {number} totalLines
 */
function validateBlocks(blocks, totalLines) {
  for (const block of blocks) {
    if (block.op === "replace") {
      // Both bounds must be within [1, totalLines]. The two checks are NOT
      // redundant: totalLines < end is false even if start > totalLines
      // (e.g. start=1 on an empty file).
      if (block.start > totalLines || totalLines < block.end) {
        throw new Error(
          `Replace range ${block.start}-${block.end} extends past end of file (${totalLines} lines).`,
        );
      }
    } else if (block.after < 0 || totalLines < block.after) {
      throw new Error(
        `Insert position ${block.after}+ is outside [0, ${totalLines}].`,
      );
    }
  }
}

/**
 * @param {PatchBlock[]} blocks
 */
function detectConflicts(blocks) {
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i];
      const b = blocks[j];
      if (a.op === "replace" && b.op === "replace") {
        if (a.start <= b.end && b.start <= a.end) {
          throw new Error(
            `Replace ranges overlap: ${a.start}-${a.end} and ${b.start}-${b.end}.`,
          );
        }
      } else if (a.op === "replace" && b.op === "insert") {
        if (a.start <= b.after && b.after < a.end) {
          throw new Error(
            `Insert at ${b.after}+ falls inside replace range ${a.start}-${a.end}.`,
          );
        }
      } else if (a.op === "insert" && b.op === "replace") {
        if (b.start <= a.after && a.after < b.end) {
          throw new Error(
            `Insert at ${a.after}+ falls inside replace range ${b.start}-${b.end}.`,
          );
        }
      }
    }
  }
}

// Number of unchanged context lines kept around each change hunk.
const DIFF_CONTEXT_LINES = 3;
// Upper bound on rendered diff lines to keep tool results compact.
const DIFF_MAX_LINES = 80;

/**
 * Split file content into lines the same way applyBlocks does: drop the
 * trailing empty element produced by split() when the content ends with a
 * newline (or is empty), so line numbers match read_file.
 * @param {string} content
 * @returns {string[]}
 */
function splitLines(content) {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Format a line-diff into a compact, unified-diff-like string with line
 * numbers. Only lines within DIFF_CONTEXT_LINES of a change are shown; longer
 * runs of unchanged context are collapsed to a "..." marker, and the total
 * number of rendered lines is capped at DIFF_MAX_LINES.
 * @param {ReturnType<typeof diffLines>} ops
 * @returns {string}
 */
function formatDiff(ops) {
  if (!ops.some((op) => op.type !== " ")) {
    return "(no changes)";
  }

  // Mark each change plus DIFF_CONTEXT_LINES of context on either side.
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== " ") {
      const from = Math.max(0, i - DIFF_CONTEXT_LINES);
      const to = Math.min(ops.length - 1, i + DIFF_CONTEXT_LINES);
      for (let j = from; j <= to; j++) {
        keep[j] = true;
      }
    }
  }

  /** @type {string[]} */
  const out = [];
  let oldNo = 0;
  let newNo = 0;
  let collapsed = false;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === "-") {
      oldNo += 1;
    } else if (op.type === "+") {
      newNo += 1;
    } else {
      oldNo += 1;
      newNo += 1;
    }

    if (!keep[i]) {
      if (!collapsed) {
        out.push("  ...");
        collapsed = true;
      }
      continue;
    }
    collapsed = false;

    const lineNo = op.type === "-" ? oldNo : newNo;
    out.push(`${op.type} ${lineNo} | ${op.line}`);
  }

  if (out.length > DIFF_MAX_LINES) {
    const omitted = out.length - DIFF_MAX_LINES;
    out.length = DIFF_MAX_LINES;
    out.push(`  ... (${omitted} more diff lines omitted)`);
  }

  return out.join("\n");
}
