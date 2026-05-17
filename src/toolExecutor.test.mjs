import assert from "node:assert";
import test, { describe } from "node:test";
import { createToolExecutor } from "./toolExecutor.mjs";

/**
 * @param {string} name
 * @param {object} [overrides]
 * @returns {import("./tool").Tool}
 */
function createMockTool(name, overrides = {}) {
  return {
    def: { name, description: `Mock ${name}`, inputSchema: {} },
    impl: async () => `${name} result`,
    ...overrides,
  };
}

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} [input]
 * @returns {import("./model").MessageContentToolUse}
 */
function toolUse(toolName, input = {}) {
  return {
    type: "tool_use",
    toolUseId: `id-${toolName}`,
    toolName,
    input,
  };
}

describe("createToolExecutor", () => {
  describe("validateBatch", () => {
    test("should return isValid:true for existing tool", () => {
      // given:
      const toolByName = new Map([["echo", createMockTool("echo")]]);
      const { validateBatch } = createToolExecutor(toolByName);

      // when:
      const result = validateBatch([toolUse("echo")]);

      // then:
      assert.deepStrictEqual(result, { isValid: true });
    });

    test("should return isValid:false for non-existing tool", () => {
      // given:
      const toolByName = new Map([["echo", createMockTool("echo")]]);
      const { validateBatch } = createToolExecutor(toolByName);

      // when:
      const result = validateBatch([toolUse("nonexistent")]);

      // then:
      assert.strictEqual(result.isValid, false);
      assert.match(result.errorMessage, /Tool not found: nonexistent/);
      assert.strictEqual(result.toolResults.length, 1);
      assert.strictEqual(result.toolResults[0].isError, true);
    });

    test("should return isValid:false when validateInput returns Error", () => {
      // given:
      const toolByName = new Map([
        [
          "strict",
          createMockTool("strict", {
            validateInput: (input) =>
              input.required ? undefined : new Error("missing required field"),
          }),
        ],
      ]);
      const { validateBatch } = createToolExecutor(toolByName);

      // when:
      const result = validateBatch([toolUse("strict", {})]);

      // then:
      assert.strictEqual(result.isValid, false);
      assert.match(result.errorMessage, /missing required field/);
    });

    test("should return isValid:true for exclusive tool called alone", () => {
      // given:
      const toolByName = new Map([
        ["switch", createMockTool("switch")],
        ["echo", createMockTool("echo")],
      ]);
      const { validateBatch } = createToolExecutor(toolByName, {
        exclusiveToolNames: ["switch"],
      });

      // when:
      const result = validateBatch([toolUse("switch")]);

      // then:
      assert.deepStrictEqual(result, { isValid: true });
    });

    test("should return isValid:false for exclusive tool called with other tools", () => {
      // given:
      const toolByName = new Map([
        ["switch", createMockTool("switch")],
        ["echo", createMockTool("echo")],
      ]);
      const { validateBatch } = createToolExecutor(toolByName, {
        exclusiveToolNames: ["switch"],
      });

      // when:
      const result = validateBatch([toolUse("switch"), toolUse("echo")]);

      // then:
      assert.strictEqual(result.isValid, false);
      assert.match(result.errorMessage, /cannot be called with other tools/);
      assert.strictEqual(result.toolResults.length, 2);
    });

    test("should return isValid:false for two exclusive tools called together", () => {
      // given:
      const toolByName = new Map([
        ["switchA", createMockTool("switchA")],
        ["switchB", createMockTool("switchB")],
      ]);
      const { validateBatch } = createToolExecutor(toolByName, {
        exclusiveToolNames: ["switchA", "switchB"],
      });

      // when:
      const result = validateBatch([toolUse("switchA"), toolUse("switchB")]);

      // then:
      assert.strictEqual(result.isValid, false);
      assert.match(result.errorMessage, /cannot be called together/);
    });

    test("should include error toolResults for all tools when any validation fails", () => {
      // given:
      const toolByName = new Map([
        ["good", createMockTool("good")],
        // "bad" tool does not exist
      ]);
      const { validateBatch } = createToolExecutor(toolByName);

      // when:
      const result = validateBatch([toolUse("good"), toolUse("bad")]);

      // then:
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.toolResults.length, 2);
      // "good" tool gets a rejection message too
      assert.strictEqual(result.toolResults[0].isError, true);
      assert.match(
        result.toolResults[0].content[0].text,
        /rejected due to other tool/,
      );
      // "bad" tool gets the not-found error
      assert.strictEqual(result.toolResults[1].isError, true);
      assert.match(result.toolResults[1].content[0].text, /Tool not found/);
    });
  });

  describe("executeBatch", () => {
    test("should return success:true with string result", async () => {
      // given:
      const toolByName = new Map([["echo", createMockTool("echo")]]);
      const { executeBatch } = createToolExecutor(toolByName);

      // when:
      const result = await executeBatch([toolUse("echo", { text: "hi" })]);

      // then:
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0].type, "tool_result");
      assert.strictEqual(result.results[0].toolName, "echo");
      assert.strictEqual(result.results[0].content[0].text, "echo result");
      assert.strictEqual(result.results[0].isError, undefined);
    });

    test("should return success:true with structured content result", async () => {
      // given:
      const structuredResult = [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ];
      const toolByName = new Map([
        [
          "multi",
          createMockTool("multi", {
            impl: async () => structuredResult,
          }),
        ],
      ]);
      const { executeBatch } = createToolExecutor(toolByName);

      // when:
      const result = await executeBatch([toolUse("multi")]);

      // then:
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.results[0].content, structuredResult);
    });

    test("should return success:false when validation fails", async () => {
      // given:
      const toolByName = new Map([["echo", createMockTool("echo")]]);
      const { executeBatch } = createToolExecutor(toolByName);

      // when:
      const result = await executeBatch([toolUse("nonexistent")]);

      // then:
      assert.strictEqual(result.success, false);
      assert.ok(result.errors);
      assert.ok(result.errorMessage);
    });

    test("should return isError:true when tool impl returns Error", async () => {
      // given:
      const toolByName = new Map([
        [
          "fail",
          createMockTool("fail", {
            impl: async () => new Error("something broke"),
          }),
        ],
      ]);
      const { executeBatch } = createToolExecutor(toolByName);

      // when:
      const result = await executeBatch([toolUse("fail")]);

      // then:
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.results[0].isError, true);
      assert.match(result.results[0].content[0].text, /something broke/);
    });

    test("should execute multiple tools sequentially", async () => {
      // given:
      const order = [];
      const toolByName = new Map([
        [
          "first",
          createMockTool("first", {
            impl: async () => {
              order.push("first");
              return "first done";
            },
          }),
        ],
        [
          "second",
          createMockTool("second", {
            impl: async () => {
              order.push("second");
              return "second done";
            },
          }),
        ],
      ]);
      const { executeBatch } = createToolExecutor(toolByName);

      // when:
      const result = await executeBatch([toolUse("first"), toolUse("second")]);

      // then:
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.results.length, 2);
      assert.deepStrictEqual(order, ["first", "second"]);
      assert.strictEqual(result.results[0].content[0].text, "first done");
      assert.strictEqual(result.results[1].content[0].text, "second done");
    });
  });
});
