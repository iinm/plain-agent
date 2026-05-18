
import assert from "node:assert";
import test, { describe } from "node:test";
import { callAnthropicModel } from "./anthropic.mjs";

// ---------------------------------------------------------------------------
// Stream encoder helpers
// ---------------------------------------------------------------------------

/**
 * Encode Anthropic SSE events into a ReadableStream.
 * Format: "event: {type}\ndata: {json}\n\n"
 * @param {{type: string; [key: string]: unknown}[]} events
 * @returns {ReadableStream<Uint8Array>}
 */
function encodeAnthropicSSE(events) {
  const encoder = new TextEncoder();
  const chunks = events.map((event) =>
    encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
  );
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const platformConfig = /** @type {const} */ ({
  name: "anthropic",
  variant: "default",
  baseURL: "https://api.anthropic.com",
  apiKey: "test-key",
});

const modelConfig = {
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
};

/**
 * @param {string} userText
 * @param {{tools?: import("../tool").ToolDefinition[], onPartialMessageContent?: import("../model").ModelInput["onPartialMessageContent"]}} [options]
 * @returns {import("../model").ModelInput}
 */
function simpleInput(userText, options = {}) {
  return {
    messages: [
      {
        role: "system",
        content: [{ type: "text", text: "You are a test assistant." }],
      },
      {
        role: "user",
        content: [{ type: "text", text: userText }],
      },
    ],
    tools: options.tools || [],
    onPartialMessageContent: options.onPartialMessageContent,
  };
}

/**
 * Build a text response stream event sequence.
 * @param {string} text
 * @returns {{type: string; [key: string]: unknown}[]}
 */
function textStreamEvents(text) {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-20250514",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
}

/**
 * Build a tool_use response stream event sequence.
 * @param {string} id
 * @param {string} name
 * @param {Record<string, unknown>} input
 * @returns {{type: string; [key: string]: unknown}[]}
 */
function toolUseStreamEvents(id, name, input) {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-20250514",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 15, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: "message_stop" },
  ];
}

/**
 * Build a thinking + text response stream event sequence.
 * @param {string} thinking
 * @param {string} text
 * @returns {{type: string; [key: string]: unknown}[]}
 */
function thinkingTextStreamEvents(thinking, text) {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-20250514",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig_test_abc" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("callAnthropicModel", () => {
  test("should return ModelOutput for text response", async (t) => {
    // given:
    t.mock.method(globalThis, "fetch", async () => {
      return new Response(encodeAnthropicSSE(textStreamEvents("Hello!")), {
        status: 200,
      });
    });

    // when:
    const result = await callAnthropicModel(
      platformConfig,
      modelConfig,
      simpleInput("Hi"),
    );

    // then:
    assert.ok(!(result instanceof Error));
    assert.strictEqual(result.message.role, "assistant");
    assert.strictEqual(result.message.content.length, 1);
    assert.strictEqual(result.message.content[0].type, "text");
    assert.strictEqual(result.message.content[0].text, "Hello!");
    assert.ok(result.providerTokenUsage);
    assert.strictEqual(result.providerTokenUsage.input_tokens, 10);
    assert.strictEqual(result.providerTokenUsage.output_tokens, 5);
  });

  test("should return ModelOutput for tool_use response", async (t) => {
    // given:
    t.mock.method(globalThis, "fetch", async () => {
      return new Response(
        encodeAnthropicSSE(
          toolUseStreamEvents("tu-1", "readFile", { path: "/tmp/test.txt" }),
        ),
        { status: 200 },
      );
    });

    const tools = [
      {
        name: "readFile",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ];

    // when:
    const result = await callAnthropicModel(
      platformConfig,
      modelConfig,
      simpleInput("Read the file", { tools }),
    );

    // then:
    assert.ok(!(result instanceof Error));
    assert.strictEqual(result.message.content[0].type, "tool_use");
    assert.strictEqual(result.message.content[0].toolName, "readFile");
    assert.strictEqual(result.message.content[0].toolUseId, "tu-1");
    assert.deepStrictEqual(result.message.content[0].input, {
      path: "/tmp/test.txt",
    });
  });

  test("should return ModelOutput for thinking + text response", async (t) => {
    // given:
    t.mock.method(globalThis, "fetch", async () => {
      return new Response(
        encodeAnthropicSSE(
          thinkingTextStreamEvents("Let me think...", "Here's the answer."),
        ),
        { status: 200 },
      );
    });

    // when:
    const result = await callAnthropicModel(
      platformConfig,
      { ...modelConfig, thinking: { type: "enabled", budget_tokens: 1024 } },
      simpleInput("Think about this"),
    );

    // then:
    assert.ok(!(result instanceof Error));
    assert.strictEqual(result.message.content.length, 2);
    assert.strictEqual(result.message.content[0].type, "thinking");
    const thinkingPart = /** @type {import("../model").MessageContentThinking} */ (result.message.content[0]);
    assert.strictEqual(thinkingPart.thinking, "Let me think...");
    assert.strictEqual(
      /** @type {string} */ (thinkingPart.provider?.fields?.signature),
      "sig_test_abc",
    );
    assert.strictEqual(result.message.content[1].type, "text");
    assert.strictEqual(result.message.content[1].text, "Here's the answer.");
  });

  test("should call onPartialMessageContent with correct sequence", async (t) => {
    // given:
    t.mock.method(globalThis, "fetch", async () => {
      return new Response(encodeAnthropicSSE(textStreamEvents("Hi")), {
        status: 200,
      });
    });

    /** @type {import("../model").PartialMessageContent[]} */
    const partials = [];

    // when:
    await callAnthropicModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello", {
        onPartialMessageContent: (/** @type {import("../model").PartialMessageContent} */ p) => partials.push({ ...p }),
      }),
    );

    // then:
    assert.ok(partials.length >= 3);
    assert.strictEqual(partials[0].type, "text");
    assert.strictEqual(partials[0].position, "start");
    const deltas = partials.filter((p) => p.position === "delta");
    assert.ok(deltas.length >= 1);
    assert.strictEqual(deltas[0].content, "Hi");
    assert.strictEqual(/** @type {import("../model").PartialMessageContent} */ (partials.at(-1)).position, "stop");
  });

  test("should verify request body structure", async (t) => {
    // given:
    /** @type {Record<string, unknown> | undefined} */
    let capturedBody;
    t.mock.method(globalThis, "fetch", async (/** @type {string} */ _url, /** @type {{body: string, headers: Record<string, string>}} */ options) => {
      capturedBody = JSON.parse(options.body);
      return new Response(encodeAnthropicSSE(textStreamEvents("OK")), {
        status: 200,
      });
    });

    const tools = [
      {
        name: "echo",
        description: "Echo tool",
        inputSchema: { type: "object" },
      },
    ];

    // when:
    await callAnthropicModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello", { tools }),
    );

    // then:
    assert.ok(capturedBody);
    const body = /** @type {Record<string, unknown>} */ (capturedBody);
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.model, "claude-sonnet-4-20250514");
    assert.strictEqual(body.max_tokens, 1024);
    // system messages extracted to top-level system field
    const system = /** @type {Record<string, unknown>[]} */ (body.system);
    assert.ok(Array.isArray(system));
    assert.strictEqual(system[0].text, "You are a test assistant.");
    // messages should not include system
    const msgs = /** @type {Record<string, unknown>[]} */ (body.messages);
    assert.ok(msgs.every((m) => m.role !== "system"));
    // tools converted to Anthropic format
    const bodyTools = /** @type {Record<string, unknown>[]} */ (body.tools);
    assert.ok(bodyTools);
    assert.strictEqual(bodyTools[0].name, "echo");
    assert.ok(bodyTools[0].input_schema);
  });

  test("should add cache_control to system and last 2 user messages", async (t) => {
    // given:
    /** @type {Record<string, unknown> | undefined} */
    let capturedBody;
    t.mock.method(globalThis, "fetch", async (/** @type {string} */ _url, /** @type {{body: string, headers: Record<string, string>}} */ options) => {
      capturedBody = JSON.parse(options.body);
      return new Response(encodeAnthropicSSE(textStreamEvents("OK")), {
        status: 200,
      });
    });

    const input = {
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "System prompt" }],
        },
        { role: "user", content: [{ type: "text", text: "First question" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "First answer" }],
        },
        { role: "user", content: [{ type: "text", text: "Second question" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "Second answer" }],
        },
        { role: "user", content: [{ type: "text", text: "Third question" }] },
      ],
      tools: [],
    };

    // when:
    await callAnthropicModel(platformConfig, modelConfig, /** @type {import("../model").ModelInput} */ (/** @type {unknown} */ (input)));

    // then:
    // system field uses original messages (no cache_control)
    // cache_control is only added to the messages array (non-system)

    // Last 2 user messages should have cache_control
    assert.ok(capturedBody);
    const cacheBody = /** @type {Record<string, unknown>} */ (capturedBody);
    const userMessages = /** @type {Record<string, unknown>[]} */ (/** @type {Record<string, unknown>[]} */ (cacheBody.messages).filter((m) => m.role === "user"));
    const lastUser = /** @type {Record<string, unknown>} */ (userMessages.at(-1));
    const secondLastUser = /** @type {Record<string, unknown>} */ (userMessages.at(-2));
    const lastUserContent = /** @type {Record<string, unknown>[]} */ (lastUser.content);
    const secondLastUserContent = /** @type {Record<string, unknown>[]} */ (secondLastUser.content);
    const lastPart = /** @type {Record<string, unknown>} */ (lastUserContent.at(-1));
    const secondLastPart = /** @type {Record<string, unknown>} */ (secondLastUserContent.at(-1));
    assert.ok(lastPart.cache_control);
    assert.strictEqual(/** @type {Record<string, unknown>} */ (lastPart.cache_control).type, "ephemeral");
    assert.ok(secondLastPart.cache_control);
    // First user message should NOT have cache_control
    const firstUser = userMessages[0];
    const firstUserContent = /** @type {Record<string, unknown>[]} */ (firstUser.content);
    assert.strictEqual(/** @type {Record<string, unknown>} */ (firstUserContent.at(-1)).cache_control, undefined);
  });

  test("should return Error on HTTP 4xx", async (t) => {
    // given:
    t.mock.method(globalThis, "fetch", async () => {
      return new Response("Bad request", { status: 400 });
    });

    // when:
    const result = await callAnthropicModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello"),
    );

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /status=400/);
  });

  test("should return Error when response body is empty", async (t) => {
    // given:
    t.mock.method(globalThis, "fetch", async () => {
      return new Response(null, { status: 200 });
    });

    // when:
    const result = await callAnthropicModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello"),
    );

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /body is empty/i);
  });

  test("should retry on HTTP 429 and succeed", async (t) => {
    // given:
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let callCount = 0;
    t.mock.method(globalThis, "fetch", async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(encodeAnthropicSSE(textStreamEvents("Retried!")), {
        status: 200,
      });
    });

    // when:
    const resultPromise = callAnthropicModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello"),
    );
    // Allow microtasks to settle so fetch mock resolves
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(2000);
    const result = await resultPromise;

    // then:
    assert.ok(!(result instanceof Error));
    assert.strictEqual(/** @type {import("../model").MessageContentText} */ (result.message.content[0]).text, "Retried!");
    assert.strictEqual(callCount, 2);
  });

  test("should retry on HTTP 5xx and succeed", async (t) => {
    // given:
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let callCount = 0;
    t.mock.method(globalThis, "fetch", async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("server error", { status: 500 });
      }
      return new Response(encodeAnthropicSSE(textStreamEvents("Recovered!")), {
        status: 200,
      });
    });

    // when:
    const resultPromise = callAnthropicModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello"),
    );
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(2000);
    const result = await resultPromise;

    // then:
    assert.ok(!(result instanceof Error));
    assert.strictEqual(/** @type {import("../model").MessageContentText} */ (result.message.content[0]).text, "Recovered!");
    assert.strictEqual(callCount, 2);
  });

  test("should send correct URL and headers for anthropic platform", async (t) => {
    // given:
    /** @type {string | undefined} */
    let capturedUrl;
    /** @type {Record<string, string> | undefined} */
    let capturedHeaders;
    t.mock.method(globalThis, "fetch", async (/** @type {string} */ url, /** @type {{headers: Record<string, string>}} */ options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      return new Response(encodeAnthropicSSE(textStreamEvents("OK")), {
        status: 200,
      });
    });

    // when:
    await callAnthropicModel(platformConfig, modelConfig, simpleInput("Hello"));

    // then:
    assert.strictEqual(capturedUrl, "https://api.anthropic.com/v1/messages");
    assert.ok(capturedHeaders);
    assert.strictEqual(capturedHeaders["x-api-key"], "test-key");
    assert.strictEqual(capturedHeaders["anthropic-version"], "2023-06-01");
    assert.strictEqual(capturedHeaders["Content-Type"], "application/json");
  });

  test("should convert conversation history correctly", async (t) => {
    // given:
    /** @type {Record<string, unknown> | undefined} */
    let capturedBody;
    t.mock.method(globalThis, "fetch", async (/** @type {string} */ _url, /** @type {{body: string}} */ options) => {
      capturedBody = JSON.parse(options.body);
      return new Response(encodeAnthropicSSE(textStreamEvents("OK")), {
        status: 200,
      });
    });

    const input = {
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "System" }],
        },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hi!" },
            {
              type: "tool_use",
              toolUseId: "tu-1",
              toolName: "echo",
              input: { text: "hello" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "tu-1",
              toolName: "echo",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
      ],
      tools: [],
    };

    // when:
    await callAnthropicModel(platformConfig, modelConfig, /** @type {import("../model").ModelInput} */ (/** @type {unknown} */ (input)));

    // then:
    assert.ok(capturedBody);
    const histBody = /** @type {Record<string, unknown>} */ (capturedBody);
    const histMsgs = /** @type {Record<string, unknown>[]} */ (histBody.messages);
    const assistantMsg = /** @type {Record<string, unknown>} */ (histMsgs.find(
      (m) => m.role === "assistant",
    ));
    assert.ok(assistantMsg);
    const assistantContent = /** @type {Record<string, unknown>[]} */ (assistantMsg.content);
    assert.strictEqual(assistantContent[0].type, "text");
    assert.strictEqual(assistantContent[1].type, "tool_use");
    assert.strictEqual(assistantContent[1].id, "tu-1");
    assert.strictEqual(assistantContent[1].name, "echo");

    const toolResultMsg = /** @type {Record<string, unknown>} */ (histMsgs.at(-1));
    assert.strictEqual(toolResultMsg.role, "user");
    const toolResultContent = /** @type {Record<string, unknown>[]} */ (toolResultMsg.content);
    assert.strictEqual(toolResultContent[0].type, "tool_result");
    assert.strictEqual(toolResultContent[0].tool_use_id, "tu-1");
  });
});
