import assert from "node:assert";
import { describe, it } from "node:test";
import { createWebSearchTool } from "./webSearch.mjs";

describe("createWebSearchTool input validation", () => {
  it("rejects input that is missing searches", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({ question: "What is this?" });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /`searches` is required/);
  });

  it("rejects an empty searches array", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({ searches: [], question: "q" });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /`searches` is required/);
  });

  it("rejects a search entry that is not an object", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({
      searches: [["foo"]],
      question: "q",
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /must be an object/);
  });

  it("rejects a search whose keywords array is empty", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({
      searches: [{ keywords: [] }],
      question: "q",
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /non-empty array of non-empty strings/);
  });

  it("rejects a search keyword that is not a non-empty string", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({
      searches: [{ keywords: ["ok", ""] }],
      question: "q",
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /non-empty array of non-empty strings/);
  });

  it("rejects input that is missing a question", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({ searches: [{ keywords: ["foo"] }] });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /`question` is required/);
  });
});

describe("createWebSearchTool description", () => {
  it("describes itself as answering the question", () => {
    // given / when:
    const tool = createWebSearchTool({
      provider: "bedrock-agentcore",
      region: "us-east-1",
      awsProfile: "test",
      modelCaller: async () => ({
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      }),
    });

    // then:
    assert.equal(
      tool.def.description,
      "Run one or more web searches and answer a question based on the combined results.",
    );
  });
});

/**
 * @returns {import("./webSearch/command.mjs").WebSearchToolCommandOptions}
 */
function newCommandConfig() {
  return {
    provider: "command",
    command: "true",
    args: [],
    modelCaller: async () => ({
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
    }),
  };
}
