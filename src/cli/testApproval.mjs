/**
 * @import { AppConfig, AutoApprovalTestCase } from "../config";
 * @import { ToolUsePattern } from "../tool";
 */

import { styleText } from "node:util";
import { matchValue } from "../utils/matchValue.mjs";

/**
 * @typedef {ToolUsePattern & { source?: string }} ToolUsePatternWithSource
 */

/**
 * @typedef {AutoApprovalTestCase & { source?: string }} AutoApprovalTestCaseWithSource
 */

/**
 * @typedef {'pass' | 'warn' | 'fail'} TestVerdict
 */

/**
 * @typedef {Object} TestResult
 * @property {TestVerdict} verdict
 * @property {AutoApprovalTestCaseWithSource} tc
 * @property {string | undefined} got
 * @property {string | undefined} expected
 * @property {string | undefined} patternSource
 */

/**
 * Run auto-approval rule tests defined in the app config.
 * @param {AppConfig} appConfig
 * @returns {number} exit code (0 = all passed, 1 = any failed)
 */
export function runTestApprovalCommand(appConfig) {
  const patterns = /** @type {ToolUsePatternWithSource[]} */ (
    appConfig.autoApproval?.patterns ?? []
  );
  const tests = /** @type {AutoApprovalTestCaseWithSource[]} */ (
    appConfig.autoApproval?.tests ?? []
  );

  if (tests.length === 0) {
    console.log("No test cases found in autoApproval.tests.");
    return 0;
  }

  const results = evaluateTests(tests, patterns);
  console.log();
  printResults(results);

  const failCount = results.filter((r) => r.verdict === "fail").length;
  const warnCount = results.filter((r) => r.verdict === "warn").length;

  if (failCount > 0) {
    console.error(
      styleText("red", `${failCount} failed`) +
        (warnCount > 0
          ? `, ${styleText("yellow", `${warnCount} overridden`)}`
          : "") +
        `, ${tests.length} total`,
    );
    return 1;
  }

  if (warnCount > 0) {
    console.log(
      styleText("yellow", `${tests.length} passed (${warnCount} overridden)`),
    );
  } else {
    console.log(styleText("green", `${tests.length} passed`));
  }
  return 0;
}

/**
 * @param {AutoApprovalTestCaseWithSource[]} tests
 * @param {ToolUsePatternWithSource[]} patterns
 * @returns {TestResult[]}
 */
function evaluateTests(tests, patterns) {
  return tests.map((tc) => {
    const matchedPattern = patterns.find((p) =>
      matchValue(tc.toolUse, {
        toolName: p.toolName,
        ...(p.input !== undefined && { input: p.input }),
      }),
    );

    const got = matchedPattern?.action;
    const expected = tc.expectedAction === null ? undefined : tc.expectedAction;
    const patternSource = matchedPattern?.source;

    /** @type {TestVerdict} */
    let verdict;
    if (got === expected) {
      verdict = "pass";
    } else if (isOverriddenByDifferentConfig(tc.source, patternSource, got)) {
      verdict = "warn";
    } else {
      verdict = "fail";
    }

    return { verdict, tc, got, expected, patternSource };
  });
}

/**
 * @param {TestResult[]} results
 */
function printResults(results) {
  /** @type {Map<string, TestResult[]>} */
  const grouped = new Map();
  for (const r of results) {
    const key = r.tc.source ?? "";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)?.push(r);
  }

  for (const [source, group] of grouped) {
    if (source) {
      console.log(styleText("blue", `[${source}]`));
    }
    for (const r of group) {
      printSingleResult(r);
    }
    console.log();
  }
}

/**
 * @param {TestResult} r
 */
function printSingleResult(r) {
  const gotStr = r.got ?? "no match";
  const expectedStr = r.expected ?? "no match";

  if (r.verdict === "pass") {
    console.log(styleText("green", `  ✓ ${r.tc.desc}`));
  } else if (r.verdict === "warn") {
    console.log(
      styleText("yellow", `  ⚠ ${r.tc.desc}`) +
        ` — got: ${gotStr} (overridden by ${r.patternSource})`,
    );
  } else {
    console.log(styleText("red", `  ✗ ${r.tc.desc}`));
    const sourceLabel = r.patternSource ? `  [${r.patternSource}]` : "";
    console.log(`    expected: ${expectedStr}, got: ${gotStr}${sourceLabel}`);
  }
}

/**
 * @param {string | undefined} testSource
 * @param {string | undefined} patternSource
 * @param {string | undefined} got
 * @returns {boolean}
 */
function isOverriddenByDifferentConfig(testSource, patternSource, got) {
  if (!testSource || !patternSource) return false;
  if (got === undefined) return false;
  return testSource !== patternSource;
}
