/**
 * @import { Tool } from '../tool'
 * @import { PatchBlock, PatchFileInput } from './patchFile'
 */

import fs from "node:fs/promises";
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
@@@ ${nonce} {start}:{startHash}-{end}:{endHash}
new content
@@@ ${nonce}

@@@ ${nonce} {N}:{afterHash}+
inserted content
@@@ ${nonce}

@@@ ${nonce} 0+
prepended content
@@@ ${nonce}

- The nonce "${nonce}" is constant; always use the exact value shown above.
- Line numbers are 1-indexed and refer to the original file; "{start}-{end}" is inclusive.
- Hashes are 2-character hex hashes of each line's full content as shown by read_file (e.g. "a3").
- "{N}:{afterHash}+" inserts after line N; "0+" prepends (no hash needed). "{lastLine}:{hash}+" appends.
- An empty body deletes the range.
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
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") {
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
    const header = parseHeaderArgs(headerArgs);
    const closeIdx = lines.indexOf(closeMarker, i + 1);
    if (closeIdx === -1) {
      throw new Error(
        `Missing close marker "${closeMarker}" for block "${openPrefix}${headerArgs}".`,
      );
    }
    const body = lines.slice(i + 1, closeIdx);
    if (header.op === "insert" && body.length === 0) {
      throw new Error(
        `Insert block "${openPrefix}${headerArgs}" has empty body. Use a replace block to delete content.`,
      );
    }
    blocks.push({ ...header, body });
    i = closeIdx;
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
      const actualStart = lines[block.start - 1];
      const expectedStartHash = block.startHash;
      const actualStartHash = lineHash(actualStart ?? "");
      if (actualStartHash !== expectedStartHash) {
        throw new Error(
          `Hash verification failed at line ${block.start}: expected hash ${expectedStartHash} but got ${actualStartHash} for line ${JSON.stringify(actualStart)}. The line numbers may be stale; re-read the file with read_file.`,
        );
      }
      const actualEnd = lines[block.end - 1];
      const expectedEndHash = block.endHash;
      const actualEndHash = lineHash(actualEnd ?? "");
      if (actualEndHash !== expectedEndHash) {
        throw new Error(
          `Hash verification failed at line ${block.end}: expected hash ${expectedEndHash} but got ${actualEndHash} for line ${JSON.stringify(actualEnd)}. The line numbers may be stale; re-read the file with read_file.`,
        );
      }
      const removeCount = block.end - block.start + 1;
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
 * @returns {{ op: "replace"; start: number; end: number; startHash: string; endHash: string } | { op: "insert"; after: number; afterHash: string }}
 */
function parseHeaderArgs(headerArgs) {
  // Replace form: "{start}:{startHash}-{end}:{endHash}"
  const replaceMatch = headerArgs.match(
    /^(\d+):([a-f0-9]{2})-(\d+):([a-f0-9]{2})\s*$/,
  );
  if (replaceMatch) {
    const start = Number(replaceMatch[1]);
    const end = Number(replaceMatch[3]);
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
      startHash: replaceMatch[2],
      endHash: replaceMatch[4],
    };
  }
  // Insert form: "0+" (no hash — there is no line 0 to verify)
  if (/^0\+\s*$/.test(headerArgs)) {
    return { op: "insert", after: 0, afterHash: "" };
  }
  // Insert form: "{N}:{afterHash}+"
  const insertMatch = headerArgs.match(/^(\d+):([a-f0-9]{2})\+\s*$/);
  if (insertMatch) {
    return {
      op: "insert",
      after: Number(insertMatch[1]),
      afterHash: insertMatch[2],
    };
  }
  throw new Error(
    `Invalid block header arguments: ${JSON.stringify(headerArgs)}. Expected "{start}:{startHash}-{end}:{endHash}" or "{N}:{afterHash}+" or "0+".`,
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
      if (totalLines < block.end) {
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
