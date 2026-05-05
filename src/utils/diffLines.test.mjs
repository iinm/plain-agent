import assert from "node:assert";
import { describe, it } from "node:test";
import { diffLines } from "./diffLines.mjs";

describe("diffLines", () => {
  it("returns all-context ops for identical inputs", () => {
    // given:
    const oldLines = ["alpha", "bravo", "charlie"];
    const newLines = ["alpha", "bravo", "charlie"];

    // when:
    const ops = diffLines(oldLines, newLines);

    // then:
    assert.deepEqual(ops, [
      { type: " ", line: "alpha" },
      { type: " ", line: "bravo" },
      { type: " ", line: "charlie" },
    ]);
  });

  it("returns no ops when both inputs are empty", () => {
    // given/when:
    const ops = diffLines([], []);

    // then:
    assert.deepEqual(ops, []);
  });

  it("emits all removals when new is empty", () => {
    // given/when:
    const ops = diffLines(["a", "b"], []);

    // then:
    assert.deepEqual(ops, [
      { type: "-", line: "a" },
      { type: "-", line: "b" },
    ]);
  });

  it("emits all additions when old is empty", () => {
    // given/when:
    const ops = diffLines([], ["x", "y"]);

    // then:
    assert.deepEqual(ops, [
      { type: "+", line: "x" },
      { type: "+", line: "y" },
    ]);
  });

  it("emits removals then additions when nothing matches", () => {
    // given:
    const oldLines = ["a", "b"];
    const newLines = ["x", "y"];

    // when:
    const ops = diffLines(oldLines, newLines);

    // then:
    assert.deepEqual(ops, [
      { type: "-", line: "a" },
      { type: "-", line: "b" },
      { type: "+", line: "x" },
      { type: "+", line: "y" },
    ]);
  });

  it("preserves common prefix as context", () => {
    // given:
    const oldLines = ["alpha", "bravo", "charlie"];
    const newLines = ["alpha", "X", "Y"];

    // when:
    const ops = diffLines(oldLines, newLines);

    // then:
    assert.deepEqual(ops, [
      { type: " ", line: "alpha" },
      { type: "-", line: "bravo" },
      { type: "-", line: "charlie" },
      { type: "+", line: "X" },
      { type: "+", line: "Y" },
    ]);
  });

  it("preserves common suffix as context", () => {
    // given:
    const oldLines = ["alpha", "bravo", "charlie"];
    const newLines = ["X", "Y", "charlie"];

    // when:
    const ops = diffLines(oldLines, newLines);

    // then:
    assert.deepEqual(ops, [
      { type: "-", line: "alpha" },
      { type: "-", line: "bravo" },
      { type: "+", line: "X" },
      { type: "+", line: "Y" },
      { type: " ", line: "charlie" },
    ]);
  });

  it("treats a middle context line as a hunk boundary (- before + in each hunk)", () => {
    // given:
    const oldLines = ["alpha", "bravo", "charlie", "delta", "echo"];
    const newLines = ["alpha", "X", "charlie", "Y", "echo"];

    // when:
    const ops = diffLines(oldLines, newLines);

    // then:
    assert.deepEqual(ops, [
      { type: " ", line: "alpha" },
      { type: "-", line: "bravo" },
      { type: "+", line: "X" },
      { type: " ", line: "charlie" },
      { type: "-", line: "delta" },
      { type: "+", line: "Y" },
      { type: " ", line: "echo" },
    ]);
  });

  it("handles single-line replace as remove + add", () => {
    // given/when:
    const ops = diffLines(["original"], ["replacement"]);

    // then:
    assert.deepEqual(ops, [
      { type: "-", line: "original" },
      { type: "+", line: "replacement" },
    ]);
  });

  it("handles repeated lines correctly", () => {
    // given: same line appears twice; only one should match as context.
    const oldLines = ["a", "a", "b"];
    const newLines = ["a", "b"];

    // when:
    const ops = diffLines(oldLines, newLines);

    // then: backtrack prefers add-side at ties, so the first "a" is the
    // one that gets removed.
    assert.deepEqual(ops, [
      { type: "-", line: "a" },
      { type: " ", line: "a" },
      { type: " ", line: "b" },
    ]);
  });
});
