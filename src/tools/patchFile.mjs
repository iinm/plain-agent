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
@@@ ${nonce} {start}:{startHash}-{end}:{endHash}
replacement for lines {start}-{end}
@@@ ${nonce} {N}:{afterHash}+
appended content after line N
@@@ ${nonce} 0+
prepended content at beginning of file
@@@ ${nonce} {N}:{hash}
replace just that one line
@@@ ${nonce} 10:ab-15:cd
(empty body deletes the range)

- Each block's content starts right after its @@@ header line and ends at the next @@@ or the end of the string. Any blank lines between the header and the content become part of the replacement.
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
            `No patch blocks found. Each block must start with "@@@ ${nonce} ...".`,
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
  const lines = patch.split("\n");

  // Find all header line indices
  /** @type {number[]} */
  const headerIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(openPrefix)) {
      headerIndices.push(i);
    }
  }

  if (headerIndices.length === 0) {
    // Check if any line looks like a header with wrong nonce or old format
    for (const line of lines) {
      if (line.startsWith("@@@ ") || line.startsWith(">>> ")) {
        throw new Error(
          `No patch blocks found with nonce "${nonce}". Check that the nonce in each block header matches "${nonce}" exactly.`,
        );
      }
    }
    throw new Error(
      `No patch blocks found. Each block must start with "@@@ ${nonce} ...".`,
    );
  }

  /** @type {PatchBlock[]} */
  const blocks = [];
  for (let i = 0; i < headerIndices.length; i++) {
    const headerLineIdx = headerIndices[i];
    const headerLine = lines[headerLineIdx];
    const headerArgs = headerLine.slice(openPrefix.length);
    const header = parseHeaderArgs(headerArgs);

    // Body: from the line after the header to the line before the next header (or EOF)
    const bodyStart = headerLineIdx + 1;
    const bodyEnd =
      i + 1 < headerIndices.length ? headerIndices[i + 1] : lines.length;
    const body = lines.slice(bodyStart, bodyEnd);

    if (header.op === "insert" && body.length === 0) {
      throw new Error(
        `Insert block "@@@ ${nonce} ${headerArgs}" has empty body. Use a replace block to delete content.`,
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
 * @returns {{ op: "replace"; start: number; end: number; startHash: string; endHash: string } | { op: "insert"; after: number; afterHash: string }}
 */
function parseHeaderArgs(headerArgs) {
  // Strip read_file format leakage: "11:40|  ]" → "11:40".
  // Note: this may accept a malformed header like "1:ab|garbage" as "1:ab",
  // but subsequent hash verification against actual file content serves as
  // a safety net — the wrong hash will be caught at apply time.
  const pipeIdx = headerArgs.indexOf("|");
  const cleaned = pipeIdx !== -1 ? headerArgs.slice(0, pipeIdx) : headerArgs;

  // Replace form: "{start}:{startHash}-{end}:{endHash}"
  const replaceMatch = cleaned.match(
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

  // Replace form: "{N}:{hash}" (single line replace — shorthand for N:hash-N:hash)
  const singleReplaceMatch = cleaned.match(/^(\d+):([a-f0-9]{2})\s*$/);
  if (singleReplaceMatch) {
    const start = Number(singleReplaceMatch[1]);
    if (start < 1) {
      throw new Error(
        `Invalid replace range "${headerArgs}": start must be >= 1.`,
      );
    }
    return {
      op: "replace",
      start,
      end: start,
      startHash: singleReplaceMatch[2],
      endHash: singleReplaceMatch[2],
    };
  }

  // Insert form: "0+" (no hash — there is no line 0 to verify)
  if (/^0\+\s*$/.test(cleaned)) {
    return { op: "insert", after: 0, afterHash: "" };
  }

  // Insert form: "{N}:{afterHash}+"
  const insertMatch = cleaned.match(/^(\d+):([a-f0-9]{2})\+\s*$/);
  if (insertMatch) {
    return {
      op: "insert",
      after: Number(insertMatch[1]),
      afterHash: insertMatch[2],
    };
  }

  throw new Error(
    `Invalid block header arguments: ${JSON.stringify(headerArgs)}. Expected "{start}:{startHash}-{end}:{endHash}" or "{N}:{hash}" or "{N}:{afterHash}+" or "0+".`,
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
