import assert from "node:assert";
import { describe, it } from "node:test";
import { createToolExecutor } from "./toolExecutor.mjs";

/**
 * @param {string} name
 * @param {import("./tool").ToolImplementation} impl
 * @param {((text: string) => string)=} maskOutput
 * @param {((input: Record<string, unknown>) => Error | undefined)=} validateInput
 * @returns {import("./tool").Tool}
 */
function createTool(name, impl, maskOutput, validateInput) {
  return {
    def: { name, description: name, inputSchema: {} },
    impl,
    maskOutput,
    validateInput,
  };
}

/**
 * @param {string} toolName
 * @returns {import("./model").MessageContentToolUse}
 */
function toolUse(toolName) {
  return { type: "tool_use", toolUseId: `${toolName}-1`, toolName, input: {} };
}

/** @param {string} text */
function maskS3cr3t(text) {
  return text.replaceAll("s3cr3t", "***");
}

describe("toolExecutor secret masking", () => {
  it("masks a tool result using another tool's masker", async () => {
    // given:
    const executor = createToolExecutor(
      new Map([
        [
          "exec_command",
          createTool("exec_command", async () => "ok", maskS3cr3t),
        ],
        ["read_file", createTool("read_file", async () => "value=s3cr3t")],
      ]),
    );

    // when:
    const result = await executor.executeBatch([toolUse("read_file")]);

    // then:
    if (!result.success) assert.fail(result.errorMessage);
    const part = result.results[0].content[0];
    assert.equal(part.type, "text");
    if (part.type !== "text") return;
    assert.equal(part.text, "value=***");
  });

  it("masks structured text content but leaves images untouched", async () => {
    // given:
    const executor = createToolExecutor(
      new Map([
        [
          "exec_command",
          createTool("exec_command", async () => "ok", maskS3cr3t),
        ],
        [
          "mcp__server__tool",
          createTool(
            "mcp__server__tool",
            async () =>
              /** @type {import("./tool").StructuredToolResultContent[]} */ ([
                { type: "text", text: "s3cr3t" },
                { type: "image", data: "s3cr3t", mimeType: "image/png" },
              ]),
          ),
        ],
      ]),
    );

    // when:
    const result = await executor.executeBatch([toolUse("mcp__server__tool")]);

    // then:
    if (!result.success) assert.fail(result.errorMessage);
    const [textPart, imagePart] = result.results[0].content;
    assert.equal(textPart.type, "text");
    if (textPart.type !== "text") return;
    assert.equal(textPart.text, "***");
    assert.equal(imagePart.type, "image");
    if (imagePart.type !== "image") return;
    assert.equal(imagePart.data, "s3cr3t");
  });

  it("masks error messages", async () => {
    // given:
    const executor = createToolExecutor(
      new Map([
        [
          "exec_command",
          createTool("exec_command", async () => "ok", maskS3cr3t),
        ],
        [
          "read_file",
          createTool("read_file", async () => new Error("failed: s3cr3t")),
        ],
      ]),
    );

    // when:
    const result = await executor.executeBatch([toolUse("read_file")]);

    // then:
    if (!result.success) assert.fail(result.errorMessage);
    const part = result.results[0].content[0];
    assert.equal(part.type, "text");
    if (part.type !== "text") return;
    assert.equal(part.text, "failed: ***");
  });

  it("leaves output unchanged when no tool defines a masker", async () => {
    // given:
    const executor = createToolExecutor(
      new Map([
        ["read_file", createTool("read_file", async () => "value=s3cr3t")],
      ]),
    );

    // when:
    const result = await executor.executeBatch([toolUse("read_file")]);

    // then:
    if (!result.success) assert.fail(result.errorMessage);
    const part = result.results[0].content[0];
    assert.equal(part.type, "text");
    if (part.type !== "text") return;
    assert.equal(part.text, "value=s3cr3t");
  });

  it("masks validation errors from validateBatch", () => {
    // given:
    const executor = createToolExecutor(
      new Map([
        [
          "exec_command",
          createTool("exec_command", async () => "ok", maskS3cr3t),
        ],
        [
          "read_file",
          createTool(
            "read_file",
            async () => "unused",
            undefined,
            () => new Error("invalid input: s3cr3t"),
          ),
        ],
      ]),
    );

    // when:
    const validation = executor.validateBatch([toolUse("read_file")]);

    // then:
    if (validation.isValid) assert.fail("expected validation to fail");
    assert.equal(validation.errorMessage, "invalid input: ***");
    const part = validation.toolResults[0].content[0];
    assert.equal(part.type, "text");
    if (part.type !== "text") return;
    assert.equal(part.text, "invalid input: ***");
  });

  it("masks validation errors returned by executeBatch", async () => {
    // given:
    const executor = createToolExecutor(
      new Map([
        [
          "exec_command",
          createTool("exec_command", async () => "ok", maskS3cr3t),
        ],
      ]),
    );

    // when:
    const result = await executor.executeBatch([toolUse("s3cr3t_tool")]);

    // then:
    if (result.success) assert.fail("expected execution to fail");
    assert.equal(result.errorMessage, "Tool not found: ***_tool");
    const part = result.errors[0].content[0];
    assert.equal(part.type, "text");
    if (part.type !== "text") return;
    assert.equal(part.text, "Tool not found: ***_tool");
  });
});
