/**
 * @import { Tool } from '../tool'
 * @import { PatchBlock, PatchFileInput, PatchPreviewSnapshot } from './patchFile'
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { diffLines } from "../utils/diffLines.mjs";
import { lineHash } from "../utils/lineHash.mjs";
import { noThrow } from "../utils/noThrow.mjs";

/**
 * Max number of entries retained in the process-global patch preview cache.
 * Entries are evicted oldest-first once this limit is exceeded so that
 * consumers which never render a diff (e.g. batch runs) cannot grow memory
 * without bound.
 */
export const MAX_PATCH_PREVIEW_CACHE_ENTRIES = 128;

/**
 * Process-global LRU cache mapping a patch input hash to the sparse snapshot of
 * the target file's original content, captured at execution time (before the
 * write). It lets the CLI render an accurate "before" diff regardless of the
 * order in which the formatter and the tool impl run, without keeping the
 * snapshot in stateManager messages / tool_use input (so it is never sent to
 * the model nor persisted to the session jsonl).
 *
 * A plain Map preserves insertion order, so re-inserting a key on write keeps
 * the most recently written entry newest and `keys().next().value` yields the
 * oldest for eviction.
 *
 * @type {Map<string, PatchPreviewSnapshot>}
 */
const patchPreviewCache = new Map();

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
        // Freeze the "before" content for the diff preview here, before the
        // write, so the CLI can render an accurate diff no matter when it runs.
        setPatchPreviewSnapshot(
          patchPreviewCacheKey(input),
          buildPatchPreviewSnapshot(
            splitFileLines(original),
            collectPatchLineRanges(blocks),
          ),
        );
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
 * @typedef {(text: string) => string} DiffStyler
 */

/**
 * Render a single patch block as a unified-style diff of the change against
 * the original file: the block header, then removed lines ("- "), added lines
 * ("+ "), and unchanged context ("  ") for its range only.
 *
 * The optional `style` callbacks colorize the header and change lines; they
 * default to identity so the output is plain text suitable for tool results,
 * while the CLI passes styleText-based stylers for colored display.
 *
 * The original content may be provided either as an absolute array of every
 * line (backward-compatible), or as a sparse {@link PatchPreviewSnapshot} that
 * only carries the lines needed for the diff plus the file's total line count.
 *
 * @param {PatchBlock} block
 * @param {string[] | PatchPreviewSnapshot | null} originalLines
 * @param {string} nonce
 * @param {{ header?: DiffStyler, del?: DiffStyler, add?: DiffStyler }} [style]
 * @returns {string}
 */
export function renderPatchBlock(block, originalLines, nonce, style = {}) {
  const header = style.header ?? ((text) => text);
  const del = style.del ?? ((text) => text);
  const add = style.add ?? ((text) => text);

  const source = normalizeOriginalSource(originalLines);

  /** @type {string[]} */
  const out = [];
  if (block.op === "replace") {
    out.push(
      header(
        `REPLACE ${nonce} ${block.start}:${block.startHash}-${block.end}:${block.endHash}`,
      ),
    );
    if (source) {
      const safeStart = Math.max(1, block.start);
      const safeEnd = Math.min(source.totalLines, block.end);
      /** @type {string[]} */
      const oldSlice = [];
      for (let i = safeStart; i <= safeEnd; i++) {
        oldSlice.push(source.getLine(i));
      }
      // Use a real line diff so unchanged lines render as context
      // (no color, "  " prefix) instead of being shown as both "- " and
      // "+ ".
      for (const op of diffLines(oldSlice, block.body)) {
        if (op.type === "-") {
          out.push(del(`- ${op.line}`));
        } else if (op.type === "+") {
          out.push(add(`+ ${op.line}`));
        } else {
          out.push(`  ${op.line}`);
        }
      }
    } else {
      // No file context available — fall back to listing the body as
      // additions so the new content is still visible.
      for (const line of block.body) {
        out.push(add(`+ ${line}`));
      }
    }
  } else {
    const afterSuffix = block.afterHash ? `:${block.afterHash}` : "";
    out.push(header(`INSERT_AFTER ${nonce} ${block.after}${afterSuffix}`));
    for (const line of block.body) {
      out.push(add(`+ ${line}`));
    }
  }
  return out.join("\n");
}

/**
 * Compute a deterministic cache key for a patch input. Both the tool impl and
 * the CLI formatter derive the key from the same `{ filePath, patch }` pair so
 * a snapshot written at execution time can be looked up when rendering.
 *
 * @param {PatchFileInput} input
 * @returns {string}
 */
export function patchPreviewCacheKey(input) {
  const { filePath, patch } = input;
  const serialized = JSON.stringify({ filePath, patch });
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Compute the set of original line ranges needed to render a patch's diff
 * preview: the union of every replace block's `[start, end]` (1-based,
 * inclusive). Insert blocks reference no original content and are excluded.
 * Overlapping or adjacent ranges are merged; the result is sorted ascending.
 *
 * @param {PatchBlock[]} blocks
 * @returns {[number, number][]}
 */
export function collectPatchLineRanges(blocks) {
  /** @type {[number, number][]} */
  const ranges = [];
  for (const block of blocks) {
    if (block.op === "replace") {
      ranges.push([block.start, block.end]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);

  /** @type {[number, number][]} */
  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * Look up a previously captured patch preview snapshot by cache key. Read-only:
 * it never mutates or evicts the cache (no delete-on-read).
 *
 * @param {string} key
 * @returns {PatchPreviewSnapshot | null}
 */
export function getPatchPreviewSnapshot(key) {
  return patchPreviewCache.get(key) ?? null;
}

/**
 * Convenience getter that derives the cache key from a patch input.
 *
 * @param {PatchFileInput} input
 * @returns {PatchPreviewSnapshot | null}
 */
export function getPatchPreviewSnapshotByInput(input) {
  return getPatchPreviewSnapshot(patchPreviewCacheKey(input));
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

/**
 * Store a snapshot under `key`, maintaining the cache as an LRU: re-inserting
 * an existing key moves it to newest, and once the entry count exceeds
 * {@link MAX_PATCH_PREVIEW_CACHE_ENTRIES} the oldest entries are evicted.
 *
 * @param {string} key
 * @param {PatchPreviewSnapshot} snapshot
 */
function setPatchPreviewSnapshot(key, snapshot) {
  if (patchPreviewCache.has(key)) {
    patchPreviewCache.delete(key);
  }
  patchPreviewCache.set(key, snapshot);
  while (patchPreviewCache.size > MAX_PATCH_PREVIEW_CACHE_ENTRIES) {
    const oldest = patchPreviewCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    patchPreviewCache.delete(oldest);
  }
}

/**
 * Build a sparse snapshot from an absolute array of original lines, keeping
 * only the lines within the given ranges (1-based, inclusive) plus the file's
 * total line count.
 *
 * @param {string[]} originalLines
 * @param {[number, number][]} ranges
 * @returns {PatchPreviewSnapshot}
 */
function buildPatchPreviewSnapshot(originalLines, ranges) {
  /** @type {Record<number, string>} */
  const lines = {};
  for (const [start, end] of ranges) {
    const safeStart = Math.max(1, start);
    const safeEnd = Math.min(originalLines.length, end);
    for (let i = safeStart; i <= safeEnd; i++) {
      lines[i] = originalLines[i - 1];
    }
  }
  return { totalLines: originalLines.length, lines };
}

/**
 * Normalize the original-content argument of {@link renderPatchBlock} into a
 * uniform accessor, accepting either an absolute line array or a sparse
 * snapshot. Returns null when no content is available.
 *
 * @param {string[] | PatchPreviewSnapshot | null} originalLines
 * @returns {{ totalLines: number; getLine: (line: number) => string } | null}
 */
function normalizeOriginalSource(originalLines) {
  if (!originalLines) {
    return null;
  }
  if (Array.isArray(originalLines)) {
    return {
      totalLines: originalLines.length,
      getLine: (line) => originalLines[line - 1] ?? "",
    };
  }
  return {
    totalLines: originalLines.totalLines,
    getLine: (line) => originalLines.lines[line] ?? "",
  };
}

/**
 * Split file content into 1-based lines, dropping the trailing empty element
 * produced when the content ends with a newline. Mirrors {@link applyBlocks}'s
 * own line indexing so snapshot line numbers match read_file / patch offsets.
 *
 * @param {string} content
 * @returns {string[]}
 */
function splitFileLines(content) {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}
