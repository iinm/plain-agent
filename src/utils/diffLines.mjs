/**
 * @typedef {{ type: " " | "-" | "+"; line: string }} DiffOp
 */

/**
 * Compute a unified-style line diff between two arrays.
 *
 * Returns an edit script that transforms `oldLines` into `newLines`,
 * with three op kinds:
 *   - " " : line is in both (context)
 *   - "-" : line is only in old (removed)
 *   - "+" : line is only in new (added)
 *
 * Within a hunk (a run of changes between context lines), all `-` ops
 * appear before all `+` ops to match the conventional unified-diff
 * presentation produced by `git diff` and friends.
 *
 * Implementation: standard O(N*M) longest-common-subsequence DP plus
 * a backtrack pass. This is fine for the patch_file block sizes we
 * expect (typically a few dozen lines per block); we avoid pulling in
 * a Myers-diff dependency.
 *
 * @param {string[]} oldLines
 * @param {string[]} newLines
 * @returns {DiffOp[]}
 */
export function diffLines(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;

  // dp[i][j] = LCS length of oldLines[0..i) and newLines[0..j).
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack from (n, m) to (0, 0). We walk in reverse, accumulating
  // pending deletes/adds until we hit a context line; then we flush
  // them so that, after the final reverse, deletes appear before adds
  // within each hunk.
  /** @type {DiffOp[]} */
  const ops = [];
  /** @type {string[]} */
  let pendingDel = [];
  /** @type {string[]} */
  let pendingAdd = [];

  // While walking back, we push ops in reverse order. For each hunk we
  // want the final order (after reverse()) to be: deletes-in-source-order
  // then adds-in-source-order. So during the reverse walk we must push
  // adds first, then deletes.
  const flush = () => {
    for (const line of pendingAdd) {
      ops.push({ type: "+", line });
    }
    for (const line of pendingDel) {
      ops.push({ type: "-", line });
    }
    pendingAdd = [];
    pendingDel = [];
  };

  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      flush();
      ops.push({ type: " ", line: oldLines[i - 1] });
      i--;
      j--;
      continue;
    }
    if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      pendingAdd.push(newLines[j - 1]);
      j--;
    } else {
      pendingDel.push(oldLines[i - 1]);
      i--;
    }
  }
  flush();

  ops.reverse();
  return ops;
}
