import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runCleanCommand } from "./clean.mjs";

describe("runCleanCommand", () => {
  /** @type {string} */
  let workDir;
  /** @type {string} */
  let originalCwd;
  /** @type {string[]} */
  let logs;
  /** @type {string[]} */
  let errors;
  /** @type {typeof console.log} */
  let originalLog;
  /** @type {typeof console.error} */
  let originalError;

  beforeEach(async () => {
    originalCwd = process.cwd();
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "plain-clean-"));
    process.chdir(workDir);

    logs = [];
    errors = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    delete (/** @type {{ isTTY?: boolean }} */ (process.stdin).isTTY);
    process.chdir(originalCwd);
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("removes both directories when forced", async () => {
    // given:
    await seedDir(".plain-agent/tmp");
    await seedDir(".plain-agent/sessions");

    // when:
    const exitCode = await runCleanCommand({
      targets: ["tmp", "sessions"],
      force: true,
      dryRun: false,
    });

    // then:
    assert.equal(exitCode, 0);
    assert.equal(await exists(".plain-agent/tmp"), false);
    assert.equal(await exists(".plain-agent/sessions"), false);
    assert.deepEqual(logs, [
      "Removed .plain-agent/tmp",
      "Removed .plain-agent/sessions",
    ]);
  });

  it("removes only the existing target", async () => {
    // given:
    await seedDir(".plain-agent/tmp");

    // when:
    const exitCode = await runCleanCommand({
      targets: ["tmp", "sessions"],
      force: true,
      dryRun: false,
    });

    // then:
    assert.equal(exitCode, 0);
    assert.deepEqual(logs, ["Removed .plain-agent/tmp"]);
  });

  it("reports what would be removed on dry run", async () => {
    // given:
    await seedDir(".plain-agent/tmp");
    await seedDir(".plain-agent/sessions");

    // when:
    const exitCode = await runCleanCommand({
      targets: ["tmp", "sessions"],
      force: false,
      dryRun: true,
    });

    // then:
    assert.equal(exitCode, 0);
    assert.equal(await exists(".plain-agent/tmp"), true);
    assert.equal(await exists(".plain-agent/sessions"), true);
    assert.deepEqual(logs, [
      "Would remove .plain-agent/tmp",
      "Would remove .plain-agent/sessions",
    ]);
  });

  it("reports nothing to clean when no target exists", async () => {
    // when:
    const exitCode = await runCleanCommand({
      targets: ["tmp", "sessions"],
      force: false,
      dryRun: false,
    });

    // then:
    assert.equal(exitCode, 0);
    assert.deepEqual(logs, ["Nothing to clean."]);
  });

  it("aborts without removing when confirmation is declined", async () => {
    // given:
    await seedDir(".plain-agent/tmp");
    setTty(true);

    // when:
    const exitCode = await runCleanCommand({
      targets: ["tmp"],
      force: false,
      dryRun: false,
      confirm: async () => false,
    });

    // then:
    assert.equal(exitCode, 0);
    assert.equal(await exists(".plain-agent/tmp"), true);
    assert.deepEqual(logs, ["Aborted."]);
  });

  it("removes when confirmation is accepted", async () => {
    // given:
    await seedDir(".plain-agent/tmp");
    setTty(true);

    // when:
    const exitCode = await runCleanCommand({
      targets: ["tmp"],
      force: false,
      dryRun: false,
      confirm: async () => true,
    });

    // then:
    assert.equal(exitCode, 0);
    assert.equal(await exists(".plain-agent/tmp"), false);
    assert.deepEqual(logs, ["Removed .plain-agent/tmp"]);
  });

  it("refuses to remove without -f when stdin is not a TTY", async () => {
    // given:
    await seedDir(".plain-agent/tmp");
    setTty(false);

    // when:
    const exitCode = await runCleanCommand({
      targets: ["tmp"],
      force: false,
      dryRun: false,
      confirm: async () => true,
    });

    // then:
    assert.equal(exitCode, 1);
    assert.equal(await exists(".plain-agent/tmp"), true);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Use -f to force/);
  });
});

/** @param {boolean} value */
function setTty(value) {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
  });
}

/** @param {string} rel */
async function seedDir(rel) {
  await fs.mkdir(rel, { recursive: true });
  await fs.writeFile(path.join(rel, "dummy.txt"), "x", "utf8");
}

/** @param {string} rel */
async function exists(rel) {
  try {
    await fs.access(rel);
    return true;
  } catch {
    return false;
  }
}
