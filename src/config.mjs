/**
 * @import { AppConfig } from "./config";
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { styleText } from "node:util";
import {
  AGENT_PROJECT_METADATA_DIR,
  AGENT_ROOT,
  AGENT_USER_CONFIG_DIR,
  TRUSTED_CONFIG_HASHES_DIR,
} from "./env.mjs";
import { evalJSONConfig } from "./utils/evalJSONConfig.mjs";

/**
 * @typedef {Object} LoadAppConfigOptions
 * @property {boolean} [skipTrustCheck] - Skip trust check for config files
 * @property {string[]} [configFiles] - Additional config files to load (for batch mode)
 * @property {boolean} [skipUserConfig] - Skip default user config files (for batch mode)
 */

/**
 * @param {LoadAppConfigOptions} [options]
 * @returns {Promise<{appConfig: AppConfig, loadedConfigPath: string[]}>}
 */
export async function loadAppConfig(options = {}) {
  const {
    skipTrustCheck = false,
    configFiles = [],
    skipUserConfig = false,
  } = options;

  // Always load predefined config
  const paths = [`${AGENT_ROOT}/config/config.predefined.json`];

  if (!skipUserConfig) {
    paths.push(
      `${AGENT_USER_CONFIG_DIR}/config.json`,
      `${AGENT_USER_CONFIG_DIR}/config.local.json`,
      `${AGENT_PROJECT_METADATA_DIR}/config.json`,
      `${AGENT_PROJECT_METADATA_DIR}/config.local.json`,
    );
  }

  // Add explicitly specified config files
  paths.push(...configFiles);

  /** @type {string[]} */
  const loadedConfigPath = [];
  /** @type {AppConfig} */
  let merged = {};

  for (const filePath of paths) {
    const config = await loadConfigFile(path.resolve(filePath), skipTrustCheck);
    if (Object.keys(config).length) {
      loadedConfigPath.push(filePath);
    }
    merged = {
      model: config.model || merged.model,
      models: [...(config.models ?? []), ...(merged.models ?? [])],
      platforms: [...(config.platforms ?? []), ...(merged.platforms ?? [])],
      autoApproval: {
        defaultAction:
          config.autoApproval?.defaultAction ??
          merged.autoApproval?.defaultAction,
        patterns: [
          ...(config.autoApproval?.patterns ?? []),
          ...(merged.autoApproval?.patterns ?? []),
        ],
        maxApprovals:
          config.autoApproval?.maxApprovals ??
          merged.autoApproval?.maxApprovals,
      },
      sandbox: config.sandbox ?? merged.sandbox,
      tools: {
        askWeb: config.tools?.askWeb
          ? {
              ...(merged.tools?.askWeb ?? {}),
              ...config.tools.askWeb,
            }
          : merged.tools?.askWeb,
        askURL: config.tools?.askURL
          ? {
              ...(merged.tools?.askURL ?? {}),
              ...config.tools.askURL,
            }
          : merged.tools?.askWeb,
      },
      mcpServers: {
        ...(merged.mcpServers ?? {}),
        ...(config.mcpServers ?? {}),
      },
      notifyCmd: config.notifyCmd ?? merged.notifyCmd,
      claudeCodePlugins: [
        ...(merged.claudeCodePlugins ?? []),
        ...(config.claudeCodePlugins ?? []),
      ],
      voiceInput: config.voiceInput
        ? { ...(merged.voiceInput ?? {}), ...config.voiceInput }
        : merged.voiceInput,
    };
  }

  return { appConfig: merged, loadedConfigPath };
}

/**
 * @param {string} filePath
 * @param {boolean} [skipTrustCheck=false]
 * @returns {Promise<AppConfig>}
 */
export async function loadConfigFile(filePath, skipTrustCheck = false) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return {};
    }
    throw err;
  }

  const hash = crypto.createHash("sha256").update(content).digest("hex");
  const isTrusted = skipTrustCheck || (await isConfigHashTrusted(hash));

  if (!isTrusted) {
    if (!process.stdout.isTTY) {
      console.warn(
        styleText(
          "yellow",
          `WARNING: Config file found at '${filePath}' but cannot ask for approval without a TTY. Skipping.`,
        ),
      );
      return {};
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise((resolve) => {
      console.log(styleText("blue", `\nFound a config file at ${filePath}`));
      rl.question(
        styleText("yellow", "Do you want to load this file? (y/N) "),
        (ans) => {
          rl.close();
          resolve(ans);
        },
      );
    });

    if (answer.toLowerCase() !== "y") {
      console.log(styleText("yellow", "Skipping local config file."));
      return {};
    }

    await trustConfigHash(hash);
  }

  try {
    const commentRemovedContent = content.replace(/^ *\/\/.+$/gm, "");
    const parsed = JSON.parse(commentRemovedContent);
    return /** @type {AppConfig} */ (evalJSONConfig(parsed));
  } catch (err) {
    throw new Error(`Failed to parse JSON config at ${filePath}`, {
      cause: err,
    });
  }
}

/**
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function isConfigHashTrusted(hash) {
  try {
    await fs.access(path.join(TRUSTED_CONFIG_HASHES_DIR, hash));
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/**
 * @param {string} hash
 */
async function trustConfigHash(hash) {
  await fs.mkdir(TRUSTED_CONFIG_HASHES_DIR, { recursive: true });
  await fs.writeFile(path.join(TRUSTED_CONFIG_HASHES_DIR, hash), "");
}
