/**
 * @import { AppConfig } from "../config";
 * @import { ToolUsePattern } from "../tool";
 */

import { styleText } from "node:util";
import { matchValue } from "../utils/matchValue.mjs";

/**
 * @typedef {ToolUsePattern & { source?: string }} ToolUsePatternWithSource
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
  const tests = appConfig.autoApproval?.tests ?? [];

  if (tests.length === 0) {
    console.log("No test cases found in autoApproval.tests.");
    return 0;
  }

  let failCount = 0;

  for (const tc of tests) {
    const matchedPattern = patterns.find((p) =>
      matchValue(tc.toolUse, {
        toolName: p.toolName,
        ...(p.input !== undefined && { input: p.input }),
      }),
    );

    const got = matchedPattern?.action;
    const expected = tc.expectedAction === null ? undefined : tc.expectedAction;
    const sourceLabel = matchedPattern?.source
      ? `  [${matchedPattern.source}]`
      : "";

    if (got === expected) {
      console.log(styleText("green", `✓ ${tc.desc}`));
      if (got !== undefined) {
        console.log(`  matched: ${got}${sourceLabel}`);
      } else {
        console.log("  no pattern matched");
      }
    } else {
      failCount++;
      console.log(styleText("red", `✗ ${tc.desc}`));
      const expectedStr = expected ?? "no match";
      const gotStr = got ?? "no match";
      console.log(`  expected: ${expectedStr}, got: ${gotStr}${sourceLabel}`);
    }
    console.log();
  }

  if (failCount > 0) {
    console.error(
      styleText("red", `${failCount} of ${tests.length} test(s) failed.`),
    );
    return 1;
  }

  console.log(styleText("green", `All ${tests.length} test(s) passed.`));
  return 0;
}
