import assert from "node:assert";
import { describe, it } from "node:test";
import { createStateManager } from "./agentState.mjs";

/**
 * @param {string} text
 * @returns {import("./model").UserMessage}
 */
function userMessage(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

/**
 * Build a state manager plus a log of every change notification it fires.
 * @param {import("./model").Message[]} initial
 */
function setup(initial) {
  /** @type {import("./agentState.mjs").MessagesChange[]} */
  const changes = [];
  const stateManager = createStateManager(initial, {
    onMessagesChanged: (change) => changes.push(change),
  });
  return { stateManager, changes };
}

describe("appendMessages", () => {
  it("appends and notifies with kind 'append' carrying only the new messages", () => {
    // given:
    const { stateManager, changes } = setup([userMessage("a")]);

    // when:
    stateManager.appendMessages([userMessage("b"), userMessage("c")]);

    // then:
    assert.equal(stateManager.getMessages().length, 3);
    assert.deepEqual(changes, [
      { kind: "append", messages: [userMessage("b"), userMessage("c")] },
    ]);
  });
});

describe("setMessages", () => {
  it("replaces all messages and notifies with kind 'replace' carrying the full history", () => {
    // given:
    const { stateManager, changes } = setup([
      userMessage("a"),
      userMessage("b"),
    ]);

    // when:
    stateManager.setMessages([userMessage("x")]);

    // then:
    assert.deepEqual(stateManager.getMessages(), [userMessage("x")]);
    assert.deepEqual(changes, [
      { kind: "replace", messages: [userMessage("x")] },
    ]);
  });
});

describe("markCheckpoint + truncateToMarker", () => {
  it("truncates back to the marked message (removing it and everything after) and notifies replace", () => {
    // given:
    const { stateManager, changes } = setup([
      userMessage("a"),
      userMessage("b"),
    ]);
    // marker points at the current last message ("b")
    const marker = stateManager.markCheckpoint();
    changes.length = 0;

    // when:
    stateManager.appendMessages([userMessage("c"), userMessage("d")]);
    stateManager.truncateToMarker(marker);

    // then: "b" and everything appended after it are gone
    assert.deepEqual(stateManager.getMessages(), [userMessage("a")]);
    assert.equal(changes.at(-1)?.kind, "replace");
    assert.deepEqual(changes.at(-1)?.messages, [userMessage("a")]);
  });

  it("invalidates the marker after it is consumed", () => {
    // given:
    const { stateManager } = setup([userMessage("a"), userMessage("b")]);
    const marker = stateManager.markCheckpoint();

    // when:
    stateManager.truncateToMarker(marker);

    // then:
    assert.throws(() => stateManager.truncateToMarker(marker), /unknown/);
  });

  it("throws for an unknown marker", () => {
    // given:
    const a = setup([userMessage("a")]);
    const b = setup([userMessage("a")]);
    const foreignMarker = b.stateManager.markCheckpoint();

    // when / then:
    assert.throws(
      () => a.stateManager.truncateToMarker(foreignMarker),
      /unknown/,
    );
  });

  it("invalidates outstanding markers when the history is replaced", () => {
    // given:
    const { stateManager } = setup([userMessage("a"), userMessage("b")]);
    const marker = stateManager.markCheckpoint();

    // when:
    stateManager.setMessages([userMessage("x")]);

    // then:
    assert.throws(() => stateManager.truncateToMarker(marker), /unknown/);
  });
});

describe("serializeMarker + reviveMarker", () => {
  it("round-trips a marker through its serialized index", () => {
    // given:
    const { stateManager } = setup([
      userMessage("a"),
      userMessage("b"),
      userMessage("c"),
    ]);
    const marker = stateManager.markCheckpoint(); // points at index 2 ("c")

    // when:
    const index = stateManager.serializeMarker(marker);
    const revived = stateManager.reviveMarker(index);

    // then:
    assert.equal(index, 2);
    stateManager.truncateToMarker(revived);
    assert.deepEqual(stateManager.getMessages(), [
      userMessage("a"),
      userMessage("b"),
    ]);
  });

  it("does not consume the marker on serialize", () => {
    // given:
    const { stateManager } = setup([userMessage("a"), userMessage("b")]);
    const marker = stateManager.markCheckpoint();

    // when:
    stateManager.serializeMarker(marker);

    // then: still usable
    stateManager.truncateToMarker(marker);
    assert.deepEqual(stateManager.getMessages(), [userMessage("a")]);
  });
});
