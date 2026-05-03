/**
 * @import { Tool } from '../tool'
 * @import { PatchBlock, PatchFileInput } from './patchFile'
 */

import fs from "node:fs/promises";
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
      description:
        "Modify a file by replacing or inserting content addressed by line numbers (1-indexed).",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
          },
          diff: {
            description: `
Format:
@@@ ${nonce} {start}-{end}
new content
@@@ ${nonce}

@@@ ${nonce} {N}+
inserted content
@@@ ${nonce}

- Line numbers are 1-indexed; "{start}-{end}" is inclusive and refers to
  the original file (not the file after earlier blocks).
- "{N}+" inserts after line N; "0+" prepends, "{lastLine}+" appends.
- Empty body deletes the range.
- Overlapping blocks are rejected.
- Optional "HEAD=text" (no quotes, runs to end of line) on the open marker
  verifies that the trimmed line {start} starts with the trimmed text.
            `.trim(),
            type: "string",
          },
        },
        required: ["filePath", "diff"],
      },
    },

    /**
     * @param {PatchFileInput} input
     * @returns {Promise<string | Error>}
     */
    impl: async (input) =>
      await noThrow(async () => {
        const { filePath, diff } = input;
        const blocks = parseBlocks(diff, nonce);
        if (blocks.length === 0) {
          throw new Error(
            `No patch blocks found. Each block must start with "@@@ ${nonce} ..." and end with "@@@ ${nonce}".`,
          );
        }

        const original = await fs.readFile(filePath, "utf8");
        const newContent = applyBlocks(original, blocks);
        await fs.writeFile(filePath, newContent);
        return `Patched file: ${filePath}`;
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
 * Parse a diff string into a list of patch blocks.
 * @param {string} diff
 * @param {string} nonce
 * @returns {PatchBlock[]}
 */
export function parseBlocks(diff, nonce) {
  const openPrefix = `@@@ ${nonce} `;
  const closeMarker = `@@@ ${nonce}`;
  const lines = diff.split("\n");

  /** @type {PatchBlock[]} */
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === "") {
      i++;
      continue;
    }
    if (line === closeMarker) {
      throw new Error(
        `Unexpected close marker "${closeMarker}" with no matching open block (line ${i + 1} of diff).`,
      );
    }
    if (!line.startsWith(openPrefix)) {
      throw new Error(
        `Expected block header starting with "${openPrefix}" but got: ${JSON.stringify(line)} (line ${i + 1} of diff).`,
      );
    }
    const headerArgs = line.slice(openPrefix.length);
    const block = parseHeaderArgs(headerArgs);
    i++;

    /** @type {string[]} */
    const body = [];
    let foundClose = false;
    while (i < lines.length) {
      if (lines[i] === closeMarker) {
        foundClose = true;
        i++;
        break;
      }
      body.push(lines[i]);
      i++;
    }
    if (!foundClose) {
      throw new Error(
        `Missing close marker "${closeMarker}" for block "${openPrefix}${headerArgs}".`,
      );
    }
    if (block.op === "insert" && body.length === 0) {
      throw new Error(
        `Insert block "${openPrefix}${headerArgs}" has empty body. Use a replace block to delete content.`,
      );
    }
    blocks.push({ ...block, body });
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
      if (block.head !== undefined) {
        const actual = lines[block.start - 1];
        const actualTrimmed = (actual ?? "").trim();
        const headTrimmed = block.head.trim();
        if (!actualTrimmed.startsWith(headTrimmed)) {
          throw new Error(
            `HEAD verification failed at line ${block.start}: expected line to start with ${JSON.stringify(headTrimmed)} (trimmed) but got ${JSON.stringify(actualTrimmed)}. The line numbers may be stale; re-read the file with read_file.`,
          );
        }
      }
      const removeCount = block.end - block.start + 1;
      lines.splice(block.start - 1, removeCount, ...block.body);
    } else {
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
 * @returns {{ op: "replace"; start: number; end: number; head?: string } | { op: "insert"; after: number }}
 */
function parseHeaderArgs(headerArgs) {
  // Replace form: "{start}-{end}" optionally followed by " HEAD=...".
  // The HEAD value is unquoted and runs to end of line; we trim it later.
  const replaceMatch = headerArgs.match(/^(\d+)-(\d+)(?:\s+HEAD=(.*))?$/);
  if (replaceMatch) {
    const start = Number(replaceMatch[1]);
    const end = Number(replaceMatch[2]);
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
    const headRaw = replaceMatch[3];
    if (headRaw !== undefined) {
      const head = headRaw.trim();
      if (head === "") {
        throw new Error(
          `HEAD= value is empty in "${headerArgs}". Drop the HEAD= clause if no staleness check is intended.`,
        );
      }
      return { op: "replace", start, end, head };
    }
    return { op: "replace", start, end };
  }
  const insertMatch = headerArgs.match(/^(\d+)\+\s*$/);
  if (insertMatch) {
    return { op: "insert", after: Number(insertMatch[1]) };
  }
  throw new Error(
    `Invalid block header arguments: ${JSON.stringify(headerArgs)}. Expected "{start}-{end}" or "{N}+".`,
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
      if (block.end > totalLines) {
        throw new Error(
          `Replace range ${block.start}-${block.end} extends past end of file (${totalLines} lines).`,
        );
      }
    } else if (block.after < 0 || block.after > totalLines) {
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
        if (b.after >= a.start && b.after < a.end) {
          throw new Error(
            `Insert at ${b.after}+ falls inside replace range ${a.start}-${a.end}.`,
          );
        }
      } else if (a.op === "insert" && b.op === "replace") {
        if (a.after >= b.start && a.after < b.end) {
          throw new Error(
            `Insert at ${a.after}+ falls inside replace range ${b.start}-${b.end}.`,
          );
        }
      }
    }
  }
}
