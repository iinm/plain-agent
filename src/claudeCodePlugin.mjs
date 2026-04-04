import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { loadAppConfig } from "./config.mjs";
import { CLAUDE_CODE_PLUGIN_DIR } from "./env.mjs";

/**
 * Resolve plugin paths from hierarchical config structure.
 * Converts {source, plugins} to flat {name, path} with full paths.
 * @param {Array<{source: string, plugins: Array<{name: string, path: string}>}>} repos
 * @returns {Array<{name: string, path: string}>}
 */
export function resolvePluginPaths(repos) {
  if (!repos) return [];

  /** @type {Array<{name: string, path: string}>} */
  const result = [];

  for (const repo of repos) {
    const ownerRepo = extractOwnerRepo(repo.source);
    if (!ownerRepo) {
      console.warn(`Invalid source URL: ${repo.source}`);
      continue;
    }

    for (const plugin of repo.plugins) {
      result.push({
        name: plugin.name,
        path: path.join(CLAUDE_CODE_PLUGIN_DIR, ownerRepo, plugin.path),
      });
    }
  }

  return result;
}

/**
 * Install Claude Code plugins by cloning repositories.
 */
export async function installClaudeCodePlugins() {
  const { appConfig } = await loadAppConfig({ skipTrustCheck: true });
  const repos = appConfig.claudeCodePlugins ?? [];

  if (repos.length === 0) {
    console.log("No plugins configured.");
    return;
  }

  let installed = 0;
  let skipped = 0;
  let failed = 0;

  // Track paths for summary
  /** @type {string[]} */
  const installedPaths = [];
  /** @type {string[]} */
  const skippedPaths = [];

  // Ensure plugin directory exists
  await fs.mkdir(CLAUDE_CODE_PLUGIN_DIR, { recursive: true });

  for (const repo of repos) {
    const ownerRepo = extractOwnerRepo(repo.source);
    if (!ownerRepo) {
      console.error(`❌ Invalid source URL: ${repo.source}`);
      failed++;
      continue;
    }

    const destPath = path.join(CLAUDE_CODE_PLUGIN_DIR, ownerRepo);

    // Check if already exists
    const exists = await fs
      .access(destPath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      console.log(`⏭️ Skipping ${repo.source} → ${destPath}: already installed`);
      skippedPaths.push(destPath);
      skipped++;
      continue;
    }

    // Clone the repository
    console.log(`📥 Installing ${repo.source}...`);
    try {
      await new Promise((resolve, reject) => {
        execFile(
          "git",
          ["clone", "--depth", "1", repo.source, destPath],
          (err) => {
            if (err) reject(err);
            else resolve(undefined);
          },
        );
      });
      console.log(`✅ Installed to ${destPath}`);
      installedPaths.push(destPath);
      installed++;
    } catch (error) {
      console.error(
        `❌ Failed to install: ${error instanceof Error ? error.message : String(error)}`,
      );
      failed++;
    }
  }

  console.log(
    `\n📊 Summary: ${installed} installed, ${skipped} skipped, ${failed} failed`,
  );

  if (installedPaths.length > 0) {
    console.log("\nInstalled:");
    for (const p of installedPaths) {
      console.log(`  • ${p}`);
    }
  }

  if (skippedPaths.length > 0) {
    console.log("\nSkipped:");
    for (const p of skippedPaths) {
      console.log(`  • ${p}`);
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

/**
 * Extract owner/repo from source URL.
 * @param {string} source
 * @returns {string|null}
 */
function extractOwnerRepo(source) {
  // Handle: https://github.com/owner/repo
  // Handle: git@github.com:owner/repo.git
  const match = source.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}
