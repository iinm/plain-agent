
import assert from "node:assert";
import test, { describe } from "node:test";
import { createAgentLoop, createInputHandler } from "./agentLoop.mjs";
import { createStateManager } from "./agentState.mjs";
import { createToolExecutor } from "./toolExecutor.mjs";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @param {import("./model").Message[]} [initial] */
function createTestStateManager(initial = []) {
  return createStateManager(initial, { onMessagesAppended: () => {} });
}

/**
 * @param {(import("./model").ModelOutput | Error)[]} responses
 * @returns {import("./model").CallModel}
 */
function createMockCallModel(responses) {
  let callIndex = 0;
  return async (input) => {
    const response = responses[callIndex++];
    if (!response) throw new Error("No more mock responses");
    // call onPartialMessageContent if provided and response is not Error
    if (!(response instanceof Error) && input.onPartialMessageContent) {
      for (const part of response.message.content) {
        if (part.type === "text") {
          input.onPartialMessageContent({
            type: "text",
            position: "start",
          });
          input.onPartialMessageContent({
            type: "text",
            position: "delta",
            content: part.text,
          });
          input.onPartialMessageContent({
            type: "text",
            position: "stop",
          });
        }
      }
    }
    return response;
  };
}

/**
 * @param {import("./tool").ToolUseDecision} [defaultDecision]
 * @returns {import("./tool").ToolUseApprover}
 */
function createMockToolUseApprover(
  defaultDecision = /** @type {import("./tool").ToolUseDecision} */ ({ action: "allow" }),
) {
  return {
    isAllowedToolUse: () => defaultDecision,
    allowToolUse: () => {},
    resetApprovalCount: () => {},
    getAllowedToolUseInSession: () => [],
    restoreAllowedToolUseInSession: () => {},
  };
}

/** @returns {import("./subagent.mjs").SubagentManager} */
function createMockSubagentManager() {
  return /** @type {import("./subagent.mjs").SubagentManager} */ (/** @type {unknown} */ ({
    isSubagentActive: () => false,
    processToolResults: (/** @type {import("./model").MessageContentToolUse[]} */ _toolUses, /** @type {import("./model").MessageContentToolResult[]} */ _results, /** @type {import("./model").Message[]} */ messages) => ({
      messages,
      newMessage: null,
    }),
    getActiveSubagent: () => null,
    switchToSubagent: () => (/** @type {const} */ ({ success: true, value: "switched" })),
    switchToMainAgent: async () => (/** @type {const} */ ({
      success: true,
      memoryContent: "memory",
    })),
    restoreState: () => {},
    getState: () => ({ subagents: [], subagentCount: 0 }),
  }));
}

function createMockPauseSignal() {
  let paused = false;
  return {
    isPaused: () => paused,
    reset: () => {
      paused = false;
    },
    pause: () => {
      paused = true;
    },
  };
}

/**
 * @param {string} text
 * @returns {import("./model").ModelOutput}
 */
function textResponse(text) {
  return {
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    providerTokenUsage: { input_tokens: 10, output_tokens: 5 },
  };
}

/**
 * @param {string} toolName
 * @param {string} toolUseId
 * @param {Record<string, unknown>} input
 * @returns {import("./model").ModelOutput}
 */
function toolUseResponse(toolName, toolUseId, input) {
  return {
    message: {
      role: "assistant",
      content: [{ type: "tool_use", toolName, toolUseId, input }],
    },
    providerTokenUsage: { input_tokens: 10, output_tokens: 5 },
  };
}

/**
 * @param {string} thinking
 * @returns {import("./model").ModelOutput}
 */
function thinkingResponse(thinking) {
  return {
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking }],
    },
  };
}

/**
 * @typedef {import("./agent").AgentEventEmitter & { emitted: Record<string, unknown[]> }} MockEmitter
 */

/** @returns {MockEmitter} */
function createMockAgentEventEmitter() {
  /** @type {Record<string, unknown[]>} */
  const emitted = {};
  return /** @type {MockEmitter} */ (/** @type {unknown} */ ({
    emit: (/** @type {string} */ event, /** @type {unknown[]} */ ...args) => {
      if (!emitted[event]) emitted[event] = [];
      emitted[event].push(args.length <= 1 ? args[0] : args);
    },
    on: () => {},
    emitted,
  }));
}

/** @type {import("./model").Message} */
const systemMessage = {
  role: "system",
  content: [{ type: "text", text: "You are a test assistant." }],
};

// ---------------------------------------------------------------------------
// createAgentLoop tests
// ---------------------------------------------------------------------------

describe("createAgentLoop", () => {
  test("should call model and end loop when model returns text only", async () => {
    // given:
    const stateManager = createTestStateManager([systemMessage]);
    const emitter = createMockAgentEventEmitter();
    const { handleUserInput } = createAgentLoop({
      callModel: createMockCallModel([textResponse("Hello!")]),
      stateManager,
      toolDefs: [],
      toolExecutor: createToolExecutor(new Map()),
      agentEventEmitter: emitter,
      toolUseApprover: createMockToolUseApprover(),
      subagentManager: createMockSubagentManager(),
      pauseSignal: createMockPauseSignal(),
    });

    // when:
    await handleUserInput([{ type: "text", text: "Hi" }]);

    // then:
    const messages = stateManager.getMessages();
    assert.strictEqual(messages.length, 3); // system + user + assistant
    assert.strictEqual(messages[1].role, "user");
    assert.strictEqual(messages[2].role, "assistant");
    assert.strictEqual(/** @type {import("./model").MessageContentText} */ (messages[2].content[0]).text, "Hello!");
    assert.ok(emitter.emitted.turnEnd);
  });

  test("should execute approved tool use and continue loop", async () => {
    // given:
    const echoTool = {
      def: { name: "echo", description: "Echo", inputSchema: {} },
      impl: async (/** @type {Record<string, unknown>} */ input) => `echoed: ${input.text}`,
    };
    const toolByName = new Map([["echo", echoTool]]);
    const stateManager = createTestStateManager([systemMessage]);
    const emitter = createMockAgentEventEmitter();
    const { handleUserInput } = createAgentLoop({
      callModel: createMockCallModel([
        toolUseResponse("echo", "tu-1", { text: "hello" }),
        textResponse("Done!"),
      ]),
      stateManager,
      toolDefs: [echoTool.def],
      toolExecutor: createToolExecutor(toolByName),
      agentEventEmitter: emitter,
      toolUseApprover: createMockToolUseApprover(),
      subagentManager: createMockSubagentManager(),
      pauseSignal: createMockPauseSignal(),
    });

    // when:
    await handleUserInput([{ type: "text", text: "Use echo" }]);

    // then:
    const messages = stateManager.getMessages();
    // system + user + assistant(tool_use) + user(tool_result) + assistant(text)
    assert.strictEqual(messages.length, 5);
    assert.strictEqual(messages[2].content[0].type, "tool_use");
    assert.strictEqual(messages[3].role, "user");
    assert.strictEqual(messages[3].content[0].type, "tool_result");
    assert.match(/** @type {import("./model").MessageContentText} */ (/** @type {import("./model").MessageContentToolResult} */ (messages[3].content[0]).content[0]).text, /echoed: hello/);
    assert.strictEqual(/** @type {import("./model").MessageContentText} */ (messages[4].content[0]).text, "Done!");
  });

  test("should emit turnEnd event after loop completes", async () => {
    // given:
    const stateManager = createTestStateManager([systemMessage]);
    const emitter = createMockAgentEventEmitter();
    const { handleUserInput } = createAgentLoop({
      callModel: createMockCallModel([textResponse("Hi")]),
      stateManager,
      toolDefs: [],
      toolExecutor: createToolExecutor(new Map()),
      agentEventEmitter: emitter,
      toolUseApprover: createMockToolUseApprover(),
      subagentManager: createMockSubagentManager(),
      pauseSignal: createMockPauseSignal(),
    });

    // when:
    await handleUserInput([{ type: "text", text: "Hello" }]);

    // then:
    assert.ok(emitter.emitted.turnEnd);
    assert.strictEqual(emitter.emitted.turnEnd.length, 1);
  });

  test("should emit providerTokenUsage event", async () => {
    // given:
    const stateManager = createTestStateManager([systemMessage]);
    const emitter = createMockAgentEventEmitter();
    const { handleUserInput } = createAgentLoop({
      callModel: createMockCallModel([textResponse("Hi")]),
      stateManager,
      toolDefs: [],
      toolExecutor: createToolExecutor(new Map()),
      agentEventEmitter: emitter,
      toolUseApprover: createMockToolUseApprover(),
      subagentManager: createMockSubagentManager(),
      pauseSignal: createMockPauseSignal(),
    });

    // when:
    await handleUserInput([{ type: "text", text: "Hello" }]);

    // then:
    assert.ok(emitter.emitted.providerTokenUsage);
    assert.deepStrictEqual(emitter.emitted.providerTokenUsage[0], {
      input_tokens: 10,
      output_tokens: 5,
    });
  });

  test("should emit toolUseRequest when tool needs approval (action: ask)", async () => {
    // given:
    const toolByName = new Map([
      [
        "dangerous",
        {
          def: { name: "dangerous", description: "Dangerous", inputSchema: {} },
          impl: async () => "done",
        },
      ],
    ]);
    const stateManager = createTestStateManager([systemMessage]);
    const emitter = createMockAgentEventEmitter();
    const { handleUserInput } = createAgentLoop({
      callModel: createMockCallModel([
        toolUseResponse("dangerous", "tu-1", {}),
      ]),
      stateManager,
      toolDefs: [],
      toolExecutor: createToolExecutor(toolByName),
      agentEventEmitter: emitter,
      toolUseApprover: createMockToolUseApprover({ action: "ask" }),
      subagentManager: createMockSubagentManager(),
      pauseSignal: createMockPauseSignal(),
    });

    // when:
    await handleUserInput([{ type: "text", text: "Do something dangerous" }]);

    // then:
    assert.ok(emitter.emitted.toolUseRequest);
    // Loop should have broken (no further model calls)
    const messages = stateManager.getMessages();
    assert.strictEqual(messages.length, 3); // system + user + assistant(tool_use)
  });

  test("should add rejection results when tool is denied", async () => {
    // given:
    const toolByName = new Map([
      [
        "blocked",
        {
          def: { name: "blocked", description: "Blocked", inputSchema: {} },
          impl: async () => "done",
        },
      ],
    ]);
    const stateManager = createTestStateManager([systemMessage]);
    const emitter = createMockAgentEventEmitter();
    const { handleUserInput } = createAgentLoop({
      callModel: createMockCallModel([
        toolUseResponse("blocked", "tu-1", {}),
        textResponse("OK, I won't do that."),
      ]),
      stateManager,
      toolDefs: [],
      toolExecutor: createToolExecutor(toolByName),
      agentEventEmitter: emitter,
      toolUseApprover: createMockToolUseApprover({
        action: "deny",
        reason: "Not allowed",
      }),
      subagentManager: createMockSubagentManager(),
      pauseSignal: createMockPauseSignal(),
    });

    // when:
    await handleUserInput([{ type: "text", text: "Do blocked thing" }]);

    // then:
    const messages = stateManager.getMessages();
    // system + user + assistant(tool_use) + user(rejection) + assistant(text)
    assert.strictEqual(messages.length, 5);
    assert.strictEqual(messages[3].role, "user");
    assert.strictEqual(messages[3].content[0].type, "tool_result");
    assert.strictEqual(messages[3].content[0].isError, true);
    assert.match(/** @type {import("./model").MessageContentText} */ (/** @type {import("./model").MessageContentToolResult} */ (messages[3].content[0]).content[0]).text, /rejected/);
  });

  test("should add validation error results when tool validation fails", async () => {
    // given:
    const stateManager = createTestStateManager([systemMessage]);
    const emitter = createMockAgentEventEmitter();
    const { handleUserInput } = createAgentLoop({
      callModel: createMockCallModel([
        toolUseResponse("nonexistent", "tu-1", {}),
        textResponse("Sorry about that."),
      ]),
      stateManager,
      toolDefs: [],
      toolExecutor: createToolExecutor(new Map()),
      agentEventEmitter: emitter,
      toolUseApprover: createMockToolUseApprover(),
      subagentManager: createMockSubagentManager(),
      pauseSignal: createMockPauseSignal(),
    });

    // when:
    await handleUserInput([{ type: "text", text: "Use nonexistent" }]);

    // then:
    const messages = stateManager.getMessages();
    // system + user + assistant(tool_use) + user(validation error) + assistant(text)
    assert.strictEqual(messages.length, 5);
    assert.strictEqual(messages[3].role, "user");
    assert.strictEqual(/** @type {import("./model").MessageContentToolResult} */ (messages[3].content[0]).isError, true);
    assert.match(/** @type {import("./model").MessageContentText} */ (/** @type {import("./model").MessageContentToolResult} */ (messages[3].content[0]).content[0]).text, /Tool not found/);
  });

  test("should emit error event when model returns Error", async () => {
    // given:
    const stateManager = createTestStateManager([systemMessage]);
    const emitter = createMockAgentEventEmitter();
    const { handleUserInput } = createAgentLoop({
      callModel: createMockCallModel([new Error("API unavailable")]),
      stateManager,
      toolDefs: [],
      toolExecutor: createToolExecutor(new Map()),
      agentEventEmitter: emitter,
      toolUseApprover: createMockToolUseApprover(),
      subagentManager: createMockSubagentManager(),
      pauseSignal: createMockPauseSignal(),
    });

    // when:
    await handleUserInput([{ type: "text", text: "Hello" }]);

    // then:
    assert.ok(emitter.emitted.error);
    assert.strictEqual(/** @type {Error} */ (emitter.emitted.error[0]).message, "API unavailable");
    assert.ok(emitter.emitted.turnEnd);
  });

  test("should send 'System: Continue' when model returns only thinking", async () => {
    // given:
    const stateManager = createTestStateManager([systemMessage]);
    const emitter = createMockAgentEventEmitter();
    const { handleUserInput } = createAgentLoop({
      callModel: createMockCallModel([
        thinkingResponse("Let me think..."),
        textResponse("Here's my answer."),
      ]),
      stateManager,
      toolDefs: [],
      toolExecutor: createToolExecutor(new Map()),
      agentEventEmitter: emitter,
      toolUseApprover: createMockToolUseApprover(),
      subagentManager: createMockSubagentManager(),
      pauseSignal: createMockPauseSignal(),
    });

    // when:
    await handleUserInput([{ type: "text", text: "Think about this" }]);

    // then:
    const messages = stateManager.getMessages();
    // system + user + assistant(thinking) + user("System: Continue") + assistant(text)
    assert.strictEqual(messages.length, 5);
    assert.strictEqual(messages[3].role, "user");
    assert.strictEqual(/** @type {import("./model").MessageContentText} */ (messages[3].content[0]).text, "System: Continue");
  });

  test("should break after max thinking loops (5)", async () => {
    // given:
    const thinkingResponses = Array.from({ length: 6 }, (_, i) =>
      thinkingResponse(`Thinking ${i + 1}`),
    );
    const stateManager = createTestStateManager([systemMessage]);
    const emitter = createMockAgentEventEmitter();
    const { handleUserInput } = createAgentLoop({
      callModel: createMockCallModel(thinkingResponses),
      stateManager,
      toolDefs: [],
      toolExecutor: createToolExecutor(new Map()),
      agentEventEmitter: emitter,
      toolUseApprover: createMockToolUseApprover(),
      subagentManager: createMockSubagentManager(),
      pauseSignal: createMockPauseSignal(),
    });

    // when:
    await handleUserInput([{ type: "text", text: "Think forever" }]);

    // then:
    const messages = stateManager.getMessages();
    // After 6th thinking response (loop > 5), it breaks
    // system + user + (thinking + continue) * 5 + thinking_6
    assert.strictEqual(messages.length, 13);
    assert.ok(emitter.emitted.turnEnd);
  });

  test("should break loop when pauseSignal is paused", async () => {
    // given:
    const pauseSignal = createMockPauseSignal();
    const stateManager = createTestStateManager([systemMessage]);
    const emitter = createMockAgentEventEmitter();

    let modelCallCount = 0;
    const callModel = async (/** @type {import("./model").ModelInput} */ _input) => {
      modelCallCount++;
      if (modelCallCount === 1) {
        // First call returns tool use, then we pause
        pauseSignal.pause();
        return toolUseResponse("echo", "tu-1", { text: "hi" });
      }
      return textResponse("Should not reach here");
    };

    const toolByName = new Map([
      [
        "echo",
        {
          def: { name: "echo", description: "Echo", inputSchema: {} },
          impl: async () => "echoed",
        },
      ],
    ]);

    const { handleUserInput } = createAgentLoop({
      callModel,
      stateManager,
      toolDefs: [],
      toolExecutor: createToolExecutor(toolByName),
      agentEventEmitter: emitter,
      toolUseApprover: createMockToolUseApprover(),
      subagentManager: createMockSubagentManager(),
      pauseSignal,
    });

    // when:
    await handleUserInput([{ type: "text", text: "Do something" }]);

    // then:
    // Loop breaks at start of second iteration because pauseSignal is paused
    assert.strictEqual(modelCallCount, 1);
    assert.ok(emitter.emitted.turnEnd);
  });

  test("should delegate tool result handling to subagentManager", async () => {
    // given:
    let processToolResultsCalled = false;
    const subagentManager = createMockSubagentManager();
    subagentManager.processToolResults = (_toolUses, _results, messages) => {
      processToolResultsCalled = true;
      return {
        messages,
        newMessage: {
          role: "user",
          content: [{ type: "text", text: "Subagent processed" }],
        },
      };
    };

    const toolByName = new Map([
      [
        "echo",
        {
          def: { name: "echo", description: "Echo", inputSchema: {} },
          impl: async () => "result",
        },
      ],
    ]);

    const stateManager = createTestStateManager([systemMessage]);
    const emitter = createMockAgentEventEmitter();
    const { handleUserInput } = createAgentLoop({
      callModel: createMockCallModel([
        toolUseResponse("echo", "tu-1", {}),
        textResponse("Done"),
      ]),
      stateManager,
      toolDefs: [],
      toolExecutor: createToolExecutor(toolByName),
      agentEventEmitter: emitter,
      toolUseApprover: createMockToolUseApprover(),
      subagentManager,
      pauseSignal: createMockPauseSignal(),
    });

    // when:
    await handleUserInput([{ type: "text", text: "Test" }]);

    // then:
    assert.ok(processToolResultsCalled);
    // subagentManager returned newMessage, so that should be appended
    const messages = stateManager.getMessages();
    const subagentMsg = messages.find(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (c) => c.type === "text" && c.text === "Subagent processed",
        ),
    );
    assert.ok(subagentMsg);
  });
});

// ---------------------------------------------------------------------------
// createInputHandler tests
// ---------------------------------------------------------------------------

describe("createInputHandler", () => {
  test("should append user message for text input", async () => {
    // given:
    const stateManager = createTestStateManager([systemMessage]);
    const { handle } = createInputHandler({
      stateManager,
      toolExecutor: createToolExecutor(new Map()),
      subagentManager: createMockSubagentManager(),
      toolUseApprover: createMockToolUseApprover(),
    });

    // when:
    await handle([{ type: "text", text: "Hello" }]);

    // then:
    const messages = stateManager.getMessages();
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[1].role, "user");
    assert.strictEqual(/** @type {import("./model").MessageContentText} */ (messages[1].content[0]).text, "Hello");
  });

  test("should execute tools on approval ('y')", async () => {
    // given:
    const toolByName = new Map([
      [
        "echo",
        {
          def: { name: "echo", description: "Echo", inputSchema: {} },
          impl: async () => "echoed",
        },
      ],
    ]);
    const stateManager = createTestStateManager([
      systemMessage,
      {
        role: "assistant",
        content: [
          { type: "tool_use", toolName: "echo", toolUseId: "tu-1", input: {} },
        ],
      },
    ]);
    const { handle } = createInputHandler({
      stateManager,
      toolExecutor: createToolExecutor(toolByName),
      subagentManager: createMockSubagentManager(),
      toolUseApprover: createMockToolUseApprover(),
    });

    // when:
    await handle([{ type: "text", text: "y" }]);

    // then:
    const messages = stateManager.getMessages();
    const lastUserMsg = messages.filter((m) => m.role === "user").at(-1);
    assert.ok(lastUserMsg);
    assert.strictEqual(lastUserMsg.content[0].type, "tool_result");
    assert.strictEqual(/** @type {import("./model").MessageContentText} */ (/** @type {import("./model").MessageContentToolResult} */ (lastUserMsg.content[0]).content[0]).text, "echoed");
  });

  test("should execute tools and call allowToolUse on approval ('Y')", async () => {
    // given:
    const toolByName = new Map([
      [
        "echo",
        {
          def: { name: "echo", description: "Echo", inputSchema: {} },
          impl: async () => "echoed",
        },
      ],
    ]);
    /** @type {string[]} */
    const allowedTools = [];
    const toolUseApprover = createMockToolUseApprover();
    toolUseApprover.allowToolUse = (toolUse) => {
      allowedTools.push(toolUse.toolName);
    };

    const stateManager = createTestStateManager([
      systemMessage,
      {
        role: "assistant",
        content: [
          { type: "tool_use", toolName: "echo", toolUseId: "tu-1", input: {} },
        ],
      },
    ]);
    const { handle } = createInputHandler({
      stateManager,
      toolExecutor: createToolExecutor(toolByName),
      subagentManager: createMockSubagentManager(),
      toolUseApprover,
    });

    // when:
    await handle([{ type: "text", text: "Y" }]);

    // then:
    assert.deepStrictEqual(allowedTools, ["echo"]);
  });

  test("should add rejection results and user message on denial", async () => {
    // given:
    const stateManager = createTestStateManager([
      systemMessage,
      {
        role: "assistant",
        content: [
          { type: "tool_use", toolName: "echo", toolUseId: "tu-1", input: {} },
        ],
      },
    ]);
    const { handle } = createInputHandler({
      stateManager,
      toolExecutor: createToolExecutor(new Map()),
      subagentManager: createMockSubagentManager(),
      toolUseApprover: createMockToolUseApprover(),
    });

    // when:
    await handle([{ type: "text", text: "no, do something else" }]);

    // then:
    const messages = stateManager.getMessages();
    // system + assistant(tool_use) + user(rejection tool_result) + user(text)
    assert.strictEqual(messages.length, 4);
    assert.strictEqual(messages[2].content[0].type, "tool_result");
    assert.strictEqual(/** @type {import("./model").MessageContentToolResult} */ (messages[2].content[0]).isError, true);
    assert.match(/** @type {import("./model").MessageContentText} */ (/** @type {import("./model").MessageContentToolResult} */ (messages[2].content[0]).content[0]).text, /rejected/);
    assert.strictEqual(messages[3].role, "user");
    assert.strictEqual(/** @type {import("./model").MessageContentText} */ (messages[3].content[0]).text, "no, do something else");
  });

  test("should do nothing on /resume", async () => {
    // given:
    const stateManager = createTestStateManager([systemMessage]);
    const messageCountBefore = stateManager.getMessages().length;
    const { handle } = createInputHandler({
      stateManager,
      toolExecutor: createToolExecutor(new Map()),
      subagentManager: createMockSubagentManager(),
      toolUseApprover: createMockToolUseApprover(),
    });

    // when:
    await handle([{ type: "text", text: "/resume" }]);

    // then:
    assert.strictEqual(stateManager.getMessages().length, messageCountBefore);
  });
});
