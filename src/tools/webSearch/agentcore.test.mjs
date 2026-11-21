import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { createWebSearchTool } from "../webSearch.mjs";
import {
  buildAgentCoreSearchQuery,
  formatAgentCoreSearchResults,
  resolveAgentCoreEndpoint,
} from "./agentcore.mjs";

describe("resolveAgentCoreEndpoint", () => {
  it("builds the default endpoint from the region", () => {
    // given:
    const config = { region: "ap-northeast-1" };

    // when:
    const endpoint = resolveAgentCoreEndpoint(config);

    // then:
    assert.deepEqual(endpoint, {
      baseURL: "https://bedrock-agentcore.ap-northeast-1.amazonaws.com",
      region: "ap-northeast-1",
    });
  });

  it("derives the region from baseURL", () => {
    // given:
    const config = {
      baseURL: "https://bedrock-agentcore.us-west-2.amazonaws.com",
    };

    // when:
    const endpoint = resolveAgentCoreEndpoint(config);

    // then:
    assert.deepEqual(endpoint, {
      baseURL: "https://bedrock-agentcore.us-west-2.amazonaws.com",
      region: "us-west-2",
    });
  });

  it("removes trailing slashes from baseURL", () => {
    // given:
    const config = {
      baseURL: "https://bedrock-agentcore.eu-west-1.amazonaws.com/",
    };

    // when:
    const endpoint = resolveAgentCoreEndpoint(config);

    // then:
    assert.equal(
      endpoint.baseURL,
      "https://bedrock-agentcore.eu-west-1.amazonaws.com",
    );
  });

  it("rejects a config without a region or a region-bearing baseURL", () => {
    // given:
    const config = { baseURL: "https://example.com" };

    // when / then:
    assert.throws(
      () => resolveAgentCoreEndpoint(config),
      /requires `region` or a `baseURL`/,
    );
  });
});

describe("buildAgentCoreSearchQuery", () => {
  it("joins keywords with spaces", () => {
    // given:
    const keywords = ["東京", "天気"];

    // when:
    const query = buildAgentCoreSearchQuery(keywords);

    // then:
    assert.equal(query, "東京 天気");
  });

  it("truncates a query to the 200 character API limit", () => {
    // given:
    const keywords = ["a".repeat(150), "b".repeat(150)];
    const errorMock = mock.method(console, "error", () => {});

    // when:
    const query = buildAgentCoreSearchQuery(keywords);

    // then:
    assert.equal(query.length, 200);
    assert.equal(query, `${"a".repeat(150)} ${"b".repeat(49)}`);
    assert.equal(errorMock.mock.callCount(), 1);
    errorMock.mock.restore();
  });
});

describe("formatAgentCoreSearchResults", () => {
  it("numbers results and includes title, URL, and date", () => {
    // given:
    const results = [
      {
        title: "Release highlights",
        url: "https://docs.example.net/releases",
        publishedAt: "2026-01-15T17:00:00Z",
        text: "First extract.",
      },
      { title: "Second", text: "Second extract." },
    ];

    // when:
    const { text, sources } = formatAgentCoreSearchResults(results, 1);

    assert.equal(
      text,
      [
        "[1.1] Release highlights - https://docs.example.net/releases - 2026-01-15T17:00:00Z",
        "First extract.",
        "",
        "[1.2] Second",
        "Second extract.",
      ].join("\n"),
    );
    assert.deepEqual(sources, [
      {
        key: "1.1",
        url: "https://docs.example.net/releases",
        title: "Release highlights",
      },
    ]);
  });

  it("keys sources by position when a result has no URL", () => {
    // given:
    const results = [
      { url: "https://example.com/a", text: "A" },
      { text: "No URL." },
      { url: "https://example.com/c", text: "C" },
    ];

    // when:
    const { text, sources } = formatAgentCoreSearchResults(results, 2);

    // then:
    assert.match(text, /\[2\.2\]\nNo URL\./);
    assert.deepEqual(
      sources.map((source) => source.key),
      ["2.1", "2.3"],
    );
  });

  it("omits missing metadata", () => {
    // given:
    const results = [{ text: "Only text." }];

    // when:
    const { text } = formatAgentCoreSearchResults(results, 2);

    // then:
    assert.equal(text, "[2.1]\nOnly text.");
  });

  it("reports an empty result set", () => {
    // given:
    /** @type {import("./agentcore.mjs").AgentCoreWebSearchResult[]} */
    const results = [];

    // when:
    const { text, sources } = formatAgentCoreSearchResults(results, 1);

    // then:
    assert.equal(text, "(no results)");
    assert.deepEqual(sources, []);
  });
});

describe("createWebSearchTool bedrock-agentcore", () => {
  it("returns an error when neither region nor baseURL is configured", async () => {
    // given:
    const tool = createWebSearchTool({
      provider: "bedrock-agentcore",
      awsProfile: "test",
      delayBetweenRequestsMs: 0,
      modelCaller: async () => ({
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      }),
    });

    // when:
    const result = await tool.impl({
      searches: [{ keywords: ["query"] }],
      question: "q",
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /requires `region` or a `baseURL`/);
  });
});
