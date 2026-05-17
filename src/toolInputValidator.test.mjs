import assert from "node:assert";
import { mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { AGENT_PROJECT_METADATA_DIR } from "./env.mjs";
import { isSafeToolInput, isSafeToolInputItem } from "./toolInputValidator.mjs";

const TEMP_DIR = path.resolve("tmp/is-safe-tool-input");

describe("isSafeToolInput", () => {
  const safePath = "README.md";
  const unsafePath = "../parent-file";

  const testCases = [
    { desc: "number", arg: 123, expected: true },
    { desc: "boolean", arg: true, expected: true },
    { desc: "undefined", arg: undefined, expected: true },
    { desc: "null", arg: null, expected: true },
    { desc: "safe string", arg: safePath, expected: true },
    { desc: "unsafe string", arg: unsafePath, expected: false },
    { desc: "empty array", arg: [], expected: true },
    { desc: "array of safe items", arg: [safePath, "-l", 1], expected: true },
    {
      desc: "array with an unsafe item",
      arg: [safePath, unsafePath],
      expected: false,
    },
    { desc: "empty object", arg: {}, expected: true },
    {
      desc: "object with safe values",
      arg: { a: safePath, b: "-l", c: 0 },
      expected: true,
    },
    {
      desc: "object with an unsafe nested value",
      arg: { a: [safePath, { b: unsafePath }] },
      expected: false,
    },
    { desc: "function (not allowed)", arg: () => {}, expected: false },
  ];

  for (const { desc, arg, expected } of testCases) {
    it(`should return ${expected} for ${desc}`, () => {
      assert.strictEqual(isSafeToolInput(arg), expected);
    });
  }
});

describe("isSafeToolInputItem", () => {
  const tmpSymlink = path.resolve(TEMP_DIR, "tmp");
  const agentTmpDir = path.resolve(AGENT_PROJECT_METADATA_DIR, "tmp");
  const symlinkInAllowedDir = path.resolve(agentTmpDir, "unsafe-symlink");
  const brokenSymlinkInAllowedDir = path.resolve(
    agentTmpDir,
    "broken-unsafe-symlink",
  );
  const brokenSymlinkOutside = path.resolve(TEMP_DIR, "broken-outside-symlink");
  const safeSymlinkInAllowedDir = path.resolve(
    agentTmpDir,
    "safe-symlink-inside",
  );
  const nestedSymlinkInAllowedDir = path.resolve(
    agentTmpDir,
    "nested-unsafe-symlink",
  );
  const circularSymlink = path.resolve(agentTmpDir, "circular-link");

  const midLink = path.resolve(TEMP_DIR, "mid-link");

  before(async () => {
    await rm(TEMP_DIR, { force: true, recursive: true });
    await rm(symlinkInAllowedDir, { force: true });
    await rm(brokenSymlinkInAllowedDir, { force: true });
    await rm(safeSymlinkInAllowedDir, { force: true });
    await rm(nestedSymlinkInAllowedDir, { force: true });
    await rm(circularSymlink, { force: true });

    await mkdir(TEMP_DIR, { recursive: true });
    await mkdir(agentTmpDir, { recursive: true });

    // Valid symlink to outside
    await symlink("/tmp", tmpSymlink);

    // Valid symlink in allowed dir to outside
    await symlink("/etc/passwd", symlinkInAllowedDir);

    // Broken symlink in allowed dir to outside
    await symlink("/non-existent-path-outside", brokenSymlinkInAllowedDir);

    // Broken symlink outside allowed dir to outside
    await symlink("/another-non-existent-outside", brokenSymlinkOutside);

    // Symlink in allowed dir to inside working directory
    await symlink(path.resolve("README.md"), safeSymlinkInAllowedDir);

    // Nested symlink: link1 -> link2 -> outside (broken)
    await symlink("/tmp/non-existent-nested", midLink);
    await symlink(midLink, nestedSymlinkInAllowedDir);

    // Circular symlink
    await symlink(circularSymlink, circularSymlink);
  });

  after(async () => {
    await rm(TEMP_DIR, { force: true, recursive: true });
    await rm(symlinkInAllowedDir, { force: true });
    await rm(brokenSymlinkInAllowedDir, { force: true });
    await rm(safeSymlinkInAllowedDir, { force: true });
    await rm(nestedSymlinkInAllowedDir, { force: true });
    await rm(circularSymlink, { force: true });
  });

  const testCases = [
    // Non-path
    { desc: "command option", arg: "-l", expected: true },

    // Safe path
    {
      desc: "file in agent metadata directory",
      arg: `${AGENT_PROJECT_METADATA_DIR}/memory/foo.md`,
      expected: true,
    },
    { desc: "git managed file", arg: "README.md", expected: true },

    // Unsafe path
    {
      desc: "file outside the project directory",
      arg: "/absolute/path",
      expected: false,
    },
    {
      desc: "parent directory traversal",
      arg: "../parent-file",
      expected: false,
    },
    {
      desc: "symlink to outside the project directory",
      arg: tmpSymlink,
      expected: false,
    },
    {
      desc: "symlink in allowed directory (.agent/tmp) pointing outside",
      arg: symlinkInAllowedDir,
      expected: false,
    },
    {
      desc: "broken symlink in allowed directory (.agent/tmp) pointing outside",
      arg: brokenSymlinkInAllowedDir,
      expected: false,
    },
    {
      desc: "broken symlink outside pointing outside",
      arg: brokenSymlinkOutside,
      expected: false,
    },
    {
      desc: "symlink in allowed directory pointing inside",
      arg: safeSymlinkInAllowedDir,
      expected: true,
    },
    {
      desc: "nested symlink in allowed directory pointing outside (broken)",
      arg: nestedSymlinkInAllowedDir,
      expected: false,
    },
    {
      desc: "circular symlink in allowed directory",
      arg: circularSymlink,
      expected: false,
    },
    {
      desc: "safe path with unneeded parent directory reference",
      arg: `${AGENT_PROJECT_METADATA_DIR}/../${AGENT_PROJECT_METADATA_DIR}/memory/foo.md`,
      expected: false,
    },
    {
      desc: "parent directory traversal; start with safe path",
      arg: `${AGENT_PROJECT_METADATA_DIR}/../../parent-file`,
      expected: false,
    },
    { desc: "git ignored file", arg: "node_modules", expected: false },

    // .plain-agent/{tmp,memory,claude-code-plugins} are auto-approvable as
    // tool input even when git-ignored.
    {
      desc: "file in agent tmp directory",
      arg: `${AGENT_PROJECT_METADATA_DIR}/tmp/scratch.txt`,
      expected: true,
    },
    {
      desc: "file in claude-code-plugins directory",
      arg: `${AGENT_PROJECT_METADATA_DIR}/claude-code-plugins/feature-dev/foo.md`,
      expected: true,
    },

    // .plain-agent/{sandbox/, config.json, config.local.json} always require
    // explicit approval, even when git-managed: sandbox scripts run on the
    // host and config files drive the auto-approval policy itself, so silent
    // in-sandbox modification could lead to host code execution or
    // self-granted privilege escalation.
    {
      desc: "git managed file under .plain-agent/sandbox",
      arg: `${AGENT_PROJECT_METADATA_DIR}/sandbox/run.sh`,
      expected: false,
    },
    {
      desc: ".plain-agent/sandbox directory itself",
      arg: `${AGENT_PROJECT_METADATA_DIR}/sandbox`,
      expected: false,
    },
    {
      desc: "git managed .plain-agent/config.json",
      arg: `${AGENT_PROJECT_METADATA_DIR}/config.json`,
      expected: false,
    },
    {
      desc: "git ignored .plain-agent/config.local.json",
      arg: `${AGENT_PROJECT_METADATA_DIR}/config.local.json`,
      expected: false,
    },

    // Other entries under .plain-agent/ follow the standard git rule:
    // git-managed -> safe, git-ignored -> unsafe.
    {
      desc: "git managed .plain-agent/setup.sh",
      arg: `${AGENT_PROJECT_METADATA_DIR}/setup.sh`,
      expected: true,
    },
    {
      desc: "git managed file under .plain-agent/prompts",
      arg: `${AGENT_PROJECT_METADATA_DIR}/prompts/foo.md`,
      expected: true,
    },
    {
      desc: "git ignored file under .plain-agent/agents",
      arg: `${AGENT_PROJECT_METADATA_DIR}/agents/foo.md`,
      expected: false,
    },

    // Non-path arguments containing ".." or "..." should be allowed
    // as long as they are not path segments.
    {
      desc: "git revision range (contains ..)",
      arg: "main..HEAD",
      expected: true,
    },
    {
      desc: "git triple-dot revision range (contains ...)",
      arg: "feature...main",
      expected: true,
    },
  ];

  for (const { desc, arg, expected } of testCases) {
    it(`should return ${expected} for ${desc}: ${arg}`, () => {
      assert.strictEqual(isSafeToolInputItem(arg), expected);
    });
  }
});

describe("allowedPaths parameter", () => {
  it("should allow access to configured path outside working directory", () => {
    // given
    const allowedPaths = ["/tmp/allowed-test-dir"];
    // when
    const result = isSafeToolInputItem(
      "/tmp/allowed-test-dir/some-file.txt",
      allowedPaths,
    );
    // then
    assert.strictEqual(result, true);
  });

  it("should allow access to configured path itself", () => {
    // given
    const allowedPaths = ["/tmp/allowed-test-dir"];
    // when
    const result = isSafeToolInputItem("/tmp/allowed-test-dir", allowedPaths);
    // then
    assert.strictEqual(result, true);
  });

  it("should not allow access to non-configured path outside working directory", () => {
    // given
    const allowedPaths = ["/tmp/allowed-test-dir"];
    // when
    const result = isSafeToolInputItem(
      "/tmp/other-dir/some-file.txt",
      allowedPaths,
    );
    // then
    assert.strictEqual(result, false);
  });

  it("should merge multiple configured paths", () => {
    // given
    const allowedPaths = ["/tmp/dir1", "/tmp/dir2"];
    // when / then
    assert.strictEqual(
      isSafeToolInputItem("/tmp/dir1/file.txt", allowedPaths),
      true,
    );
    assert.strictEqual(
      isSafeToolInputItem("/tmp/dir2/file.txt", allowedPaths),
      true,
    );
    assert.strictEqual(
      isSafeToolInputItem("/tmp/dir3/file.txt", allowedPaths),
      false,
    );
  });

  it("should return false for configured path when allowedPaths is empty", () => {
    // given
    /** @type {string[]} */
    const allowedPaths = [];
    // when
    const result = isSafeToolInputItem("/tmp/allowed-test-dir", allowedPaths);
    // then
    assert.strictEqual(result, false);
  });

  it("should still allow built-in safe paths when allowedPaths is empty", () => {
    // given
    const agentTmpDir = path.resolve(AGENT_PROJECT_METADATA_DIR, "tmp");
    // when
    const result = isSafeToolInputItem(agentTmpDir, []);
    // then
    assert.strictEqual(result, true);
  });

  it("should block isUnsafeProjectPath even when in allowedPaths", () => {
    // given: sandbox path is in UNSAFE_PROJECT_PATHS and also in allowedPaths
    const sandboxPath = path.resolve(AGENT_PROJECT_METADATA_DIR, "sandbox");
    const allowedPaths = [sandboxPath];
    // when
    const result = isSafeToolInputItem(`${sandboxPath}/run.sh`, allowedPaths);
    // then: isUnsafeProjectPath takes priority over allowedPaths
    assert.strictEqual(result, false);
  });

  it("should block isUnsafeProjectPath config.json even when in allowedPaths", () => {
    // given
    const configPath = path.resolve(AGENT_PROJECT_METADATA_DIR, "config.json");
    const allowedPaths = [path.resolve(AGENT_PROJECT_METADATA_DIR)];
    // when
    const result = isSafeToolInputItem(configPath, allowedPaths);
    // then
    assert.strictEqual(result, false);
  });

  it("should block .. traversal even when target is in allowedPaths", () => {
    // given: a path with .. that resolves to an allowed directory
    const allowedPaths = ["/tmp/allowed-test-dir"];
    // when
    const result = isSafeToolInputItem(
      "/tmp/some-dir/../allowed-test-dir/file.txt",
      allowedPaths,
    );
    // then: .. traversal is blocked before allowedPaths check
    assert.strictEqual(result, false);
  });

  it("should not allow partial prefix match (prefix attack prevention)", () => {
    // given: allowed path is /tmp/allowed, but input starts with /tmp/allowedevil
    const allowedPaths = ["/tmp/allowed"];
    // when
    const result = isSafeToolInputItem(
      "/tmp/allowedevil/file.txt",
      allowedPaths,
    );
    // then: path separator ensures exact prefix matching
    assert.strictEqual(result, false);
  });

  it("should ignore relative paths in allowedPaths", () => {
    // given: a relative path in allowedPaths that resolves outside the working directory
    const allowedPaths = ["../other-project"];
    const outsidePath = path.resolve("../other-project/file.txt");
    // when
    const result = isSafeToolInputItem(outsidePath, allowedPaths);
    // then: relative paths are skipped by path.isAbsolute() check, so access is denied
    assert.strictEqual(result, false);
  });

  it("should ignore empty strings in allowedPaths", () => {
    // given: an empty string in allowedPaths
    const allowedPaths = [""];
    // when
    const result = isSafeToolInputItem("/tmp/some-file.txt", allowedPaths);
    // then: empty string should not allow arbitrary access
    assert.strictEqual(result, false);
  });

  it("should propagate allowedPaths through isSafeToolInput (top-level)", () => {
    // given: an object with a value pointing to an allowed external path
    const allowedPaths = ["/tmp/allowed-test-dir"];
    const input = { filePath: "/tmp/allowed-test-dir/some-file.txt" };
    // when
    const result = isSafeToolInput(input, allowedPaths);
    // then: allowedPaths is propagated through recursion
    assert.strictEqual(result, true);
  });

  it("should deny external path through isSafeToolInput when allowedPaths is empty", () => {
    // given: an object with a value pointing to an external path, no allowedPaths
    const input = { filePath: "/tmp/other-dir/file.txt" };
    // when
    const result = isSafeToolInput(input, []);
    // then
    assert.strictEqual(result, false);
  });
});
