import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { createWebSearchTool } from "../webSearch.mjs";

/** @returns {import("./gemini.mjs").WebSearchToolGeminiOptions} */
function newGeminiConfig() {
  return {
    provider: "gemini",
    apiKey: "test-key",
    model: "gemini-test",
  };
}

/**
 * Stub `fetch` with a Gemini-style response.
 *
 * @param {object} candidate
 * @returns {{ restore: () => void }}
 */
function stubGeminiResponse(candidate) {
  const fetchMock = mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [candidate] }),
  }));
  return { restore: () => fetchMock.mock.restore() };
}

describe("webSearchViaGemini cited sources", () => {
  it("keys every source under search 1 and lists only the cited chunk", async () => {
    // given:
    const fetchStub = stubGeminiResponse({
      content: { parts: [{ text: "Tokyo is sunny." }] },
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: "https://example.com/a", title: "A" } },
          { web: { uri: "https://example.com/b", title: "B" } },
        ],
        groundingSupports: [
          {
            segment: { startIndex: 0, endIndex: 15, text: "Tokyo is sunny." },
            groundingChunkIndices: [1],
          },
        ],
      },
    });
    const tool = createWebSearchTool(newGeminiConfig());

    try {
      // when:
      const result = await tool.impl({
        searches: [{ keywords: ["tokyo", "weather"] }, { keywords: ["osaka"] }],
        question: "q",
      });

      // then:
      assert.equal(
        result,
        [
          "Tokyo is sunny. [1.2]",
          "",
          "Sources:",
          "- [1.2] B - https://example.com/b",
          "",
          "- [search 1] tokyo weather",
          "- [search 2] osaka",
        ].join("\n"),
      );
    } finally {
      fetchStub.restore();
    }
  });

  it("omits the source list when no grounding support cites a chunk", async () => {
    // given:
    const fetchStub = stubGeminiResponse({
      content: { parts: [{ text: "Tokyo is sunny." }] },
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: "https://example.com/a", title: "A" } },
        ],
      },
    });
    const tool = createWebSearchTool(newGeminiConfig());

    try {
      // when:
      const result = await tool.impl({
        searches: [{ keywords: ["tokyo", "weather"] }],
        question: "q",
      });

      // then:
      assert.equal(result, "Tokyo is sunny.\n\n- [search 1] tokyo weather");
    } finally {
      fetchStub.restore();
    }
  });
});
