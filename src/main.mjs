/**
 * @import { Tool } from "./tool";
 */

import { styleText } from "node:util";
import { createAgent } from "./agent.mjs";
import {
  installClaudeCodePlugins,
  resolvePluginPaths,
} from "./claudeCodePlugin.mjs";
import { parseCliArgs, printHelp } from "./cliArgs.mjs";
import { startBatchSession } from "./cliBatch.mjs";
import { startInteractiveSession } from "./cliInteractive.mjs";
import { loadAppConfig } from "./config.mjs";
import { loadAgentRoles } from "./context/loadAgentRoles.mjs";
import { loadPrompts } from "./context/loadPrompts.mjs";
import {
  AGENT_NOTIFY_CMD_DEFAULT,
  AGENT_PROJECT_METADATA_DIR,
  USER_NAME,
} from "./env.mjs";
import { setupMCPServer } from "./mcp.mjs";
import { createModelCaller } from "./modelCaller.mjs";
import { createPrompt } from "./prompt.mjs";
import { createAskURLTool } from "./tools/askURL.mjs";
import { createAskWebTool } from "./tools/askWeb.mjs";
import { createCompactContextTool } from "./tools/compactContext.mjs";
import { createDelegateToSubagentTool } from "./tools/delegateToSubagent.mjs";
import { createExecCommandTool } from "./tools/execCommand.mjs";
import { createPatchFileTool } from "./tools/patchFile.mjs";
import { createReportAsSubagentTool } from "./tools/reportAsSubagent.mjs";
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

(async () => {
  const startTime = new Date();
  const sessionId = [
    `${startTime.getFullYear()}-${`0${startTime.getMonth() + 1}`.slice(-2)}-${`0${startTime.getDate()}`.slice(-2)}`,
    `0${startTime.getHours()}`.slice(-2) +
      `0${startTime.getMinutes()}`.slice(-2),
  ].join("-");
  const tmuxSessionId = `agent-${sessionId}`;

  const isBatchMode = cliArgs.subcommand.type === "batch";
  const configFiles =
    cliArgs.subcommand.type === "batch" ||
    cliArgs.subcommand.type === "interactive"
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

    for (const { serverName, tools, cleanup } of mcpResults) {
      mcpTools.push(...tools);
      mcpCleanups.push(cleanup);
      if (!isBatchMode) {
        console.log(
          styleText(
            "green",
            `✅ Successfully connected to MCP server: ${serverName}`,
          ),
        );
      }
    }
  }

  const modelFromConfig = appConfig.model || "";
  const modelFromArgs =
    cliArgs.subcommand.type === "batch" ||
    cliArgs.subcommand.type === "interactive"
      ? cliArgs.subcommand.model
      : null;
  const modelNameWithVariant = modelFromArgs || modelFromConfig;

  const pluginPaths = resolvePluginPaths(appConfig.claudeCodePlugins ?? []);
  const agentRoles = await loadAgentRoles(pluginPaths);
  const prompts = await loadPrompts(pluginPaths);

  const prompt = createPrompt({
    username: USER_NAME,
    modelName: modelNameWithVariant,
    sessionId,
    tmuxSessionId,
    workingDir: process.cwd(),
    projectMetadataDir: AGENT_PROJECT_METADATA_DIR,
    agentRoles,
    skills: Array.from(prompts.values()).filter((p) => p.isSkill),
  });

  const builtinTools = [
    createExecCommandTool({ sandbox: appConfig.sandbox }),
    writeFileTool,
    createPatchFileTool(),
    createTmuxCommandTool({ sandbox: appConfig.sandbox }),
    createCompactContextTool(),
    createDelegateToSubagentTool(),
    createReportAsSubagentTool(),
  ];

  if (appConfig.tools?.askWeb) {
    builtinTools.push(createAskWebTool(appConfig.tools.askWeb));
  }

  if (appConfig.tools?.askURL) {
    builtinTools.push(createAskURLTool(appConfig.tools.askURL));
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
  });

  const sessionOptions = {
    userEventEmitter,
    agentEventEmitter,
    agentCommands,
    sessionId,
    modelName: modelNameWithVariant,
    sandbox: Boolean(appConfig.sandbox),
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
      notifyCmd: appConfig.notifyCmd || AGENT_NOTIFY_CMD_DEFAULT,
      claudeCodePlugins: resolvePluginPaths(appConfig.claudeCodePlugins ?? []),
    });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
