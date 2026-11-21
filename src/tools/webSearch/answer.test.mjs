import assert from "node:assert";
import { describe, it } from "node:test";
import { createWebSearchTool } from "../webSearch.mjs";
import { extractCitedKeys, extractUrls, truncateText } from "./answer.mjs";

describe("runSearches summarization", () => {
  it("answers the question with the model and appends a summary list", async () => {
    // given:
    /** @type {import("../../model").ModelInput[]} */
    const modelInputs = [];
    /** @type {import("./command.mjs").WebSearchToolCommandOptions} */
    const config = {
      ...newCommandConfig(),
      modelCaller: async (input) => {
        modelInputs.push(input);
        return {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Tokyo will be sunny." }],
          },
        };
      },
    };
    const tool = createWebSearchTool(config);

    // when:
    const result = await tool.impl({
      searches: [{ keywords: ["tokyo", "weather"] }],
      question: "What is the weather in Tokyo?",
    });

    // then:
    assert.equal(result, "Tokyo will be sunny.\n\n- [search 1] tokyo weather");
    assert.equal(modelInputs.length, 1);
    const userMessage = modelInputs[0].messages[1];
    assert.ok(userMessage.role === "user");
    const userText = userMessage.content[0];
    assert.ok(userText.type === "text");
    assert.match(userText.text, /What is the weather in Tokyo\?/);
    assert.match(userText.text, /<search keywords="tokyo weather">/);
  });
});

describe("runSearches cited sources", () => {
  /**
   * @param {string[]} urls
   * @param {string} answer
   * @returns {import("./command.mjs").WebSearchToolCommandOptions}
   */
  function newConfigWithSources(urls, answer) {
    return {
      ...newCommandConfig(),
      command: "echo",
      args: [urls.join(" ")],
      modelCaller: async () => ({
        message: {
          role: "assistant",
          content: [{ type: "text", text: answer }],
        },
      }),
    };
  }

  /**
   * @param {import("./command.mjs").WebSearchToolCommandOptions} config
   * @param {import("./types.mjs").WebSearchInput} input
   * @returns {Promise<string>}
   */
  async function runSearch(config, input) {
    const result = await createWebSearchTool(config).impl(input);
    assert.ok(typeof result === "string", "expected a text result");
    return result;
  }

  it("lists only the URLs the answer cites", async () => {
    // given:
    const config = newConfigWithSources(
      ["https://example.com/a", "https://example.com/b"],
      "Sunny. [[1.2]]",
    );

    // when:
    const result = await runSearch(config, {
      searches: [{ keywords: ["weather"] }],
      question: "q",
    });

    // then:
    assert.match(
      result,
      /Sunny\. \[1\.2\]\n\nSources:\n- \[1\.2\] https:\/\/example\.com\/b/,
    );
    assert.doesNotMatch(result, /example\.com\/a/);
  });

  it("omits the source list when the answer cites nothing", async () => {
    // given:
    const config = newConfigWithSources(["https://example.com/a"], "Sunny.");

    // when:
    const result = await runSearch(config, {
      searches: [{ keywords: ["weather"] }],
      question: "q",
    });

    // then:
    assert.equal(result, "Sunny.\n\n- [search 1] weather");
  });

  it("drops citations outside the source list", async () => {
    // given:
    const config = newConfigWithSources(
      ["https://example.com/a"],
      "Sunny. [[9.9]]",
    );

    // when:
    const result = await runSearch(config, {
      searches: [{ keywords: ["weather"] }],
      question: "q",
    });

    // then:
    assert.doesNotMatch(result, /Sources:/);
  });

  it("omits sources whose search was cut from the prompt", async () => {
    // given:
    const config = {
      ...newConfigWithSources([], "Sunny. [[2.1]]"),
      maxTotalLength: 80,
      delayBetweenRequestsMs: 0,
    };

    // when:
    const result = await runSearch(config, {
      searches: [
        { keywords: ["https://example.com/a"] },
        { keywords: ["https://example.com/b"] },
      ],
      question: "q",
    });

    // then:
    assert.doesNotMatch(result, /Sources:/);
    assert.match(result, /- \[search 2\] https:\/\/example\.com\/b/);
  });

  it("keys a repeated URL per search and lists the cited one", async () => {
    // given:
    const config = newConfigWithSources(
      ["https://example.com/a"],
      "Sunny. [[2.1]]",
    );

    // when:
    const result = await runSearch(config, {
      searches: [{ keywords: ["a"] }, { keywords: ["b"] }],
      question: "q",
    });

    // then:
    assert.match(result, /Sources:\n- \[2\.1\] https:\/\/example\.com\/a$/m);
    assert.doesNotMatch(result, /- \[1\.1\]/);
  });

  it("does not treat a bare [1] in the answer as a citation", async () => {
    // given:
    const config = newConfigWithSources(
      ["https://example.com/a"],
      "Calling items[1] returns the second element.",
    );

    // when:
    const result = await runSearch(config, {
      searches: [{ keywords: ["weather"] }],
      question: "q",
    });

    // then:
    assert.doesNotMatch(result, /Sources:/);
    assert.match(result, /items\[1\]/);
  });
});

describe("extractUrls", () => {
  it("deduplicates URLs and trims trailing punctuation", () => {
    // given:
    const text =
      "See https://example.com/a, https://example.com/b. Again https://example.com/a.";

    // when:
    const urls = extractUrls(text);

    // then:
    assert.deepEqual(urls, ["https://example.com/a", "https://example.com/b"]);
  });

  it("stops at the closing parenthesis of a markdown link", () => {
    // given:
    const text = "- [title](https://example.com/a)";

    // when:
    const urls = extractUrls(text);

    // then:
    assert.deepEqual(urls, ["https://example.com/a"]);
  });
});

describe("extractCitedKeys", () => {
  it("ignores single-bracketed numbers in prose and code", () => {
    // given:
    const text =
      "items[1] and [2] are not citations; [[1.1]] and [[2.3, 2.4]] are.";

    // when:
    const keys = extractCitedKeys(text);

    // then:
    assert.deepEqual([...keys], ["1.1", "2.3", "2.4"]);
  });
});

describe("truncateText", () => {
  it("returns the original content when it is within the length budget", () => {
    // given:
    const content = "hello";

    // when:
    const result = truncateText(content, 10);

    // then:
    assert.equal(result.text, "hello");
    assert.equal(result.truncated, false);
    assert.equal(result.originalLength, 5);
  });

  it("truncates content and appends a marker", () => {
    // given:
    const content = "abcdefghij";

    // when:
    const result = truncateText(content, 4);

    // then:
    assert.equal(result.truncated, true);
    assert.equal(result.originalLength, 10);
    assert.ok(result.text.startsWith("abcd"));
    assert.ok(result.text.includes("[truncated: 6 of 10 chars omitted]"));
  });
});

/**
 * @returns {import("./command.mjs").WebSearchToolCommandOptions}
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
