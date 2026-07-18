import assert from "node:assert";
import { describe, it } from "node:test";
import { createStateManager } from "./agentState.mjs";
import { createSubagentManager } from "./subagent.mjs";
import { switchToMainAgentToolName } from "./tools/switchToMainAgent.mjs";

/**
 * @param {string} text
 * @returns {import("./model").UserMessage}
 */
function userMessage(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

/**
 * Assistant message carrying a switch_to_subagent tool use.
 * @returns {import("./model").AssistantMessage}
 */
function switchAssistantMessage() {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        toolUseId: "switch-1",
        toolName: "switch_to_subagent",
        input: {},
      },
    ],
  };
}

/** @returns {import("./model").MessageContentToolUse} */
function reportToolUse() {
  return {
    type: "tool_use",
    toolUseId: "report-1",
    toolName: switchToMainAgentToolName,
    input: { memoryPath: ".agent/memory/report.md" },
  };
}

/**
 * @param {string} text
 * @returns {import("./model").MessageContentToolResult}
 */
function reportToolResult(text) {
  return {
    type: "tool_result",
    toolUseId: "report-1",
    toolName: switchToMainAgentToolName,
    content: [{ type: "text", text }],
  };
}

/**
 * @param {import("./model").Message[]} initial
 */
function setupState(initial) {
  return createStateManager(initial, { onMessagesChanged: () => {} });
}

function noopHandlers() {
  return { onSubagentSwitched: () => {} };
}

describe("subagent switch + report via markers", () => {
  it("truncates the history back through the marker on report and adds a report message", () => {
    // given:
    /** @type {(import("./agentState.mjs").MessagesChange)[]} */
    const changes = [];
    const stateManager = createStateManager(
      [userMessage("system"), userMessage("task")],
      { onMessagesChanged: (c) => changes.push(c) },
    );
    const manager = createSubagentManager(new Map(), noopHandlers());

    // when: the switch tool use is appended, then we mark and switch
    stateManager.appendMessages([switchAssistantMessage()]);
    const switchResult = manager.switchToSubagent(
      "custom:x",
      "do it",
      stateManager.markCheckpoint,
    );
    assert.ok(switchResult.success);

    // subagent produces some conversation
    stateManager.appendMessages([
      userMessage("subagent working"),
      userMessage("more work"),
    ]);
    changes.length = 0;

    // when: subagent reports back
    const result = manager.processToolResults(
      [reportToolUse()],
      [reportToolResult("done summary")],
    );
    assert.ok(result.marker);
    stateManager.truncateToMarker(result.marker);
    if (result.newMessage) {
      stateManager.appendMessages([result.newMessage]);
    }

    // then: subagent conversation and switch message are gone, report added
    const messages = stateManager.getMessages();
    assert.deepEqual(messages.slice(0, 2), [
      userMessage("system"),
      userMessage("task"),
    ]);
    assert.equal(messages.length, 3);
    assert.equal(messages[2].role, "user");
    assert.match(
      /** @type {import("./model").MessageContentText} */ (
        messages[2].content[0]
      ).text,
      /done summary/,
    );
    assert.ok(!manager.isSubagentActive());
    // a replace (truncate) notification fired
    assert.ok(changes.some((c) => c.kind === "replace"));
  });

  it("does not create a checkpoint when the switch is rejected", () => {
    // given: already acting as a subagent
    const stateManager = setupState([userMessage("a")]);
    let created = 0;
    const createCheckpoint = () => {
      created += 1;
      return stateManager.markCheckpoint();
    };
    const manager = createSubagentManager(new Map(), noopHandlers());
    assert.ok(
      manager.switchToSubagent("custom:x", "g", createCheckpoint).success,
    );

    // when: a nested switch is attempted and rejected
    const rejected = manager.switchToSubagent(
      "custom:y",
      "g2",
      createCheckpoint,
    );

    // then: no checkpoint was created for the rejected switch
    assert.equal(rejected.success, false);
    assert.equal(created, 1);
  });

  it("returns no marker when no subagent report is present", () => {
    // given:
    const manager = createSubagentManager(new Map(), noopHandlers());

    // when:
    const result = manager.processToolResults(
      [
        {
          type: "tool_use",
          toolUseId: "x",
          toolName: "read_file",
          input: {},
        },
      ],
      [],
    );

    // then:
    assert.deepEqual(result, { marker: null, newMessage: null });
  });
});

describe("subagent state persistence round-trip", () => {
  it("serializes markers to indices and revives them on restore", () => {
    // given: a switched subagent whose checkpoint points at index 2
    const messages = [
      userMessage("system"),
      userMessage("task"),
      switchAssistantMessage(),
    ];
    const stateA = setupState(messages);
    const managerA = createSubagentManager(new Map(), noopHandlers());
    managerA.switchToSubagent("custom:x", "goal", stateA.markCheckpoint);

    // when: persist
    const saved = managerA.getState(stateA.serializeMarker);

    // then: on-disk form holds a numeric index, not the opaque marker
    assert.equal(saved.subagents.length, 1);
    assert.equal(saved.subagents[0].switchMessageIndex, 2);
    assert.equal(typeof saved.subagents[0].switchMessageIndex, "number");

    // when: restore into a fresh manager + state with the same history
    const stateB = setupState([...messages]);
    const managerB = createSubagentManager(new Map(), noopHandlers());
    managerB.restoreState(saved, stateB.reviveMarker);

    // then: reporting truncates back to the same point
    assert.ok(managerB.isSubagentActive());
    const result = managerB.processToolResults(
      [reportToolUse()],
      [reportToolResult("ok")],
    );
    assert.ok(result.marker);
    stateB.truncateToMarker(result.marker);
    assert.deepEqual(stateB.getMessages(), [
      userMessage("system"),
      userMessage("task"),
    ]);
  });
});
