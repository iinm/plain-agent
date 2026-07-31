import assert from "node:assert";
import test, { describe } from "node:test";
import { resolveBedrockSigningTarget } from "./bedrock.mjs";

describe("resolveBedrockSigningTarget", () => {
  test("resolves region and service for the bedrock-runtime endpoint", () => {
    // given: a bedrock-runtime URL
    const url =
      "https://bedrock-runtime.ap-northeast-1.amazonaws.com/model/openai.gpt-oss-120b/invoke-with-response-stream";

    // when: resolving the signing target
    const target = resolveBedrockSigningTarget(url);

    // then: the bedrock service is used
    assert.deepEqual(target, { region: "ap-northeast-1", service: "bedrock" });
  });

  test("resolves region and service for the bedrock-mantle endpoint", () => {
    // given: a bedrock-mantle URL
    const url = "https://bedrock-mantle.us-east-1.api.aws/v1/responses";

    // when: resolving the signing target
    const target = resolveBedrockSigningTarget(url);

    // then: the bedrock-mantle service is used
    assert.deepEqual(target, {
      region: "us-east-1",
      service: "bedrock-mantle",
    });
  });

  test("falls back to an empty region for unknown hosts", () => {
    // given: a URL that matches no known Bedrock endpoint
    const url = "https://example.com/v1/chat/completions";

    // when: resolving the signing target
    const target = resolveBedrockSigningTarget(url);

    // then: the region is empty and the bedrock service is used
    assert.deepEqual(target, { region: "", service: "bedrock" });
  });
});
