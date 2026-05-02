import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
export const AGENT_ROOT = path.dirname(path.dirname(filename));

export const AGENT_USER_CONFIG_DIR = path.join(
  os.homedir(),
  ".config",
  "plain-agent",
);
export const AGENT_CACHE_DIR = path.join(os.homedir(), ".cache", "plain-agent");

export const AGENT_DATA_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "plain-agent",
);

export const USAGE_LOG_PATH = path.join(AGENT_DATA_DIR, "usage.jsonl");

export const TRUSTED_CONFIG_HASHES_DIR = path.join(
  AGENT_CACHE_DIR,
  "trusted-config-hashes",
);

export const AGENT_PROJECT_METADATA_DIR = ".plain-agent";

export const AGENT_MEMORY_DIR = path.join(AGENT_PROJECT_METADATA_DIR, "memory");
export const AGENT_TMP_DIR = path.join(AGENT_PROJECT_METADATA_DIR, "tmp");

export const CLAUDE_CODE_PLUGIN_DIR = path.join(
  AGENT_PROJECT_METADATA_DIR,
  "claude-code-plugins",
);

export const MESSAGES_DUMP_FILE_PATH = path.join(
  AGENT_PROJECT_METADATA_DIR,
  "messages.json",
);

export const USER_NAME = process.env.USER || "unknown";
