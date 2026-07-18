/**
 * @import { Agent } from "../agent"
 */

import { persistSessionEvent } from "../sessionStore.mjs";
import { appendUsageRecord, buildUsageRecord } from "../usageStore.mjs";
import { formatCostForBatch } from "./formatter.mjs";

/**
 * @typedef {object} BatchSessionOptions
 * @property {Agent} agent
 * @property {string} task - Task instruction to execute
 * @property {string} sessionId
 * @property {string} modelName
 * @property {boolean} sandbox
 * @property {Date} startTime
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
  sandbox,
  startTime,
  onStop,
}) {
  outputEvent({
    type: "session_start",
    sessionId,
    modelName,
    sandbox,
    timestamp: new Date().toISOString(),
  });

  agent.send([{ type: "text", text: task }]);

  // The first turn_end marks completion of the batch task and ends the session.
  for await (const event of agent.start()) {
    await persistSessionEvent(sessionId, event);
    switch (event.type) {
      case "message":
        outputEvent({
          type: "message",
          message: event.message,
          timestamp: new Date().toISOString(),
        });
        break;

      case "error":
        outputEvent({
          type: "error",
          error: { message: event.error.message, stack: event.error.stack },
          timestamp: new Date().toISOString(),
        });
        process.exit(1);
        break;

      case "subagent_switched":
        outputEvent({
          type: "subagent_switched",
          subagent: event.subagent,
          timestamp: new Date().toISOString(),
        });
        break;

      case "token_usage":
        outputEvent({
          type: "token_usage",
          usage: event.usage,
          timestamp: new Date().toISOString(),
        });
        break;

      case "turn_end": {
        const costSummary = agent.getCostSummary();
        const sessionEnd = { type: "session_end", cost: costSummary };
        await persistSessionEvent(sessionId, sessionEnd);
        outputEvent({
          type: "session_end",
          timestamp: new Date().toISOString(),
          cost: formatCostForBatch(costSummary),
        });

        try {
          const record = buildUsageRecord({
            sessionId,
            mode: "batch",
            modelName,
            workingDir: process.cwd(),
            costSummary,
            now: startTime,
          });
          if (record) await appendUsageRecord(record);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          outputEvent({
            type: "error",
            error: { message: `failed to record usage: ${message}` },
            timestamp: new Date().toISOString(),
          });
        }

        await onStop();
        process.exit(0);
      }
    }
  }
}

/**
 * Output an event as JSON Lines format.
 * Each event is a single line of JSON.
 * @param {object} event
 */
function outputEvent(event) {
  console.log(JSON.stringify(event));
}
