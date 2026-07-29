/**
 * @import { Agent, AgentEvent } from "../agent"
 * @import { CostTracker } from "../metrics/costTracker.mjs";
 */

import { appendUsageRecord, buildUsageRecord } from "../metrics/usageStore.mjs";
import { persistSessionEvent } from "../sessionStore.mjs";

const BATCH_OUTPUT_EVENT_TYPES = new Set([
  "session_start",
  "message",
  "token_usage",
  "subagent_switched",
  "session_end",
]);

/**
 * @typedef {object} BatchSessionOptions
 * @property {Agent} agent
 * @property {string} task - Task instruction to execute
 * @property {string} sessionId
 * @property {string} modelName
 * @property {Date} startTime
 * @property {CostTracker} costTracker
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
  agent,
  task,
  sessionId,
  modelName,
  startTime,
  costTracker,
  onStop,
}) {
  agent.send([{ type: "text", text: task }]);

  for await (const event of agent.start()) {
    await persistSessionEvent(sessionId, event);

    if (BATCH_OUTPUT_EVENT_TYPES.has(event.type)) {
      outputEvent(event);
    } else if (event.type === "error") {
      outputEvent(event);
    }

    if (["error", "turn_end"].includes(event.type)) {
      agent.stop();
    }
  }

  const costSummary = costTracker.calculateCost();

  const record = buildUsageRecord({
    sessionId,
    mode: "batch",
    modelName,
    workingDir: process.cwd(),
    costSummary,
    now: startTime,
  });

  if (record) {
    const recordError = await appendUsageRecord(record);
    if (recordError instanceof Error) {
      outputEvent({
        type: "error",
        error: recordError,
        timestamp: new Date(),
      });
    }
  }

  /** @type {AgentEvent} */
  const sessionEnd = {
    timestamp: new Date(),
    type: "session_end",
    cost: costSummary,
  };
  await persistSessionEvent(sessionId, sessionEnd);
  outputEvent(sessionEnd);

  await onStop();
}

/**
 * @param {AgentEvent} event
 */
function outputEvent(event) {
  const { timestamp, ...rest } = event;
  console.log(
    JSON.stringify({
      timestamp: timestamp.toISOString(),
      ...rest,
      ...(rest.type === "error"
        ? { error: { message: rest.error.message } }
        : {}),
    }),
  );
}
