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
          patch: {
            description: `
Format:
@@@ ${nonce} {start}-{end} HEAD=prefix of original line
new content
@@@ ${nonce}

@@@ ${nonce} {N}+
inserted content
@@@ ${nonce}

- Line numbers are 1-indexed and refer to the original file;
  "{start}-{end}" is inclusive.
- "{N}+" inserts after line N; "0+" prepends, "{lastLine}+" appends.
- Empty body deletes the range.
- HEAD is required on replace blocks and verifies the trimmed start
  line begins with the trimmed text. Use empty "HEAD=" for a blank
  line.
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
 * Parse a patch string into a list of patch blocks.
 * @param {string} patch
 * @param {string} nonce
 * @returns {PatchBlock[]}
 */
export function parseBlocks(patch, nonce) {
  const openPrefix = `@@@ ${nonce} `;
  const closeMarker = `@@@ ${nonce}`;
  const lines = patch.split("\n");

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
        `Unexpected close marker "${closeMarker}" with no matching open block (line ${i + 1} of patch).`,
      );
    }
    if (!line.startsWith(openPrefix)) {
      throw new Error(
        `Expected block header starting with "${openPrefix}" but got: ${JSON.stringify(line)} (line ${i + 1} of patch).`,
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
      const actual = lines[block.start - 1];
      const actualTrimmed = (actual ?? "").trim();
      // HEAD is already trimmed in parseHeaderArgs.
      if (block.head === "") {
        if (actualTrimmed !== "") {
          throw new Error(
            `HEAD verification failed at line ${block.start}: expected a blank line (empty HEAD=) but got ${JSON.stringify(actualTrimmed)}. The line numbers may be stale; re-read the file with read_file.`,
          );
        }
      } else if (!actualTrimmed.startsWith(block.head)) {
        throw new Error(
          `HEAD verification failed at line ${block.start}: expected line to start with ${JSON.stringify(block.head)} (trimmed) but got ${JSON.stringify(actualTrimmed)}. The line numbers may be stale; re-read the file with read_file.`,
        );
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
 * @returns {{ op: "replace"; start: number; end: number; head: string } | { op: "insert"; after: number }}
 */
function parseHeaderArgs(headerArgs) {
  // Replace form: "{start}-{end} HEAD=...". HEAD is required so the
  // applied edit always re-confirms the targeted line. The HEAD value
  // is unquoted and runs to end of line; we trim it later. An empty
  // HEAD value is allowed and means "expect a blank/whitespace-only
  // line at {start}".
  const replaceMatch = headerArgs.match(/^(\d+)-(\d+)\s+HEAD=(.*)$/);
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
    const head = replaceMatch[3].trim();
    return { op: "replace", start, end, head };
  }
  // Reject replace form without HEAD with a clear message before falling
  // through to the generic error.
  if (/^\d+-\d+\s*$/.test(headerArgs)) {
    throw new Error(
      `Replace block "${headerArgs}" is missing the required HEAD= clause. ` +
        `Append " HEAD=<prefix of original line {start}>" (use empty value for a blank line).`,
    );
  }
  const insertMatch = headerArgs.match(/^(\d+)\+\s*$/);
  if (insertMatch) {
    return { op: "insert", after: Number(insertMatch[1]) };
  }
  throw new Error(
    `Invalid block header arguments: ${JSON.stringify(headerArgs)}. Expected "{start}-{end} HEAD=..." or "{N}+".`,
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
