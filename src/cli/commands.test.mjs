import assert from "node:assert";
import { describe, it } from "node:test";
import {
  createCommandHandler,
  matchAgentsCommand,
  matchPromptsCommand,
  matchShortcutCommand,
  parseToolApprovalInput,
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

describe("parseToolApprovalInput", () => {
  it("maps y / yes / ｙ to allow once", () => {
    // when/then:
    for (const input of ["y", "yes", "ｙ"]) {
      assert.deepEqual(parseToolApprovalInput(input), { action: "allow" });
    }
  });

  it("maps Y / YES to allow for the session", () => {
    // when/then:
    for (const input of ["Y", "YES"]) {
      assert.deepEqual(parseToolApprovalInput(input), {
        action: "allowSession",
      });
    }
  });

  it("returns null for other input, including /resume", () => {
    // when/then:
    for (const input of ["n", "no", "please change", "/resume", "/help"]) {
      assert.equal(parseToolApprovalInput(input), null);
    }
  });
});

function createStubAgent() {
  /**
   * @typedef {Object} AgentCalls
   * @property {import("../agent").AgentInput[]} send
   * @property {import("../agent").ToolApprovalDecision[]} respondToToolApproval
   * @property {number} resume
   */
  /** @type {AgentCalls} */
  const calls = { send: [], respondToToolApproval: [], resume: 0 };
  return /** @type {import("../agent").Agent & {calls: AgentCalls}} */ (
    /** @type {unknown} */
    ({
      calls,
      send: (/** @type {any} */ input) => calls.send.push(input),
      respondToToolApproval: (/** @type {any} */ decision) =>
        calls.respondToToolApproval.push(decision),
      resume: () => {
        calls.resume += 1;
      },
      getActiveSubagent: () => null,
    })
  );
}

/** @param {import("../agent").Agent} agent */
function createStubHandler(agent) {
  return createCommandHandler(
    /** @type {import("./commands.mjs").CommandHandlerDeps} */ ({
      agent,
      costTracker: { calculateCost: () => ({}) },
      claudeCodePlugins: undefined,
      helpMessage: "help",
    }),
  );
}

describe("createCommandHandler", () => {
  it("/resume resumes the agent without sending input", async () => {
    // given:
    const agent = createStubAgent();
    const handleCommand = createStubHandler(agent);

    // when:
    const result = await handleCommand("/resume");

    // then:
    assert.equal(result, "continue");
    assert.equal(agent.calls.resume, 1);
    assert.deepEqual(agent.calls.send, []);
    assert.deepEqual(agent.calls.respondToToolApproval, []);
  });

  it("approves the pending tool use on y", async () => {
    // given:
    const agent = createStubAgent();
    const handleCommand = createStubHandler(agent);

    // when:
    const result = await handleCommand("y", { awaitingToolApproval: true });

    // then:
    assert.equal(result, "continue");
    assert.deepEqual(agent.calls.respondToToolApproval, [{ action: "allow" }]);
    assert.deepEqual(agent.calls.send, []);
  });

  it("denies the pending tool use and forwards feedback as content", async () => {
    // given:
    const agent = createStubAgent();
    const handleCommand = createStubHandler(agent);

    // when:
    const result = await handleCommand("please use a different approach", {
      awaitingToolApproval: true,
    });

    // then:
    assert.equal(result, "continue");
    assert.deepEqual(agent.calls.respondToToolApproval, [
      {
        action: "deny",
        content: [{ type: "text", text: "please use a different approach" }],
      },
    ]);
    assert.deepEqual(agent.calls.send, []);
  });

  it("runs a local command without touching the agent while awaiting approval", async (t) => {
    // given:
    t.mock.method(console, "log");
    const agent = createStubAgent();
    const handleCommand = createStubHandler(agent);

    // when:
    const result = await handleCommand("/help", { awaitingToolApproval: true });

    // then:
    assert.equal(result, "prompt");
    assert.deepEqual(agent.calls.respondToToolApproval, []);
    assert.deepEqual(agent.calls.send, []);
  });
});
