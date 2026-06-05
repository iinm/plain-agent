/**
 * @import { ToolUsePattern } from "./tool";
 */

import assert from "node:assert";
import fs from "node:fs/promises";
import test, { describe } from "node:test";
import { AGENT_ROOT } from "./env.mjs";
import { evalJSONConfig } from "./utils/evalJSONConfig.mjs";
import { matchValue } from "./utils/matchValue.mjs";

describe("predefined patterns from config.predefined.json", async () => {
  const content = await fs.readFile(
    `${AGENT_ROOT}/config/config.predefined.json`,
    "utf-8",
  );
  const parsed = JSON.parse(content.replace(/^ *\/\/.+$/gm, ""));
  const config =
    /** @type {{ autoApproval?: { patterns?: ToolUsePattern[] } }} */ (
      evalJSONConfig(parsed)
    );
  const patterns = config.autoApproval?.patterns ?? [];

  const testCases = [
    {
      desc: "ls should be allowed",
      toolUse: { toolName: "exec_command", input: { command: "ls" } },
      action: "allow",
    },
    {
      desc: "rm should not match any pattern",
      toolUse: { toolName: "exec_command", input: { command: "rm" } },
      action: undefined,
    },
    {
      desc: "fd with safe args should be allowed",
      toolUse: {
        toolName: "exec_command",
        input: { command: "fd", args: ["--max-depth", "3"] },
      },
      action: "allow",
    },
    {
      desc: "fd with -H only should be allowed",
      toolUse: {
        toolName: "exec_command",
        input: { command: "fd", args: ["-H", "pattern"] },
      },
      action: "allow",
    },
    {
      desc: "fd with unsafe args should be ask",
      toolUse: {
        toolName: "exec_command",
        input: { command: "fd", args: ["--unrestricted"] },
      },
      action: "ask",
    },
    {
      desc: "fd with -I option should be ask",
      toolUse: {
        toolName: "exec_command",
        input: { command: "fd", args: ["-I", "pattern"] },
      },
      action: "ask",
    },
    {
      desc: "fd with -HI combined options should be ask",
      toolUse: {
        toolName: "exec_command",
        input: { command: "fd", args: ["-HI", "pattern"] },
      },
      action: "ask",
    },
    {
      desc: "fd with -IH combined options should be ask",
      toolUse: {
        toolName: "exec_command",
        input: { command: "fd", args: ["-IH", "pattern"] },
      },
      action: "ask",
    },
    {
      desc: "fd with -Hx=command combined options with value should be ask",
      toolUse: {
        toolName: "exec_command",
        input: { command: "fd", args: ["-Hx=cat", "pattern"] },
      },
      action: "ask",
    },
    {
      desc: "rg with safe args should be allowed",
      toolUse: {
        toolName: "exec_command",
        input: { command: "rg", args: ["--ignore-case", "pattern"] },
      },
      action: "allow",
    },
    {
      desc: "rg with -H only should be allowed",
      toolUse: {
        toolName: "exec_command",
        input: { command: "rg", args: ["-H", "pattern"] },
      },
      action: "allow",
    },
    {
      desc: "rg with unsafe args should be ask",
      toolUse: {
        toolName: "exec_command",
        input: { command: "rg", args: ["--unrestricted"] },
      },
      action: "ask",
    },
    {
      desc: "rg with -u option should be ask",
      toolUse: {
        toolName: "exec_command",
        input: { command: "rg", args: ["-u", "pattern"] },
      },
      action: "ask",
    },
    {
      desc: "rg with -Hu combined options should be ask",
      toolUse: {
        toolName: "exec_command",
        input: { command: "rg", args: ["-Hu", "pattern"] },
      },
      action: "ask",
    },
    {
      desc: "rg with -uH combined options should be ask",
      toolUse: {
        toolName: "exec_command",
        input: { command: "rg", args: ["-uH", "pattern"] },
      },
      action: "ask",
    },
    {
      desc: "sed with known pattern should be allowed",
      toolUse: {
        toolName: "exec_command",
        input: { command: "sed", args: ["-n", "10,20p", "file.txt"] },
      },
      action: "allow",
    },
    {
      desc: "sed with single line pattern should be allowed",
      toolUse: {
        toolName: "exec_command",
        input: { command: "sed", args: ["-n", "42p", "file.txt"] },
      },
      action: "allow",
    },
    {
      desc: "git status should be allowed",
      toolUse: {
        toolName: "exec_command",
        input: { command: "git", args: ["status"] },
      },
      action: "allow",
    },
    {
      desc: "git branch --show-current should be allowed",
      toolUse: {
        toolName: "exec_command",
        input: { command: "git", args: ["branch", "--show-current"] },
      },
      action: "allow",
    },
    {
      desc: "git commit should not match any pattern",
      toolUse: {
        toolName: "exec_command",
        input: { command: "git", args: ["commit"] },
      },
      action: undefined,
    },
    {
      desc: "docker ps should be allowed",
      toolUse: {
        toolName: "exec_command",
        input: { command: "docker", args: ["ps"] },
      },
      action: "allow",
    },
    {
      desc: "docker compose ps should be allowed",
      toolUse: {
        toolName: "exec_command",
        input: { command: "docker", args: ["compose", "ps"] },
      },
      action: "allow",
    },
    {
      desc: "docker compose logs should be allowed",
      toolUse: {
        toolName: "exec_command",
        input: { command: "docker", args: ["compose", "logs"] },
      },
      action: "allow",
    },
    {
      desc: "tmux list-sessions should be allowed",
      toolUse: {
        toolName: "tmux_command",
        input: { command: "list-sessions" },
      },
      action: "allow",
    },
    {
      desc: "gh pr view should be allowed",
      toolUse: {
        toolName: "exec_command",
        input: { command: "gh", args: ["pr", "view"] },
      },
      action: "allow",
    },
    {
      desc: "gh api for PR comments should be allowed",
      toolUse: {
        toolName: "exec_command",
        input: {
          command: "gh",
          args: [
            "api",
            "--method",
            "GET",
            "repos/owner/repo/pulls/123/comments",
          ],
        },
      },
      action: "allow",
    },
    {
      desc: "gh api without --method should be denied",
      toolUse: {
        toolName: "exec_command",
        input: { command: "gh", args: ["api", "repos/owner/repo/pulls"] },
      },
      action: "deny",
    },
    {
      desc: "gh api --method POST should fall through to defaultAction",
      toolUse: {
        toolName: "exec_command",
        input: {
          command: "gh",
          args: ["api", "--method", "POST", "repos/owner/repo/issues"],
        },
      },
      action: undefined,
    },
    {
      desc: "bash -c without shell features should be denied",
      toolUse: {
        toolName: "exec_command",
        input: { command: "bash", args: ["-c", "echo hello"] },
      },
      action: "deny",
    },
    {
      desc: "bash -c with pipe should not match deny pattern",
      toolUse: {
        toolName: "exec_command",
        input: { command: "bash", args: ["-c", "echo hello | grep hello"] },
      },
      action: undefined,
    },
    {
      desc: "bash -c with redirect should not match deny pattern",
      toolUse: {
        toolName: "exec_command",
        input: { command: "bash", args: ["-c", "echo hello > file.txt"] },
      },
      action: undefined,
    },
    {
      desc: "bash -c with ampersand should not match deny pattern",
      toolUse: {
        toolName: "exec_command",
        input: { command: "bash", args: ["-c", "cmd1 && cmd2"] },
      },
      action: undefined,
    },
    {
      desc: "bash -c with semicolon should not match deny pattern",
      toolUse: {
        toolName: "exec_command",
        input: {
          command: "bash",
          args: ["-c", "for i in *.txt; do echo $i; done"],
        },
      },
      action: undefined,
    },
    {
      desc: "bash -c with command substitution should not match deny pattern",
      toolUse: {
        toolName: "exec_command",
        input: { command: "bash", args: ["-c", "echo $(date)"] },
      },
      action: undefined,
    },
    {
      desc: "bash -c with backtick should not match deny pattern",
      toolUse: {
        toolName: "exec_command",
        input: { command: "bash", args: ["-c", "echo `date`"] },
      },
      action: undefined,
    },
  ];

  for (const { desc, toolUse, action } of testCases) {
    test(desc, () => {
      const matchedPattern = patterns.find((p) =>
        matchValue(toolUse, {
          toolName: p.toolName,
          ...(p.input !== undefined && { input: p.input }),
        }),
      );
      assert.strictEqual(matchedPattern?.action, action);
    });
  }
});
