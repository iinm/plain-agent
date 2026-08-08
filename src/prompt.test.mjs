import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPrompt } from "./prompt.mjs";

/**
 * @param {Partial<import("./prompt.mjs").PromptConfig>} [overrides]
 * @returns {import("./prompt.mjs").PromptConfig}
 */
function baseConfig(overrides = {}) {
  return {
    username: "taro",
    modelName: "claude-sonnet-4-6",
    sessionId: "2026-08-08-0000-abc",
    today: "2026-08-08",
    workingDir: "/work",
    projectMetadataDir: "/work/.plain-agent",
    agentRoles: new Map(),
    skills: [],
    ...overrides,
  };
}

describe("createPrompt", () => {
  it("omits the User Preferences section when none are configured", () => {
    // given:
    const config = baseConfig();

    // when:
    const prompt = createPrompt(config);

    // then:
    assert.ok(!prompt.includes("# User Preferences"));
  });

  it("renders each preference as a line under the User Preferences heading", () => {
    // given:
    const config = baseConfig({
      userPreferences: ["code style: x", "communication style: y"],
    });

    // when:
    const prompt = createPrompt(config);

    // then:
    assert.ok(
      prompt.includes(
        "# User Preferences\n\ncode style: x\ncommunication style: y",
      ),
    );
  });

  it("places the User Preferences section at the end of the prompt", () => {
    // given:
    const config = baseConfig({ userPreferences: ["some preference"] });

    // when:
    const prompt = createPrompt(config);

    // then:
    assert.ok(prompt.endsWith("# User Preferences\n\nsome preference"));
  });
});
