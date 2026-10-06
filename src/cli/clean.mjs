/**
 * @import { CleanTarget } from "./args.mjs"
 */

import fs from "node:fs/promises";
import readline from "node:readline";
import { styleText } from "node:util";
import { AGENT_TMP_DIR, SESSIONS_DIR } from "../env.mjs";

/** @type {Record<CleanTarget, string>} */
const TARGET_DIRS = {
  tmp: AGENT_TMP_DIR,
  sessions: SESSIONS_DIR,
};

/**
 * @typedef {Object} CleanCommandOptions
 * @property {CleanTarget[]} targets - Directories to remove, in canonical order
 * @property {boolean} force - Skip the confirmation prompt
 * @property {boolean} dryRun - Only report what would be removed
 * @property {(targets: CleanTarget[]) => Promise<boolean>} [confirm] - Confirmation prompt (overridable for tests)
 */

/**
 * Remove project-local temporary and session directories entirely.
 * @param {CleanCommandOptions} options
 * @returns {Promise<number>} exit code (0 = success, 1 = failure)
 */
export async function runCleanCommand({
  targets,
  force,
  dryRun,
  confirm = confirmRemoval,
}) {
  const existing = await existingTargets(targets);
  if (existing.length === 0) {
    console.log("Nothing to clean.");
    return 0;
  }

  if (dryRun) {
    for (const target of existing) {
      console.log(`Would remove ${TARGET_DIRS[target]}`);
    }
    return 0;
  }

  if (!force) {
    if (!process.stdin.isTTY) {
      console.error(
        "Refusing to remove without confirmation in a non-interactive environment. Use -f to force.",
      );
      return 1;
    }
    if (!(await confirm(existing))) {
      console.log("Aborted.");
      return 0;
    }
  }

  let failed = false;
  for (const target of existing) {
    try {
      await fs.rm(TARGET_DIRS[target], { recursive: true, force: true });
      console.log(`Removed ${TARGET_DIRS[target]}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        styleText("red", `Failed to remove ${TARGET_DIRS[target]}: ${message}`),
      );
      failed = true;
    }
  }

  return failed ? 1 : 0;
}

/**
 * @param {CleanTarget[]} targets
 * @returns {Promise<CleanTarget[]>}
 */
async function existingTargets(targets) {
  /** @type {CleanTarget[]} */
  const existing = [];
  for (const target of targets) {
    if (await dirExists(TARGET_DIRS[target])) {
      existing.push(target);
    }
  }
  return existing;
}

/**
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function dirExists(dir) {
  try {
    await fs.access(dir);
    return true;
  } catch (err) {
    if (
      err instanceof Error &&
      /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT"
    ) {
      return false;
    }
    throw err;
  }
}

/**
 * @param {CleanTarget[]} targets
 * @returns {Promise<boolean>}
 */
async function confirmRemoval(targets) {
  const dirs = targets.map((target) => TARGET_DIRS[target]).join(" and ");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise((resolve) => {
    rl.question(`Delete ${dirs}? (y/N) `, (ans) => {
      rl.close();
      resolve(ans);
    });
  });

  return answer.toLowerCase() === "y";
}
