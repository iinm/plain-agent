import assert from "node:assert";
import { describe, it } from "node:test";
import { parseCliArgs } from "./args.mjs";

/**
 * @param {string[]} cliArgs
 */
function parse(cliArgs) {
  return parseCliArgs(["node", "plain", ...cliArgs]).subcommand;
}

describe("parseCliArgs (resume subcommand)", () => {
  it("parses bare `resume` as resuming the most recent session", () => {
    // when:
    const sub = parse(["resume"]);

    // then:
    assert.deepEqual(sub, {
      type: "resume",
      sessionId: null,
      list: false,
      config: [],
    });
  });

  it("parses `resume <sessionId>`", () => {
    // when:
    const sub = parse(["resume", "2026-05-10-0803-a7k"]);

    // then:
    assert.deepEqual(sub, {
      type: "resume",
      sessionId: "2026-05-10-0803-a7k",
      list: false,
      config: [],
    });
  });

  it("parses `resume --list`", () => {
    // when:
    const sub = parse(["resume", "--list"]);

    // then:
    assert.equal(sub.type, "resume");
    if (sub.type === "resume") {
      assert.equal(sub.list, true);
      assert.equal(sub.sessionId, null);
    }
  });

  it("collects -c flags", () => {
    // when:
    const sub = parse(["resume", "-c", "a.json", "--config", "b.json"]);

    // then:
    assert.equal(sub.type, "resume");
    if (sub.type === "resume") {
      assert.deepEqual(sub.config, ["a.json", "b.json"]);
    }
  });

  it("rejects -m by falling back to help (model switching is not supported)", () => {
    // when:
    const sub = parse(["resume", "-m", "claude-sonnet-4-6+thinking-high"]);

    // then:
    assert.deepEqual(sub, { type: "help" });
  });
});
