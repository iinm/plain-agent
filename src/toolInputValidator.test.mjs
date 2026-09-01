import assert from "node:assert";
import { mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { AGENT_PROJECT_METADATA_DIR } from "./env.mjs";
import { findUnsafeToolInputReason } from "./toolInputValidator.mjs";

const TEMP_DIR = path.resolve("tmp/is-safe-tool-input");

describe("findUnsafeToolInputReason", () => {
  const safePath = "README.md";
  const unsafePath = "../parent-file";

  const testCases = [
    { desc: "number", arg: 123, expected: null },
    { desc: "boolean", arg: true, expected: null },
    { desc: "undefined", arg: undefined, expected: null },
    { desc: "null", arg: null, expected: null },
    { desc: "safe string", arg: safePath, expected: null },
    {
      desc: "unsafe string",
      arg: unsafePath,
      expected: "path traversal",
    },
    { desc: "empty array", arg: [], expected: null },
    { desc: "array of safe items", arg: [safePath, "-l", 1], expected: null },
    {
      desc: "array with an unsafe item",
      arg: [safePath, unsafePath],
      expected: "path traversal",
    },
    { desc: "empty object", arg: {}, expected: null },
    {
      desc: "object with safe values",
      arg: { a: safePath, b: "-l", c: 0 },
      expected: null,
    },
    {
      desc: "object with an unsafe nested value",
      arg: { a: [safePath, { b: unsafePath }] },
      expected: "path traversal",
    },
    {
      desc: "function (not allowed)",
      arg: /** @type {any} */ (() => {}),
      expected: "unsupported input type",
    },
  ];

  for (const { desc, arg, expected } of testCases) {
    it(`should return ${expected} for ${desc}`, () => {
      // when:
      const reason = findUnsafeToolInputReason(arg);
      // then:
      if (expected === null) {
        assert.strictEqual(reason, null);
      } else {
        assertUnsafeReason(reason, expected);
      }
    });
  }
});

describe("findUnsafeToolInputReason for string inputs", () => {
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
    { desc: "command option", arg: "-l", expected: null },

    // Safe path
    {
      desc: "file in agent metadata directory",
      arg: `${AGENT_PROJECT_METADATA_DIR}/memory/foo.md`,
      expected: null,
    },
    { desc: "git managed file", arg: "README.md", expected: null },

    // Unsafe path
    {
      desc: "file outside the project directory",
      arg: "/absolute/path",
      expected: "outside the working directory",
    },
    {
      desc: "parent directory traversal",
      arg: "../parent-file",
      expected: "path traversal",
    },
    {
      desc: "symlink to outside the project directory",
      arg: tmpSymlink,
      expected: "outside the working directory",
    },
    {
      desc: "symlink in allowed directory (.agent/tmp) pointing outside",
      arg: symlinkInAllowedDir,
      expected: "outside the working directory",
    },
    {
      desc: "broken symlink in allowed directory (.agent/tmp) pointing outside",
      arg: brokenSymlinkInAllowedDir,
      expected: "outside the working directory",
    },
    {
      desc: "broken symlink outside pointing outside",
      arg: brokenSymlinkOutside,
      expected: "outside the working directory",
    },
    {
      desc: "symlink in allowed directory pointing inside",
      arg: safeSymlinkInAllowedDir,
      expected: null,
    },
    {
      desc: "nested symlink in allowed directory pointing outside (broken)",
      arg: nestedSymlinkInAllowedDir,
      expected: "outside the working directory",
    },
    {
      desc: "circular symlink in allowed directory",
      arg: circularSymlink,
      expected: "cannot resolve path",
    },
    {
      desc: "safe path with unneeded parent directory reference",
      arg: `${AGENT_PROJECT_METADATA_DIR}/../${AGENT_PROJECT_METADATA_DIR}/memory/foo.md`,
      expected: "path traversal",
    },
    {
      desc: "parent directory traversal; start with safe path",
      arg: `${AGENT_PROJECT_METADATA_DIR}/../../parent-file`,
      expected: "path traversal",
    },
    {
      desc: "git ignored file",
      arg: "node_modules",
      expected: "not managed by git",
    },

    // .plain-agent/{tmp,memory,claude-code-plugins} are auto-approvable as
    // tool input even when git-ignored.
    {
      desc: "file in agent tmp directory",
      arg: `${AGENT_PROJECT_METADATA_DIR}/tmp/scratch.txt`,
      expected: null,
    },
    {
      desc: "file in claude-code-plugins directory",
      arg: `${AGENT_PROJECT_METADATA_DIR}/claude-code-plugins/feature-dev/foo.md`,
      expected: null,
    },

    // Everything under .plain-agent/ is unsafe by default, except for
    // the built-in allowed subdirectories (memory, tmp, claude-code-plugins).
    {
      desc: "git managed file under .plain-agent/sandbox",
      arg: `${AGENT_PROJECT_METADATA_DIR}/sandbox/run.sh`,
      expected: "project metadata directory",
    },
    {
      desc: ".plain-agent/sandbox directory itself",
      arg: `${AGENT_PROJECT_METADATA_DIR}/sandbox`,
      expected: "project metadata directory",
    },
    {
      desc: "git managed .plain-agent/config.json",
      arg: `${AGENT_PROJECT_METADATA_DIR}/config.json`,
      expected: "project metadata directory",
    },
    {
      desc: "git ignored .plain-agent/config.local.json",
      arg: `${AGENT_PROJECT_METADATA_DIR}/config.local.json`,
      expected: "project metadata directory",
    },
    {
      desc: "git managed .plain-agent/setup.sh",
      arg: `${AGENT_PROJECT_METADATA_DIR}/setup.sh`,
      expected: "project metadata directory",
    },
    {
      desc: ".plain-agent directory itself",
      arg: AGENT_PROJECT_METADATA_DIR,
      expected: "project metadata directory",
    },

    // Non-path arguments containing ".." or "..." should be allowed
    // as long as they are not path segments.
    {
      desc: "git revision range (contains ..)",
      arg: "main..HEAD",
      expected: null,
    },
    {
      desc: "git triple-dot revision range (contains ...)",
      arg: "feature...main",
      expected: null,
    },

    // @<path> pattern
    { desc: "@file pattern with safe path", arg: "@README.md", expected: null },
    {
      desc: "@file pattern with parent traversal",
      arg: "@../parent-file",
      expected: "path traversal",
    },
    {
      desc: "@file pattern with absolute path outside",
      arg: "@/etc/passwd",
      expected: "outside the working directory",
    },

    // --opt=val pattern
    {
      desc: "--prefix= with safe path",
      arg: "--prefix=README.md",
      expected: null,
    },
    {
      desc: "--prefix= with parent traversal",
      arg: "--prefix=../parent-dir",
      expected: "path traversal",
    },
    {
      desc: "--prefix= with absolute path outside",
      arg: "--prefix=/tmp/foo",
      expected: "not managed by git",
    },

    // -X<val> pattern
    {
      desc: "-o with safe output file",
      arg: "-oREADME.md",
      expected: null,
    },
    {
      desc: "-o with parent traversal",
      arg: "-o../parent-file",
      expected: "path traversal",
    },
    {
      desc: "-o with absolute path outside",
      arg: "-o/tmp/out",
      expected: "not managed by git",
    },
    {
      desc: "-I with absolute include path outside",
      arg: "-I/usr/include",
      expected: "outside the working directory",
    },

    // VAR=val pattern
    {
      desc: "VAR=val with safe path",
      arg: "OUTPUT=README.md",
      expected: null,
    },
    {
      desc: "VAR=val with parent traversal",
      arg: "OUTPUT=../parent-file",
      expected: "path traversal",
    },
    {
      desc: "VAR=val with absolute path outside",
      arg: "OUTPUT=/etc/passwd",
      expected: "outside the working directory",
    },
    // cmake -DVAR=val: -D + VAR=/path → VAR=/path → /path (chained)
    {
      desc: "-D cmake define with absolute path outside",
      arg: "-DINSTALL_DIR=/etc",
      expected: "outside the working directory",
    },
    // A whole `bash -c` script string with a whitespace-containing key before `=`
    // must not be treated as VAR=val; it is validated as a working-dir path.
    {
      desc: "bash -c script with mid-string VAR=val is not a VAR=val assignment",
      arg: "cd foo && HOME=/tmp npm install",
      expected: null,
    },

    // proto://path pattern
    {
      desc: "file:// with absolute path outside",
      arg: "file:///etc/passwd",
      expected: "outside the working directory",
    },
    {
      desc: "file:// without absolute path (unsafe URI)",
      arg: "file://README.md",
      expected: "outside the working directory",
    },
    {
      desc: "http:// URL is not a local path",
      arg: "http://example.com/path",
      expected: null,
    },
    {
      desc: "https:// URL is not a local path",
      arg: "https://example.com:8080/some/path?query=1",
      expected: null,
    },
  ];

  for (const { desc, arg, expected } of testCases) {
    it(`should return ${expected} for ${desc}: ${arg}`, () => {
      // when:
      const reason = findUnsafeToolInputReason(arg);
      // then:
      if (expected === null) {
        assert.strictEqual(reason, null);
      } else {
        assertUnsafeReason(reason, expected);
      }
    });
  }
});

describe("allowedPaths parameter", () => {
  it("should block path outside git repo even when in allowedPaths", () => {
    // given:
    const allowedPaths = ["/tmp/allowed-test-dir"];
    // when:
    const reason = findUnsafeToolInputReason(
      "/tmp/allowed-test-dir/some-file.txt",
      allowedPaths,
    );
    // then:
    assertUnsafeReason(reason, "not managed by git");
  });

  it("should block path outside git repo (directory itself) even when in allowedPaths", () => {
    // given:
    const allowedPaths = ["/tmp/allowed-test-dir"];
    // when:
    const reason = findUnsafeToolInputReason(
      "/tmp/allowed-test-dir",
      allowedPaths,
    );
    // then:
    assertUnsafeReason(reason, "not managed by git");
  });

  it("should allow path outside git repo when allowGitUnmanagedFiles is true", () => {
    // given:
    const allowedPaths = ["/tmp/allowed-test-dir"];
    const allowGitUnmanagedFiles = true;
    // when:
    const reason = findUnsafeToolInputReason(
      "/tmp/allowed-test-dir/some-file.txt",
      allowedPaths,
      allowGitUnmanagedFiles,
    );
    // then:
    assert.strictEqual(reason, null);
  });

  it("should not allow access to non-configured path outside working directory", () => {
    // given
    const allowedPaths = ["/tmp/allowed-test-dir"];
    // when
    const reason = findUnsafeToolInputReason(
      "/tmp/other-dir/some-file.txt",
      allowedPaths,
    );
    // then
    assertUnsafeReason(reason, "outside the working directory");
  });

  it("should return false when allowedPaths is empty", () => {
    // given
    /** @type {string[]} */
    const allowedPaths = [];
    // when
    const reason = findUnsafeToolInputReason(
      "/tmp/allowed-test-dir",
      allowedPaths,
    );
    // then
    assertUnsafeReason(reason, "outside the working directory");
  });

  it("should still allow built-in safe paths when allowedPaths is empty", () => {
    // given
    const agentTmpDir = path.resolve(AGENT_PROJECT_METADATA_DIR, "tmp");
    // when
    const reason = findUnsafeToolInputReason(agentTmpDir, []);
    // then
    assert.strictEqual(reason, null);
  });

  it("should block .plain-agent paths even when in allowedPaths", () => {
    // given: sandbox path is under .plain-agent (not a builtin allowed subdir)
    // and explicitly added to allowedPaths
    const sandboxPath = path.resolve(AGENT_PROJECT_METADATA_DIR, "sandbox");
    const allowedPaths = [sandboxPath];
    // when
    const reason = findUnsafeToolInputReason(
      `${sandboxPath}/run.sh`,
      allowedPaths,
    );
    // then: .plain-agent restriction takes priority over allowedPaths
    assertUnsafeReason(reason, "project metadata directory");
  });

  it("should block .. traversal even when target is in allowedPaths", () => {
    // given: a path with .. that resolves to an allowed directory
    const allowedPaths = ["/tmp/allowed-test-dir"];
    // when
    const reason = findUnsafeToolInputReason(
      "/tmp/some-dir/../allowed-test-dir/file.txt",
      allowedPaths,
    );
    // then: .. traversal is blocked before allowedPaths check
    assertUnsafeReason(reason, "path traversal");
  });

  it("should not allow partial prefix match (prefix attack prevention)", () => {
    // given: allowed path is /tmp/allowed, but input starts with /tmp/allowedevil
    const allowedPaths = ["/tmp/allowed"];
    // when
    const reason = findUnsafeToolInputReason(
      "/tmp/allowedevil/file.txt",
      allowedPaths,
    );
    // then: path separator ensures exact prefix matching
    assertUnsafeReason(reason, "outside the working directory");
  });

  it("should ignore relative paths in allowedPaths", () => {
    // given: a relative path in allowedPaths that resolves outside the working directory
    const allowedPaths = ["../other-project"];
    const outsidePath = path.resolve("../other-project/file.txt");
    // when
    const reason = findUnsafeToolInputReason(outsidePath, allowedPaths);
    // then: relative paths are skipped by path.isAbsolute() check, so access is denied
    assertUnsafeReason(reason, "outside the working directory");
  });

  it("should ignore empty strings in allowedPaths", () => {
    // given: an empty string in allowedPaths
    const allowedPaths = [""];
    // when
    const reason = findUnsafeToolInputReason("tmp/some-file.txt", allowedPaths);
    // then: empty string should not allow arbitrary access
    assertUnsafeReason(reason, "not managed by git");
  });

  it("should block git-ignored path even when in allowedPaths", () => {
    // given: node_modules is git-ignored in this repo, add it to allowedPaths
    const nodeModulesPath = path.resolve("node_modules");
    const allowedPaths = [nodeModulesPath];
    // when
    const reason = findUnsafeToolInputReason("node_modules", allowedPaths);
    // then: git-ignore check takes precedence over allowedPaths
    assertUnsafeReason(reason, "not managed by git");
  });
});

describe("allowGitUnmanagedFiles parameter", () => {
  it("should allow git-unmanaged file when allowGitUnmanagedFiles is true", () => {
    // given:
    const allowGitUnmanagedFiles = true;
    // when:
    const reason = findUnsafeToolInputReason(
      "node_modules",
      [],
      allowGitUnmanagedFiles,
    );
    // then:
    assert.strictEqual(reason, null);
  });

  it("should propagate allowGitUnmanagedFiles through findUnsafeToolInputReason", () => {
    // given:
    const input = { filePath: "node_modules/.package-lock.json" };
    // when:
    const reasonAllowed = findUnsafeToolInputReason(input, [], true);
    const reasonBlocked = findUnsafeToolInputReason(input, [], false);
    // then:
    assert.strictEqual(reasonAllowed, null);
    assertUnsafeReason(reasonBlocked, "not managed by git");
  });
});

/**
 * @param {string | null} reason
 * @param {string} expectedSubstring
 * @returns {void}
 */
function assertUnsafeReason(reason, expectedSubstring) {
  assert.ok(
    typeof reason === "string" && reason.includes(expectedSubstring),
    `expected reason containing "${expectedSubstring}", got: ${reason}`,
  );
}
