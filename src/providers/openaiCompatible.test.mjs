// @ts-nocheck
import assert from "node:assert";
import test, { describe } from "node:test";
import { callOpenAICompatibleModel } from "./openaiCompatible.mjs";

// ---------------------------------------------------------------------------
// Stream encoder helpers
// ---------------------------------------------------------------------------

/**
 * Encode OpenAI Chat Completions SSE events into a ReadableStream.
 * Format: "data: {json}\n\n" ... "data: [DONE]\n\n"
 * @param {object[]} chunks
 * @returns {ReadableStream<Uint8Array>}
 */
function encodeOpenAICompatibleSSE(chunks) {
  const encoder = new TextEncoder();
  const encoded = chunks.map((chunk) =>
    encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
  );
  encoded.push(encoder.encode("data: [DONE]\n\n"));
  return new ReadableStream({
    start(controller) {
      for (const chunk of encoded) controller.enqueue(chunk);
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const platformConfig = {
  name: "openai-compatible",
  baseURL: "https://api.example.com",
  apiKey: "test-key",
};

const modelConfig = {
  model: "gpt-4o",
};

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
 * Build a text response stream chunk sequence.
 * @param {string} text
 * @returns {object[]}
 */
function textStreamChunks(text) {
  return [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    },
  ];
}

/**
 * Build a tool_calls response stream chunk sequence.
 * @param {string} callId
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {object[]}
 */
function toolCallStreamChunks(callId, name, args) {
  const argsStr = JSON.stringify(args);
  return [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: argsStr },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 10,
        total_tokens: 25,
      },
    },
  ];
}

/**
 * Build a reasoning_content + text response stream chunk sequence.
 * @param {string} thinking
 * @param {string} text
 * @returns {object[]}
 */
function reasoningTextStreamChunks(thinking, text) {
  return [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", reasoning_content: thinking },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("callOpenAICompatibleModel", () => {
  test("should return ModelOutput for text response", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      return new Response(
        encodeOpenAICompatibleSSE(textStreamChunks("Hello!")),
        { status: 200 },
      );
    });

    const result = await callOpenAICompatibleModel(
      platformConfig,
      modelConfig,
      simpleInput("Hi"),
    );

    assert.ok(!(result instanceof Error));
    assert.strictEqual(result.message.role, "assistant");
    assert.strictEqual(result.message.content.length, 1);
    assert.strictEqual(result.message.content[0].type, "text");
    assert.strictEqual(result.message.content[0].text, "Hello!");
    assert.ok(result.providerTokenUsage);
    assert.strictEqual(result.providerTokenUsage.prompt_tokens, 10);
    assert.strictEqual(result.providerTokenUsage.completion_tokens, 5);
  });

  test("should return ModelOutput for tool_calls response", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      return new Response(
        encodeOpenAICompatibleSSE(
          toolCallStreamChunks("call-1", "readFile", {
            path: "/tmp/test.txt",
          }),
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

    const result = await callOpenAICompatibleModel(
      platformConfig,
      modelConfig,
      simpleInput("Read the file", { tools }),
    );

    assert.ok(!(result instanceof Error));
    assert.strictEqual(result.message.content[0].type, "tool_use");
    assert.strictEqual(result.message.content[0].toolName, "readFile");
    assert.strictEqual(result.message.content[0].toolUseId, "call-1");
    assert.deepStrictEqual(result.message.content[0].input, {
      path: "/tmp/test.txt",
    });
  });

  test("should return ModelOutput for reasoning + text response", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      return new Response(
        encodeOpenAICompatibleSSE(
          reasoningTextStreamChunks("Let me think...", "Here's the answer."),
        ),
        { status: 200 },
      );
    });

    const result = await callOpenAICompatibleModel(
      platformConfig,
      modelConfig,
      simpleInput("Think about this"),
    );

    assert.ok(!(result instanceof Error));
    assert.strictEqual(result.message.content.length, 2);
    assert.strictEqual(result.message.content[0].type, "thinking");
    assert.strictEqual(result.message.content[0].thinking, "Let me think...");
    assert.strictEqual(result.message.content[1].type, "text");
    assert.strictEqual(result.message.content[1].text, "Here's the answer.");
  });

  test("should call onPartialMessageContent with correct sequence", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      return new Response(encodeOpenAICompatibleSSE(textStreamChunks("Hi")), {
        status: 200,
      });
    });

    const partials = [];

    await callOpenAICompatibleModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello", {
        onPartialMessageContent: (p) => partials.push({ ...p }),
      }),
    );

    assert.ok(partials.length >= 2);
    const starts = partials.filter((p) => p.position === "start");
    assert.ok(starts.length >= 1);
    assert.strictEqual(starts[0].type, "text");
    const stops = partials.filter((p) => p.position === "stop");
    assert.ok(stops.length >= 1);
  });

  test("should verify request body structure", async (t) => {
    let capturedBody;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return new Response(encodeOpenAICompatibleSSE(textStreamChunks("OK")), {
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

    await callOpenAICompatibleModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello", { tools }),
    );

    assert.ok(capturedBody);
    assert.strictEqual(capturedBody.stream, true);
    assert.strictEqual(capturedBody.model, "gpt-4o");
    // messages should contain system + user
    assert.ok(Array.isArray(capturedBody.messages));
    const systemMsg = capturedBody.messages.find((m) => m.role === "system");
    assert.ok(systemMsg);
    assert.strictEqual(systemMsg.content[0].text, "You are a test assistant.");
    // tools converted to OpenAI format
    assert.ok(capturedBody.tools);
    assert.strictEqual(capturedBody.tools[0].type, "function");
    assert.strictEqual(capturedBody.tools[0].function.name, "echo");
    // stream_options
    assert.ok(capturedBody.stream_options);
    assert.strictEqual(capturedBody.stream_options.include_usage, true);
  });

  test("should send correct URL and headers", async (t) => {
    let capturedUrl;
    let capturedHeaders;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      return new Response(encodeOpenAICompatibleSSE(textStreamChunks("OK")), {
        status: 200,
      });
    });

    await callOpenAICompatibleModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello"),
    );

    assert.strictEqual(
      capturedUrl,
      "https://api.example.com/v1/chat/completions",
    );
    assert.strictEqual(capturedHeaders.Authorization, "Bearer test-key");
    assert.strictEqual(capturedHeaders["Content-Type"], "application/json");
  });

  test("should return Error on HTTP 4xx", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      return new Response("Bad request", { status: 400 });
    });

    const result = await callOpenAICompatibleModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello"),
    );

    assert.ok(result instanceof Error);
    assert.match(result.message, /status=400/);
  });

  test("should return Error when response body is empty", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      return new Response(null, { status: 200 });
    });

    const result = await callOpenAICompatibleModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello"),
    );

    assert.ok(result instanceof Error);
    assert.match(result.message, /body is empty/i);
  });

  test("should retry on HTTP 429 and succeed", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let callCount = 0;
    t.mock.method(globalThis, "fetch", async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(
        encodeOpenAICompatibleSSE(textStreamChunks("Retried!")),
        { status: 200 },
      );
    });

    const resultPromise = callOpenAICompatibleModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello"),
    );
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(2000);
    const result = await resultPromise;

    assert.ok(!(result instanceof Error));
    assert.strictEqual(result.message.content[0].text, "Retried!");
    assert.strictEqual(callCount, 2);
  });

  test("should retry on HTTP 5xx and succeed", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let callCount = 0;
    t.mock.method(globalThis, "fetch", async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("server error", { status: 500 });
      }
      return new Response(
        encodeOpenAICompatibleSSE(textStreamChunks("Recovered!")),
        { status: 200 },
      );
    });

    const resultPromise = callOpenAICompatibleModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello"),
    );
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(2000);
    const result = await resultPromise;

    assert.ok(!(result instanceof Error));
    assert.strictEqual(result.message.content[0].text, "Recovered!");
    assert.strictEqual(callCount, 2);
  });

  test("should convert conversation history correctly", async (t) => {
    let capturedBody;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return new Response(encodeOpenAICompatibleSSE(textStreamChunks("OK")), {
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
              toolUseId: "call-1",
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
              toolUseId: "call-1",
              toolName: "echo",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
      ],
      tools: [],
    };

    await callOpenAICompatibleModel(platformConfig, modelConfig, input);

    // assistant message should have tool_calls
    const assistantMsg = capturedBody.messages.find(
      (m) => m.role === "assistant",
    );
    assert.ok(assistantMsg);
    assert.strictEqual(assistantMsg.content, "Hi!");
    assert.ok(assistantMsg.tool_calls);
    assert.strictEqual(assistantMsg.tool_calls[0].id, "call-1");
    assert.strictEqual(assistantMsg.tool_calls[0].function.name, "echo");

    // tool result converted to tool message
    const toolMsg = capturedBody.messages.find((m) => m.role === "tool");
    assert.ok(toolMsg);
    assert.strictEqual(toolMsg.tool_call_id, "call-1");
    assert.strictEqual(toolMsg.content, "hello");
  });

  test("should retry when stream data conversion fails", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let callCount = 0;
    t.mock.method(globalThis, "fetch", async () => {
      callCount++;
      if (callCount === 1) {
        // empty stream (no chunks) → conversion error
        const emptyStream = new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
        return new Response(emptyStream, { status: 200 });
      }
      return new Response(
        encodeOpenAICompatibleSSE(textStreamChunks("Recovered!")),
        { status: 200 },
      );
    });

    const resultPromise = callOpenAICompatibleModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello"),
    );
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(2000);
    const result = await resultPromise;

    assert.ok(!(result instanceof Error));
    assert.strictEqual(result.message.content[0].text, "Recovered!");
    assert.strictEqual(callCount, 2);
  });
});
