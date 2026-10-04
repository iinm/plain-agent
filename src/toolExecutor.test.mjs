import assert from "node:assert";
import { describe, it } from "node:test";
import { createToolExecutor } from "./toolExecutor.mjs";

/**
 * @param {{ name: string } & Partial<import("./tool").Tool>} params
 * @returns {import("./tool").Tool}
 */
const createTool = ({ name, ...rest }) => ({
  def: { name, description: "", inputSchema: {} },
  impl: async () => "",
  ...rest,
});

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} [input]
 * @returns {import("./model").MessageContentToolUse}
 */
const createToolUse = (toolName, input = {}) => ({
  type: "tool_use",
  toolUseId: `${toolName}-id`,
  toolName,
  input,
});

/**
 * @param {import("./tool").Tool[]} tools
 * @returns {import("./toolExecutor.mjs").ToolExecutor}
 */
const createExecutor = (tools) =>
  createToolExecutor(new Map(tools.map((tool) => [tool.def.name, tool])));

/**
 * @param {string} secret
 * @returns {(text: string) => string}
 */
const mask = (secret) => (text) => text.replaceAll(secret, "***");

/**
 * @param {import("./model").MessageContentToolResult} toolResult
 * @param {number} partIndex
 * @returns {string}
 */
const textAt = (toolResult, partIndex) => {
  const part = toolResult.content[partIndex];
  assert.strictEqual(part.type, "text");
  if (part.type !== "text") {
    throw new Error(`Expected a text part at index ${partIndex}`);
  }
  return part.text;
};

describe("createToolExecutor#executeBatch maskSecrets", () => {
  it("masks a string result using a tool's maskSecrets", async () => {
    // given: toolByName is a Map, so it must be enumerated as a Map
    const tool = createTool({
      name: "echo",
      impl: async () => "token=abc123",
      maskSecrets: mask("abc123"),
    });

    // when:
    const result = await createExecutor([tool]).executeBatch([
      createToolUse("echo"),
    ]);

    // then:
    assert.ok(result.success);
    assert.strictEqual(textAt(result.results[0], 0), "token=***");
  });

  it("masks only text parts of structured content", async () => {
    // given:
    const image = { type: "image", data: "aGk=", mimeType: "image/png" };
    const tool = createTool({
      name: "mixed",
      impl: async () =>
        /** @type {import("./tool").StructuredToolResultContent[]} */ ([
          { type: "text", text: "before abc" },
          image,
          { type: "text", text: "after abc" },
        ]),
      maskSecrets: mask("abc"),
    });

    // when:
    const result = await createExecutor([tool]).executeBatch([
      createToolUse("mixed"),
    ]);

    // then:
    assert.ok(result.success);
    assert.deepStrictEqual(result.results[0].content, [
      { type: "text", text: "before ***" },
      image,
      { type: "text", text: "after ***" },
    ]);
    assert.strictEqual(result.results[0].content[1], image);
  });

  it("applies every tool's maskSecrets in sequence", async () => {
    // given:
    const tools = [
      createTool({ name: "a", maskSecrets: mask("aaa") }),
      createTool({
        name: "b",
        impl: async () => "aaa bbb",
        maskSecrets: mask("bbb"),
      }),
    ];

    // when:
    const result = await createExecutor(tools).executeBatch([
      createToolUse("b"),
    ]);

    // then:
    assert.ok(result.success);
    assert.strictEqual(textAt(result.results[0], 0), "*** ***");
  });

  it("leaves text unchanged when no tool defines maskSecrets", async () => {
    // given:
    const tool = createTool({ name: "plain", impl: async () => "abc123" });

    // when:
    const result = await createExecutor([tool]).executeBatch([
      createToolUse("plain"),
    ]);

    // then:
    assert.ok(result.success);
    assert.strictEqual(textAt(result.results[0], 0), "abc123");
  });

  it("masks an Error message returned by impl", async () => {
    // given:
    const tool = createTool({
      name: "fail",
      impl: async () => new Error("failed with abc"),
      maskSecrets: mask("abc"),
    });

    // when:
    const result = await createExecutor([tool]).executeBatch([
      createToolUse("fail"),
    ]);

    // then:
    assert.ok(result.success);
    assert.strictEqual(result.results[0].isError, true);
    assert.strictEqual(textAt(result.results[0], 0), "failed with ***");
  });

  it("masks validation error messages in errorMessage and tool results", async () => {
    // given:
    const tool = createTool({
      name: "validated",
      validateInput: () => new Error("invalid abc"),
      maskSecrets: mask("abc"),
    });

    // when:
    const result = await createExecutor([tool]).executeBatch([
      createToolUse("validated"),
    ]);

    // then:
    assert.ok(!result.success);
    assert.strictEqual(result.errorMessage, "invalid ***");
    assert.strictEqual(textAt(result.errors[0], 0), "invalid ***");
  });

  it("keeps the placeholder for a tool use rejected by another tool's error", async () => {
    // given:
    const tools = [
      createTool({ name: "ok", impl: async () => "ok" }),
      createTool({ name: "bad", validateInput: () => new Error("boom") }),
    ];

    // when:
    const result = await createExecutor(tools).executeBatch([
      createToolUse("ok"),
      createToolUse("bad"),
    ]);

    // then:
    assert.ok(!result.success);
    assert.strictEqual(
      textAt(result.errors[0], 0),
      "Tool call rejected due to other tool validation error",
    );
  });
});
