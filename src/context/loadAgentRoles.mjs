/** @import { ClaudeCodePlugin } from "../claudeCodePlugin.mjs" */

import fs from "node:fs/promises";
import path from "node:path";
import {
  AGENT_PROJECT_METADATA_DIR,
  AGENT_ROOT,
  AGENT_USER_CONFIG_DIR,
} from "../env.mjs";
import { parseFrontmatter } from "../utils/parseFrontmatter.mjs";

/**
 * @typedef {Object} AgentRole
 * @property {string} id
 * @property {string} description
 * @property {string} content
 * @property {string} filePath
 * @property {boolean} claudeOriginated
 */

/**
 * Load all agent roles from the predefined directories.
 * @param {ClaudeCodePlugin[]} [claudeCodePlugins]
 * @returns {Promise<Map<string, AgentRole>>}
 */
export async function loadAgentRoles(claudeCodePlugins) {
  /** @type {Array<{dir: string, idPrefix: string, only?: RegExp}>} */
  const agentDirs = [
    {
      dir: path.resolve(AGENT_ROOT, "config", "agents.predefined"),
      idPrefix: "",
    },
    { dir: path.resolve(AGENT_USER_CONFIG_DIR, "agents"), idPrefix: "" },
    { dir: path.resolve(AGENT_PROJECT_METADATA_DIR, "agents"), idPrefix: "" },
    {
      dir: path.resolve(process.cwd(), ".claude", "agents"),
      idPrefix: "claude:",
    },
  ];

  // Add plugin directories if provided
  if (claudeCodePlugins) {
    for (const plugin of claudeCodePlugins) {
      agentDirs.push({
        dir: path.join(plugin.path, "agents"),
        idPrefix: `claude/${plugin.name}:`,
        only: plugin.only,
      });
    }
  }

  const files = (
    await Promise.all(
      agentDirs.map(async ({ dir, idPrefix, only }) => {
        const files = await getMarkdownFiles(dir).catch((err) => {
          if (err.code !== "ENOENT") {
            console.warn(`Failed to list agent roles in ${dir}:`, err);
          }
          return /** @type {string[]} */ ([]);
        });
        return files.map((file) => ({ dir, file, idPrefix, only }));
      }),
    )
  )
    .flat()
    // Filter by only pattern if specified
    .filter(({ file, only }) => !(only && !only.test(file)));

  const roles = /** @type {AgentRole[]} */ (
    (
      await Promise.all(
        files.map(async ({ dir, file, idPrefix }) => {
          const fullPath = path.join(dir, file);
          const content = await fs.readFile(fullPath, "utf-8").catch((err) => {
            console.warn(`Failed to read agent role file ${fullPath}:`, err);
            return null;
          });

          if (content === null) return null;

          const role = parseAgentRole(file, content, fullPath, idPrefix);

          return role;
        }),
      )
    ).filter((role) => role)
  );

  return new Map(roles.map((role) => [role.id, role]));
}

/**
 * Recursively get all markdown files in a directory.
 * @param {string} dir
 * @param {string} [baseDir]
 * @returns {Promise<string[]>}
 */
async function getMarkdownFiles(dir, baseDir = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) continue;
      isDirectory = stat.isDirectory();
      isFile = stat.isFile();
    }

    if (isDirectory) {
      files.push(...(await getMarkdownFiles(fullPath, baseDir)));
    } else if (isFile && entry.name.endsWith(".md")) {
      files.push(path.relative(baseDir, fullPath));
    }
  }

  return files;
}

/**
 * Parse an agent role file content.
 * @param {string} relativePath
 * @param {string} fileContent
 * @param {string} fullPath
 * @param {string} [idPrefix=""]
 * @returns {AgentRole}
 */
function parseAgentRole(relativePath, fileContent, fullPath, idPrefix = "") {
  const rawId = relativePath.replace(/\.md$/, "");
  const id = idPrefix + rawId;
  const claudeOriginated = idPrefix.startsWith("claude");

  // Match YAML frontmatter
  const match = fileContent.match(
    /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/,
  );

  if (!match) {
    return {
      id,
      description: "",
      content: fileContent.trim(),
      filePath: fullPath,
      claudeOriginated,
    };
  }

  const frontmatter = parseFrontmatter(match[1]);
  const content = match[2].trim();

  return {
    id,
    description: frontmatter.description ?? "",
    content,
    filePath: fullPath,
    claudeOriginated,
  };
}
