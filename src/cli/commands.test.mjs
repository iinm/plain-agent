import assert from "node:assert";
import { describe, it } from "node:test";
import {
  matchAgentsCommand,
  matchPromptsCommand,
  matchShortcutCommand,
} from "./commands.mjs";

describe("matchShortcutCommand", () => {
  it("matches a bare shortcut with no args", () => {
    // when:
    const m = matchShortcutCommand("/commit");

    // then:
    assert.ok(m);
    assert.equal(m[1], "commit");
    assert.equal(m[2], undefined);
  });

  it("matches a shortcut followed by a single-line space and args", () => {
    // when:
    const m = matchShortcutCommand("/commit   review this diff");

    // then:
    assert.ok(m);
    assert.equal(m[1], "commit");
    assert.equal(m[2], "review this diff");
  });

  it("captures args that span newlines", () => {
    // given: input where the args span newlines (mirrors the shape of
    //       resolved multi-line paste content concatenated after the cmd)
    const input = "/commit alpha\nbeta\ngamma";

    // when:
    const m = matchShortcutCommand(input);

    // then:
    assert.ok(m, "regex should match multi-line input");
    assert.equal(m[1], "commit");
    assert.equal(m[2], "alpha\nbeta\ngamma");
  });

  it("does not match a lone slash", () => {
    // when:
    assert.equal(matchShortcutCommand("/"), null);
  });

  it("does not match empty input", () => {
    // when:
    assert.equal(matchShortcutCommand(""), null);
  });
});

describe("matchPromptsCommand", () => {
  it("matches /prompts:foo with no args", () => {
    // when:
    const m = matchPromptsCommand("/prompts:foo");

    // then:
    assert.ok(m);
    assert.equal(m[1], "foo");
    assert.equal(m[2], undefined);
  });

  it("captures args that span newlines", () => {
    // given:
    const input = "/prompts:foo line1\nline2";

    // when:
    const m = matchPromptsCommand(input);

    // then:
    assert.ok(m);
    assert.equal(m[1], "foo");
    assert.equal(m[2], "line1\nline2");
  });

  it("does not match a shortcut-style command", () => {
    // when:
    assert.equal(matchPromptsCommand("/commit args"), null);
  });
});

describe("matchAgentsCommand", () => {
  it("matches /agents:explore with no goal", () => {
    // when:
    const m = matchAgentsCommand("/agents:explore");

    // then:
    assert.ok(m);
    assert.equal(m[1], "explore");
    assert.equal(m[2], undefined);
  });

  it("captures the goal that spans newlines", () => {
    // given:
    const input = "/agents:explore step1\nstep2";

    // when:
    const m = matchAgentsCommand(input);

    // then:
    assert.ok(m);
    assert.equal(m[1], "explore");
    assert.equal(m[2], "step1\nstep2");
  });

  it("does not match a shortcut-style command", () => {
    // when:
    assert.equal(matchAgentsCommand("/commit args"), null);
  });
});
