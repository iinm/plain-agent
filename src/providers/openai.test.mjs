// @ts-nocheck
import assert from "node:assert";
import test, { describe } from "node:test";
import { callOpenAIModel } from "./openai.mjs";

// ---------------------------------------------------------------------------
// Stream encoder helpers
// ---------------------------------------------------------------------------

/**
 * Encode OpenAI SSE events into a ReadableStream.
 * Format: "event: {type}\ndata: {json}\n\n"
 * @param {object[]} events
 * @returns {ReadableStream<Uint8Array>}
 */
function encodeOpenAISSE(events) {
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

const platformConfig = {
  name: "openai",
  baseURL: "https://api.openai.com",
  apiKey: "test-key",
};

const modelConfig = {
  model: "o4-mini",
  reasoning: { effort: "medium", summary: "auto" },
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
 * Build a text response stream event sequence.
 * @param {string} text
 * @returns {object[]}
 */
function textStreamEvents(text) {
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_test", status: "in_progress" },
    },
    {
      type: "response.in_progress",
      sequence_number: 1,
      response: { id: "resp_test", status: "in_progress" },
    },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.content_part.added",
      sequence_number: 3,
      item_id: "msg_test",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 4,
      item_id: "msg_test",
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
      obfuscation: "",
    },
    {
      type: "response.output_text.done",
      sequence_number: 5,
      item_id: "msg_test",
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: "response.content_part.done",
      sequence_number: 6,
      item_id: "msg_test",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text },
    },
    {
      type: "response.output_item.done",
      sequence_number: 7,
      output_index: 0,
      item: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
        status: "completed",
      },
    },
    {
      type: "response.completed",
      sequence_number: 8,
      response: {
        id: "resp_test",
        object: "response",
        output: [
          {
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
            status: "completed",
          },
        ],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 15,
        },
      },
    },
  ];
}

/**
 * Build a function_call response stream event sequence.
 * @param {string} callId
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {object[]}
 */
function functionCallStreamEvents(callId, name, args) {
  const argsStr = JSON.stringify(args);
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_test" },
    },
    {
      type: "response.in_progress",
      sequence_number: 1,
      response: { id: "resp_test" },
    },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: {
        id: "fc_test",
        type: "function_call",
        call_id: callId,
        name,
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 3,
      item_id: "fc_test",
      output_index: 0,
      delta: argsStr,
      obfuscation: "",
    },
    {
      type: "response.function_call_arguments.done",
      sequence_number: 4,
      item_id: "fc_test",
      output_index: 0,
      arguments: argsStr,
    },
    {
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 0,
      item: {
        id: "fc_test",
        type: "function_call",
        call_id: callId,
        name,
        arguments: argsStr,
        status: "completed",
      },
    },
    {
      type: "response.completed",
      sequence_number: 6,
      response: {
        id: "resp_test",
        object: "response",
        output: [
          {
            id: "fc_test",
            type: "function_call",
            call_id: callId,
            name,
            arguments: argsStr,
            status: "completed",
          },
        ],
        usage: {
          input_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 25,
        },
      },
    },
  ];
}

/**
 * Build a reasoning + text response stream event sequence.
 * @param {string} thinkingSummary
 * @param {string} text
 * @returns {object[]}
 */
function reasoningTextStreamEvents(thinkingSummary, text) {
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_test" },
    },
    {
      type: "response.in_progress",
      sequence_number: 1,
      response: { id: "resp_test" },
    },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: {
        id: "rs_test",
        type: "reasoning",
        summary: [],
        encrypted_content: "enc_test",
      },
    },
    {
      type: "response.reasoning_summary_part.added",
      sequence_number: 3,
      item_id: "rs_test",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    },
    {
      type: "response.reasoning_summary_text.delta",
      sequence_number: 4,
      item_id: "rs_test",
      output_index: 0,
      summary_index: 0,
      delta: thinkingSummary,
    },
    {
      type: "response.reasoning_summary_text.done",
      sequence_number: 5,
      item_id: "rs_test",
      output_index: 0,
      summary_index: 0,
      text: thinkingSummary,
    },
    {
      type: "response.reasoning_summary_part.done",
      sequence_number: 6,
      item_id: "rs_test",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: thinkingSummary },
    },
    {
      type: "response.output_item.done",
      sequence_number: 7,
      output_index: 0,
      item: {
        id: "rs_test",
        type: "reasoning",
        summary: [{ type: "summary_text", text: thinkingSummary }],
        encrypted_content: "enc_test",
      },
    },
    {
      type: "response.output_item.added",
      sequence_number: 8,
      output_index: 1,
      item: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.content_part.added",
      sequence_number: 9,
      item_id: "msg_test",
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 10,
      item_id: "msg_test",
      output_index: 1,
      content_index: 0,
      delta: text,
      logprobs: [],
      obfuscation: "",
    },
    {
      type: "response.content_part.done",
      sequence_number: 11,
      item_id: "msg_test",
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text },
    },
    {
      type: "response.output_item.done",
      sequence_number: 12,
      output_index: 1,
      item: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
        status: "completed",
      },
    },
    {
      type: "response.completed",
      sequence_number: 13,
      response: {
        id: "resp_test",
        object: "response",
        output: [
          {
            id: "rs_test",
            type: "reasoning",
            summary: [{ type: "summary_text", text: thinkingSummary }],
            encrypted_content: "enc_test",
          },
          {
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
            status: "completed",
          },
        ],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 12 },
          total_tokens: 30,
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("callOpenAIModel", () => {
  test("should return ModelOutput for text response", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      return new Response(encodeOpenAISSE(textStreamEvents("Hello!")), {
        status: 200,
      });
    });

    const result = await callOpenAIModel(
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
    assert.strictEqual(result.providerTokenUsage.input_tokens, 10);
    assert.strictEqual(result.providerTokenUsage.output_tokens, 5);
  });

  test("should return ModelOutput for function_call response", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      return new Response(
        encodeOpenAISSE(
          functionCallStreamEvents("call-1", "readFile", {
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

    const result = await callOpenAIModel(
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
        encodeOpenAISSE(
          reasoningTextStreamEvents(
            "Thinking about it...",
            "Here's the answer.",
          ),
        ),
        { status: 200 },
      );
    });

    const result = await callOpenAIModel(
      platformConfig,
      modelConfig,
      simpleInput("Think about this"),
    );

    assert.ok(!(result instanceof Error));
    assert.strictEqual(result.message.content.length, 2);
    assert.strictEqual(result.message.content[0].type, "thinking");
    assert.strictEqual(
      result.message.content[0].thinking,
      "Thinking about it...",
    );
    assert.strictEqual(
      result.message.content[0].provider.fields.encrypted_content,
      "enc_test",
    );
    assert.strictEqual(result.message.content[1].type, "text");
    assert.strictEqual(result.message.content[1].text, "Here's the answer.");
  });

  test("should call onPartialMessageContent with correct sequence", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      return new Response(encodeOpenAISSE(textStreamEvents("Hi")), {
        status: 200,
      });
    });

    const partials = [];

    await callOpenAIModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello", {
        onPartialMessageContent: (p) => partials.push({ ...p }),
      }),
    );

    assert.ok(partials.length >= 3);
    const starts = partials.filter((p) => p.position === "start");
    assert.ok(starts.length >= 1);
    assert.strictEqual(starts[0].type, "text");
    const deltas = partials.filter((p) => p.position === "delta");
    assert.ok(deltas.length >= 1);
    assert.strictEqual(deltas[0].content, "Hi");
    const stops = partials.filter((p) => p.position === "stop");
    assert.ok(stops.length >= 1);
  });

  test("should verify request body structure", async (t) => {
    let capturedBody;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return new Response(encodeOpenAISSE(textStreamEvents("OK")), {
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

    await callOpenAIModel(
      platformConfig,
      modelConfig,
      simpleInput("Hello", { tools }),
    );

    assert.ok(capturedBody);
    assert.strictEqual(capturedBody.stream, true);
    assert.strictEqual(capturedBody.model, "o4-mini");
    // input should contain system + user messages
    assert.ok(Array.isArray(capturedBody.input));
    const systemItem = capturedBody.input.find((i) => i.role === "system");
    assert.ok(systemItem);
    assert.strictEqual(systemItem.content[0].text, "You are a test assistant.");
    // tools converted to OpenAI format
    assert.ok(capturedBody.tools);
    assert.strictEqual(capturedBody.tools[0].type, "function");
    assert.strictEqual(capturedBody.tools[0].name, "echo");
    assert.ok(capturedBody.tools[0].parameters);
  });

  test("should send correct URL and headers", async (t) => {
    let capturedUrl;
    let capturedHeaders;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      return new Response(encodeOpenAISSE(textStreamEvents("OK")), {
        status: 200,
      });
    });

    await callOpenAIModel(platformConfig, modelConfig, simpleInput("Hello"));

    assert.strictEqual(capturedUrl, "https://api.openai.com/v1/responses");
    assert.strictEqual(capturedHeaders.Authorization, "Bearer test-key");
    assert.strictEqual(capturedHeaders["Content-Type"], "application/json");
  });

  test("should return Error on HTTP 4xx", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      return new Response("Bad request", { status: 400 });
    });

    const result = await callOpenAIModel(
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

    const result = await callOpenAIModel(
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
      return new Response(encodeOpenAISSE(textStreamEvents("Retried!")), {
        status: 200,
      });
    });

    const resultPromise = callOpenAIModel(
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
      return new Response(encodeOpenAISSE(textStreamEvents("Recovered!")), {
        status: 200,
      });
    });

    const resultPromise = callOpenAIModel(
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

  test("should retry when stream does not complete", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let callCount = 0;
    t.mock.method(globalThis, "fetch", async () => {
      callCount++;
      if (callCount === 1) {
        // stream that ends without response.completed
        const incompleteEvents = [
          {
            type: "response.created",
            sequence_number: 0,
            response: { id: "resp_test" },
          },
          {
            type: "response.failed",
            sequence_number: 1,
            response: { error: { message: "internal error" } },
          },
        ];
        return new Response(encodeOpenAISSE(incompleteEvents), { status: 200 });
      }
      return new Response(encodeOpenAISSE(textStreamEvents("Recovered!")), {
        status: 200,
      });
    });

    const resultPromise = callOpenAIModel(
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
      return new Response(encodeOpenAISSE(textStreamEvents("OK")), {
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

    await callOpenAIModel(platformConfig, modelConfig, input);

    // assistant message converted to function_call item
    const functionCallItem = capturedBody.input.find(
      (i) => i.type === "function_call",
    );
    assert.ok(functionCallItem);
    assert.strictEqual(functionCallItem.name, "echo");
    assert.strictEqual(functionCallItem.call_id, "call-1");
    assert.strictEqual(
      functionCallItem.arguments,
      JSON.stringify({ text: "hello" }),
    );

    // tool result converted to function_call_output
    const toolOutputItem = capturedBody.input.find(
      (i) => i.type === "function_call_output",
    );
    assert.ok(toolOutputItem);
    assert.strictEqual(toolOutputItem.call_id, "call-1");
    assert.strictEqual(toolOutputItem.output, "hello");
  });
});
