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
 * @typedef {Object} Prompt
 * @property {string} id
 * @property {string} description
 * @property {string} content
 * @property {string} filePath
 * @property {boolean} claudeOriginated
 * @property {boolean} [userInvocable]
 * @property {boolean} [isShortcut]
 * @property {boolean} [isSkill]
 */

/**
 * Load all prompts from the predefined directories.
 * @param {ClaudeCodePlugin[]} [claudeCodePlugins]
 * @returns {Promise<Map<string, Prompt>>}
 */
export async function loadPrompts(claudeCodePlugins) {
  /** @type {Array<{dir: string, idPrefix: string, only?: RegExp}>} */
  const promptDirs = [
    {
      dir: path.resolve(AGENT_ROOT, "config", "prompts.predefined"),
      idPrefix: "",
    },
    { dir: path.resolve(AGENT_USER_CONFIG_DIR, "prompts"), idPrefix: "" },
    { dir: path.resolve(AGENT_PROJECT_METADATA_DIR, "prompts"), idPrefix: "" },
    {
      dir: path.resolve(process.cwd(), ".claude", "commands"),
      idPrefix: "claude/commands:",
    },
    {
      dir: path.resolve(process.cwd(), ".claude", "skills"),
      idPrefix: "claude/skills:",
    },
  ];

  // Add plugin directories if provided
  if (claudeCodePlugins) {
    for (const plugin of claudeCodePlugins) {
      // Commands
      promptDirs.push({
        dir: path.join(plugin.path, "commands"),
        idPrefix: `claude/${plugin.name}/commands:`,
        only: plugin.only,
      });

      // Skills
      promptDirs.push({
        dir: path.join(plugin.path, "skills"),
        idPrefix: `claude/${plugin.name}/skills:`,
        only: plugin.only,
      });
    }
  }

  const files = (
    await Promise.all(
      promptDirs.map(async ({ dir, idPrefix, only }) => {
        const files = await getMarkdownFiles(dir).catch((err) => {
          if (err.code !== "ENOENT") {
            console.error(`Failed to list prompts in ${dir}:`, err);
          }
          return /** @type {string[]} */ ([]);
        });
        return files.map((file) => ({ dir, file, idPrefix, only }));
      }),
    )
  )
    .flat()
    // Filter by only pattern if specified
    .filter(({ file, only }) => !(only && !only.test(file)))
    // Ignore all files in the skills/ directory except for SKILL.md.
    .filter(
      ({ file, dir }) =>
        !(
          path.join(dir, file).includes("/skills/") &&
          !file.endsWith("/SKILL.md")
        ),
    );

  const prompts = /** @type {Prompt[]} */ (
    (
      await Promise.all(
        files.map(async ({ dir, file, idPrefix }) => {
          const fullPath = path.join(dir, file);
          const content = await fs.readFile(fullPath, "utf-8").catch((err) => {
            console.error(`Failed to read prompt file ${fullPath}:`, err);
            return null;
          });

          if (content === null) return null;

          const prompt = parsePrompt(file, content, fullPath, idPrefix);

          if (prompt.userInvocable === false) {
            return null;
          }
          return prompt;
        }),
      )
    ).filter((prompt) => prompt)
  );

  return new Map(prompts.map((prompt) => [prompt.id, prompt]));
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
 * Parse a prompt file content.
 * @param {string} relativePath
 * @param {string} fileContent
 * @param {string} fullPath
 * @param {string} [idPrefix=""]
 * @returns {Prompt}
 */
function parsePrompt(relativePath, fileContent, fullPath, idPrefix = "") {
  const rawId = relativePath.replace(/\/SKILL\.md$/, "").replace(/\.md$/, "");
  const isSkill = relativePath.endsWith("SKILL.md");
  const isShortcut = rawId.startsWith("shortcuts/");
  const id = isShortcut
    ? idPrefix + rawId.replace(/^shortcuts\//, "")
    : idPrefix + rawId;
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
      isShortcut,
      isSkill,
    };
  }

  const content = match[2].trim();

  const frontmatter = parseFrontmatter(match[1]);

  return {
    id,
    description: frontmatter.description ?? "",
    content,
    filePath: fullPath,
    claudeOriginated,
    userInvocable: frontmatter["user-invocable"] === "true" ? true : undefined,
    isShortcut,
    isSkill: relativePath.endsWith("SKILL.md"),
  };
}
