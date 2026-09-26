/**
 * @import { AgentEvent } from "./agent"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgent } from "./agent.mjs";
import {
  createApprover,
  createBaseConfig,
  createEchoTool,
  createScriptedCallModel,
  createToolUseMessage,
  runAndCollect,
  textMessage,
  toolUseMessage,
} from "./utils/test/agentFixtures.mjs";

/**
 * @param {AgentEvent[]} events
 * @returns {import("./model").MessageContentToolResult[]}
 */
function collectToolResults(events) {
  const toolResults = [];
  for (const event of events) {
    if (event.type !== "message") continue;
    for (const part of event.message.content) {
      if (part.type === "tool_result") toolResults.push(part);
    }
  }
  return toolResults;
}

describe("createAgent requestToolApproval", () => {
  it("executes the tool when the callback allows", async () => {
    // given:
    let implCalls = 0;
    const config = createBaseConfig({
      callModel: createScriptedCallModel([toolUseMessage, textMessage]),
      tools: [createEchoTool(() => (implCalls += 1))],
      requestToolApproval: async (request) => {
        assert.strictEqual(request.toolUses.length, 1);
        return { action: "allow" };
      },
    });

    // when:
    const events = await runAndCollect(createAgent(config));

    // then:
    assert.strictEqual(implCalls, 1);
    assert.ok(events.some((e) => e.type === "turn_end"));
  });

  it("auto-approves the same call after allowSession without asking again", async () => {
    // given:
    let implCalls = 0;
    let approvalRequests = 0;
    const config = createBaseConfig({
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
    await runAndCollect(createAgent(config));

    // then:
    assert.strictEqual(implCalls, 2);
    assert.strictEqual(approvalRequests, 1);
  });

  it("skips the tool and reports rejection when denied", async () => {
    // given:
    let implCalls = 0;
    const config = createBaseConfig({
      tools: [createEchoTool(() => (implCalls += 1))],
      requestToolApproval: async () => ({
        action: "deny",
        reason: "not allowed",
      }),
    });

    // when:
    const events = await runAndCollect(createAgent(config));

    // then:
    assert.strictEqual(implCalls, 0);
    assert.deepStrictEqual(collectToolResults(events), [
      {
        type: "tool_result",
        toolUseId: "t1",
        toolName: "echo",
        content: [{ type: "text", text: "Tool call rejected. not allowed" }],
        isError: true,
      },
    ]);
  });

  it("skips the tool and forwards feedback when rejected with feedback", async () => {
    // given:
    let implCalls = 0;
    const config = createBaseConfig({
      tools: [createEchoTool(() => (implCalls += 1))],
      requestToolApproval: async () => ({
        action: "feedback",
        text: "please use read_file instead",
      }),
    });

    // when:
    const events = await runAndCollect(createAgent(config));

    // then:
    assert.strictEqual(implCalls, 0);
    const feedback = events.find(
      (e) =>
        e.type === "message" &&
        e.message.role === "user" &&
        e.message.content.some(
          (part) =>
            part.type === "text" &&
            part.text === "please use read_file instead",
        ),
    );
    assert.ok(feedback);
  });

  it("emits tool_use_request when no callback is given", async () => {
    // given:
    let implCalls = 0;
    const config = createBaseConfig({
      tools: [createEchoTool(() => (implCalls += 1))],
      toolUseApprover: createApprover("ask"),
    });

    // when:
    const events = await runAndCollect(createAgent(config));

    // then:
    assert.strictEqual(implCalls, 0);
    assert.ok(
      events.some((e) => e.type === "tool_use_request" && e.toolUseCount === 1),
    );
  });
});
