/**
 * @import { AgentEvent } from "./agent"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentSession } from "./agentSession.mjs";
import {
  createEchoTool,
  createScriptedCallModel,
  createToolUseMessage,
  runAndCollect,
  textMessage,
  toolUseMessage,
} from "./utils/test/agentFixtures.mjs";

describe("createAgentSession", () => {
  it("does not run tools without approval by default", async () => {
    // given:
    let implCalls = 0;
    const session = createAgentSession({
      callModel: createScriptedCallModel([toolUseMessage, textMessage]),
      tools: [createEchoTool(() => (implCalls += 1))],
    });

    // when:
    const events = await runAndCollect(session);

    // then:
    assert.strictEqual(implCalls, 0);
    assert.ok(events.some((e) => e.type === "tool_use_request"));
    const sessionStart = events.find((e) => e.type === "session_start");
    assert.ok(sessionStart && sessionStart.type === "session_start");
    assert.strictEqual(sessionStart.modelName, "unknown");
    assert.ok(sessionStart.sessionId.length > 0);
  });

  it("runs the tool when requestToolApproval allows", async () => {
    // given:
    let implCalls = 0;
    const session = createAgentSession({
      callModel: createScriptedCallModel([toolUseMessage, textMessage]),
      tools: [createEchoTool(() => (implCalls += 1))],
      requestToolApproval: async () => ({ action: "allow" }),
    });

    // when:
    await runAndCollect(session);

    // then:
    assert.strictEqual(implCalls, 1);
  });

  it("auto-approves the same call after allowSession with the default approver", async () => {
    // given:
    let implCalls = 0;
    let approvalRequests = 0;
    const session = createAgentSession({
      callModel: createScriptedCallModel([
        createToolUseMessage("t1"),
        createToolUseMessage("t2"),
        textMessage,
      ]),
      tools: [createEchoTool(() => (implCalls += 1))],
      requestToolApproval: async () => {
        approvalRequests += 1;
        return { action: "allowSession" };
      },
    });

    // when:
    /** @type {AgentEvent[]} */
    const events = await runAndCollect(session);

    // then:
    assert.strictEqual(implCalls, 2);
    assert.strictEqual(approvalRequests, 1);
    assert.ok(events.some((e) => e.type === "turn_end"));
  });
});
