/**
 * @import { UserEventEmitter, AgentEventEmitter, AgentCommands } from "./agent"
 */

import { formatCostForBatch } from "./cliFormatter.mjs";

/**
 * @typedef {object} BatchSessionOptions
 * @property {UserEventEmitter} userEventEmitter
 * @property {AgentEventEmitter} agentEventEmitter
 * @property {AgentCommands} agentCommands
 * @property {string} task - Task instruction to execute
 * @property {string} sessionId
 * @property {string} modelName
 * @property {boolean} sandbox
 * @property {() => Promise<void>} onStop
 */

/**
 * Start a batch session and execute the task.
 * Events are output as JSON Lines (1 line = 1 JSON object).
 *
 * @param {BatchSessionOptions} options
 * @returns {Promise<void>}
 */
export async function startBatchSession({
  userEventEmitter,
  agentEventEmitter,
  agentCommands,
  task,
  sessionId,
  modelName,
  sandbox,
  onStop,
}) {
  setupEventHandlers(agentEventEmitter, { sessionId, modelName, sandbox });

  userEventEmitter.emit("userInput", [{ type: "text", text: task }]);

  await new Promise((/** @type {(value?: void) => void} */ resolve) => {
    agentEventEmitter.on("turnEnd", async () => {
      const costSummary = agentCommands.getCostSummary();

      outputEvent({
        type: "session_end",
        timestamp: new Date().toISOString(),
        cost: formatCostForBatch(costSummary),
      });
      await onStop();
      resolve();
    });
  });

  process.exit(0);
}

/**
 * Setup event handlers for batch mode.
 * Output events as JSON Lines.
 *
 * @param {AgentEventEmitter} agentEventEmitter
 * @param {{ sessionId: string, modelName: string, sandbox: boolean }} meta
 */
function setupEventHandlers(
  agentEventEmitter,
  { sessionId, modelName, sandbox },
) {
  outputEvent({
    type: "session_start",
    sessionId,
    modelName,
    sandbox,
    timestamp: new Date().toISOString(),
  });

  agentEventEmitter.on("message", (message) => {
    outputEvent({
      type: "message",
      message,
      timestamp: new Date().toISOString(),
    });
  });

  agentEventEmitter.on("error", (error) => {
    outputEvent({
      type: "error",
      error: {
        message: error.message,
        stack: error.stack,
      },
      timestamp: new Date().toISOString(),
    });

    process.exit(1);
  });

  agentEventEmitter.on("subagentSwitched", (subagent) => {
    outputEvent({
      type: "subagent_switched",
      subagent,
      timestamp: new Date().toISOString(),
    });
  });

  agentEventEmitter.on("providerTokenUsage", (usage) => {
    outputEvent({
      type: "token_usage",
      usage,
      timestamp: new Date().toISOString(),
    });
  });
}

/**
 * Output an event as JSON Lines format.
 * Each event is a single line of JSON.
 *
 * @param {object} event
 */
function outputEvent(event) {
  console.log(JSON.stringify(event));
}
