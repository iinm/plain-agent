/**
 * @import { Tool } from "./tool";
 * @import { SessionState } from "./sessionStore.mjs";
 */

import { randomInt } from "node:crypto";
import { styleText } from "node:util";
import { createAgent } from "./agent.mjs";
import {
  installClaudeCodePlugins,
  resolvePluginPaths,
} from "./claudeCodePlugin.mjs";
import { parseCliArgs, printHelp } from "./cliArgs.mjs";
import { startBatchSession } from "./cliBatch.mjs";
import { runCostCommand } from "./cliCost.mjs";
import { startInteractiveSession } from "./cliInteractive.mjs";
import { loadAppConfig } from "./config.mjs";
import { loadAgentRoles } from "./context/loadAgentRoles.mjs";
import { loadPrompts } from "./context/loadPrompts.mjs";
import { AGENT_PROJECT_METADATA_DIR, USER_NAME } from "./env.mjs";
import { setupMCPServer } from "./mcpIntegration.mjs";
import { createModelCaller } from "./modelCaller.mjs";
import { createPrompt } from "./prompt.mjs";
import { listSessions, loadSession } from "./sessionStore.mjs";
import { createAskURLTool } from "./tools/askURL.mjs";
import { createAskWebTool } from "./tools/askWeb.mjs";
import { createCompactContextTool } from "./tools/compactContext.mjs";
import { createExecCommandTool } from "./tools/execCommand.mjs";
import { createPatchFileTool } from "./tools/patchFile.mjs";
import { readFileTool } from "./tools/readFile.mjs";
import { createSwitchToMainAgentTool } from "./tools/switchToMainAgent.mjs";
import { createSwitchToSubagentTool } from "./tools/switchToSubagent.mjs";
import { createTmuxCommandTool } from "./tools/tmuxCommand.mjs";
import { writeFileTool } from "./tools/writeFile.mjs";
import { createToolUseApprover } from "./toolUseApprover.mjs";

const cliArgs = parseCliArgs(process.argv);
if (cliArgs.subcommand.type === "help") {
  printHelp();
}

if (cliArgs.subcommand.type === "list-models") {
  const { appConfig } = await loadAppConfig({ skipTrustCheck: true });
  if (!appConfig.models || appConfig.models.length === 0) {
    console.error("No models found in configuration.");
    process.exit(1);
  }
  for (const model of appConfig.models) {
    const platform = model.platform;
    console.log(
      `${model.name}+${model.variant} (platform: ${platform.name}+${platform.variant})`,
    );
  }
  process.exit(0);
}

if (cliArgs.subcommand.type === "install-claude-code-plugins") {
  await installClaudeCodePlugins();
  process.exit(0);
}

if (cliArgs.subcommand.type === "cost") {
  try {
    const exitCode = await runCostCommand({
      from: cliArgs.subcommand.from,
      to: cliArgs.subcommand.to,
    });
    process.exit(exitCode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}

if (cliArgs.subcommand.type === "resume" && cliArgs.subcommand.list) {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    console.log("No resumable sessions in .plain-agent/sessions/.");
    process.exit(0);
  }
  console.log("Resumable sessions (most recently updated first):\n");
  for (const s of sessions) {
    console.log(
      `  ${s.sessionId}  ${s.modelName}  (updated ${formatLocalDateTime(s.lastUpdatedAt)}, ${s.messageCount} messages)`,
    );
    if (s.workingDir !== process.cwd()) {
      console.log(`    workingDir: ${s.workingDir}`);
    }
  }
  process.exit(0);
}

(async () => {
  /** @type {SessionState | null} */
  let resumedState = null;

  if (cliArgs.subcommand.type === "resume") {
    const requestedId = cliArgs.subcommand.sessionId;
    if (requestedId) {
      resumedState = await loadSession(requestedId);
      if (!resumedState) {
        console.error(
          styleText("red", `No saved session found for id: ${requestedId}`),
        );
        process.exit(1);
      }
    } else {
      const sessions = await listSessions();
      if (sessions.length === 0) {
        console.error(
          styleText(
            "red",
            "No resumable sessions found in .plain-agent/sessions/.",
          ),
        );
        process.exit(1);
      }
      resumedState = await loadSession(sessions[0].sessionId);
      if (!resumedState) {
        console.error(
          styleText(
            "red",
            `Failed to load latest session: ${sessions[0].sessionId}`,
          ),
        );
        process.exit(1);
      }
    }
  }

  const startTime = resumedState
    ? new Date(resumedState.startTime)
    : new Date();
  const sessionId = resumedState ? resumedState.sessionId : generateSessionId();
  const tmuxSessionId = `agent-${sessionId}`;

  const isBatchMode = cliArgs.subcommand.type === "batch";
  /** @type {string[]} */
  const configFiles =
    cliArgs.subcommand.type === "batch" ||
    cliArgs.subcommand.type === "interactive" ||
    cliArgs.subcommand.type === "resume"
      ? cliArgs.subcommand.config
      : [];

  const { appConfig, loadedConfigPath } = await loadAppConfig({
    skipUserConfig: isBatchMode,
    skipTrustCheck: isBatchMode,
    configFiles,
  });

  // In batch mode, skip human-readable output
  if (!isBatchMode) {
    if (loadedConfigPath.length > 0) {
      console.log(styleText("green", "\n⚡ Loaded configuration files"));
      console.log(loadedConfigPath.map((p) => `  ⤷ ${p}`).join("\n"));
    }

    if (appConfig.sandbox) {
      const sandboxStr = [
        appConfig.sandbox.command,
        ...(appConfig.sandbox.args || []),
      ].join(" ");
      console.log(styleText("green", "\n📦 Sandbox: on"));
      console.log(`  ⤷ ${sandboxStr}`);
    } else {
      console.log(styleText("yellow", "\n📦 Sandbox: off"));
    }

    if (resumedState) {
      console.log(
        styleText("green", `\n⏯  Resuming session: ${resumedState.sessionId}`),
      );
      console.log(
        `  ⤷ ${resumedState.messages.length} messages, last updated ${formatLocalDateTime(resumedState.lastUpdatedAt)}`,
      );
      if (resumedState.workingDir !== process.cwd()) {
        console.log(
          styleText(
            "yellow",
            `  ⚠ workingDir differs (saved: ${resumedState.workingDir}, current: ${process.cwd()})`,
          ),
        );
      }
    }
  }

  /** @type {(() => Promise<void>)[]} */
  const mcpCleanups = [];

  /** @type {Tool[]} */
  const mcpTools = [];
  if (appConfig.mcpServers) {
    const mcpServerEntries = Object.entries(appConfig.mcpServers);

    if (!isBatchMode) {
      console.log();
      for (const [serverName] of mcpServerEntries) {
        console.log(
          styleText("blue", `🔌 Connecting to MCP server: ${serverName}...`),
        );
      }
    }

    const mcpResults = await Promise.all(
      mcpServerEntries.map(async ([serverName, serverConfig]) => {
        const result = await setupMCPServer(serverName, serverConfig);
        return { serverName, ...result };
      }),
    );

    for (const { serverName, tools, stderrLogPath, cleanup } of mcpResults) {
      mcpTools.push(...tools);
      mcpCleanups.push(cleanup);
      if (!isBatchMode) {
        console.log(
          styleText(
            "green",
            `✅ Successfully connected to MCP server: ${serverName}`,
          ),
        );
        console.log(`  ⤷ stderr log: ${stderrLogPath}`);
      }
    }
  }

  const modelFromConfig = appConfig.model || "";
  const modelFromArgs =
    cliArgs.subcommand.type === "batch" ||
    cliArgs.subcommand.type === "interactive"
      ? cliArgs.subcommand.model
      : null;
  let modelNameWithVariant = modelFromArgs || modelFromConfig;

  if (resumedState) {
    // Switching models on resume is not supported. The model from the saved
    // session always wins. If config disagrees, fail loudly.
    if (
      modelNameWithVariant &&
      modelNameWithVariant !== resumedState.modelName
    ) {
      console.error(
        styleText(
          "red",
          [
            `Cannot resume session ${resumedState.sessionId}: model mismatch.`,
            `  saved model:   ${resumedState.modelName}`,
            `  current model: ${modelNameWithVariant}`,
            "Resume must use the same model the session was started with.",
          ].join("\n"),
        ),
      );
      process.exit(1);
    }
    modelNameWithVariant = resumedState.modelName;
  }

  const pluginPaths = resolvePluginPaths(appConfig.claudeCodePlugins ?? []);
  const [prompts, agentRoles] = await Promise.all([
    loadPrompts(pluginPaths),
    loadAgentRoles(pluginPaths),
  ]);

  const prompt = createPrompt({
    username: USER_NAME,
    modelName: modelNameWithVariant,
    workingDir: process.cwd(),
    today: new Date().toISOString().split("T")[0],
    sessionId,
    tmuxSessionId,
    projectMetadataDir: AGENT_PROJECT_METADATA_DIR,
    agentRoles,
    skills: Array.from(prompts.values()).filter((p) => p.isSkill),
  });

  const builtinTools = [
    createExecCommandTool({ sandbox: appConfig.sandbox }),
    readFileTool,
    writeFileTool,
    createPatchFileTool(),
    createTmuxCommandTool({ sandbox: appConfig.sandbox }),
    createCompactContextTool(),
    createSwitchToSubagentTool(),
    createSwitchToMainAgentTool(),
  ];

  if (appConfig.tools?.askWeb) {
    builtinTools.push(createAskWebTool(appConfig.tools.askWeb));
  }

  if (appConfig.tools?.askURL) {
    const askURLConfig = appConfig.tools.askURL;
    if (askURLConfig.provider === "builtin+w3m") {
      const askURLModelName = askURLConfig.model ?? modelNameWithVariant;
      const [askURLModelBaseName, askURLModelVariant] =
        askURLModelName.split("+");
      const askURLModelDef = (appConfig.models ?? []).find(
        (entry) =>
          entry.name === askURLModelBaseName &&
          entry.variant === askURLModelVariant,
      );
      if (!askURLModelDef) {
        throw new Error(
          `askURL model "${askURLModelName}" not found in configuration.`,
        );
      }
      const askURLPlatform = (appConfig.platforms ?? []).find(
        (entry) =>
          entry.name === askURLModelDef.platform.name &&
          entry.variant === askURLModelDef.platform.variant,
      );
      if (!askURLPlatform) {
        throw new Error(
          `askURL platform ${askURLModelDef.platform.name} variant=${askURLModelDef.platform.variant} not found in configuration.`,
        );
      }
      builtinTools.push(
        createAskURLTool({
          provider: "builtin+w3m",
          modelCaller: createModelCaller({
            ...askURLModelDef,
            platform: {
              ...askURLModelDef.platform,
              ...askURLPlatform,
            },
          }),
          maxBytesPerURL: askURLConfig.maxBytesPerURL,
          maxTotalBytes: askURLConfig.maxTotalBytes,
        }),
      );
    } else {
      builtinTools.push(createAskURLTool(askURLConfig));
    }
  }

  const toolUseApprover = createToolUseApprover({
    maxApprovals: appConfig.autoApproval?.maxApprovals || 50,
    defaultAction: appConfig.autoApproval?.defaultAction || "ask",
    patterns: appConfig.autoApproval?.patterns || [],
    maskApprovalInput: (toolName, input) => {
      for (const tool of builtinTools) {
        if (tool.def.name === toolName && tool.maskApprovalInput) {
          return tool.maskApprovalInput(input);
        }
      }
      return input;
    },
  });

  const [modelName, modelVariant] = modelNameWithVariant.split("+");
  const modelDef = (appConfig.models ?? []).find(
    (entry) => entry.name === modelName && entry.variant === modelVariant,
  );
  if (!modelDef) {
    throw new Error(
      `Model "${modelNameWithVariant}" not found in configuration.`,
    );
  }

  const platform = (appConfig.platforms ?? []).find(
    (entry) =>
      entry.name === modelDef.platform.name &&
      entry.variant === modelDef.platform.variant,
  );
  if (!platform) {
    throw new Error(
      `Platform ${modelDef.platform.name} variant=${modelDef.platform.variant} not found in configuration.`,
    );
  }

  const { userEventEmitter, agentEventEmitter, agentCommands } = createAgent({
    callModel: createModelCaller({
      ...modelDef,
      platform: {
        ...modelDef.platform,
        ...platform,
      },
    }),
    prompt,
    tools: [...builtinTools, ...mcpTools],
    toolUseApprover,
    agentRoles,
    modelCostConfig: modelDef.cost,
    sessionMetadata: {
      sessionId,
      modelName: modelNameWithVariant,
      workingDir: process.cwd(),
      startTime,
    },
    initialState: resumedState,
  });

  const sessionOptions = {
    userEventEmitter,
    agentEventEmitter,
    agentCommands,
    sessionId,
    modelName: modelNameWithVariant,
    sandbox: Boolean(appConfig.sandbox),
    startTime,
    onStop: async () => {
      for (const cleanup of mcpCleanups) {
        await cleanup();
      }
    },
  };

  if (cliArgs.subcommand.type === "batch") {
    const task = cliArgs.subcommand.task;
    if (!task) {
      throw new Error("Batch task is required in batch mode");
    }
    await startBatchSession({
      ...sessionOptions,
      task,
    });
  } else {
    startInteractiveSession({
      ...sessionOptions,
      notifyCmd: appConfig.notifyCmd,
      claudeCodePlugins: resolvePluginPaths(appConfig.claudeCodePlugins ?? []),
      voiceInput: appConfig.voiceInput,
    });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Generate a session id of the form `YYYY-MM-DD-HHMM-<3 random base36 chars>`.
 * The random suffix avoids collisions when multiple `plain` processes start
 * within the same minute. `randomInt` is uniform over `[0, 36 ** 3)`, so
 * each suffix character is unbiased.
 *
 * @param {Date} [now]
 * @returns {string}
 */
function generateSessionId(now = new Date()) {
  const date = [
    `${now.getFullYear()}-${`0${now.getMonth() + 1}`.slice(-2)}-${`0${now.getDate()}`.slice(-2)}`,
    `0${now.getHours()}`.slice(-2) + `0${now.getMinutes()}`.slice(-2),
  ].join("-");
  const suffix = randomInt(36 ** 3)
    .toString(36)
    .padStart(3, "0");
  return `${date}-${suffix}`;
}

/**
 * Format an ISO 8601 timestamp as `YYYY-MM-DD HH:MM:SS` in the local timezone.
 *
 * @param {string} iso
 * @returns {string}
 */
function formatLocalDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const mo = `${d.getMonth() + 1}`.padStart(2, "0");
  const da = `${d.getDate()}`.padStart(2, "0");
  const h = `${d.getHours()}`.padStart(2, "0");
  const mi = `${d.getMinutes()}`.padStart(2, "0");
  const s = `${d.getSeconds()}`.padStart(2, "0");
  return `${y}-${mo}-${da} ${h}:${mi}:${s}`;
}
