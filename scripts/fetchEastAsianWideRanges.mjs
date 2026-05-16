/**
 * Generate East Asian Wide (W + Fullwidth F) range data from the official
 * Unicode EastAsianWidth.txt.
 *
 * Usage: node scripts/fetchEastAsianWideRanges.mjs [url] [output-path]
 *
 * Downloads EastAsianWidth.txt, extracts all
 * code points with East_Asian_Width property "W" (Wide) or "F" (Fullwidth),
 * merges overlapping/adjacent ranges, and writes the result as a JSON file.
 *
 * The JSON file is meant to be committed and imported at runtime.
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_URL =
  "https://www.unicode.org/Public/16.0.0/ucd/EastAsianWidth.txt";
const DEFAULT_OUTPUT = "src/cli/eastAsianWideRanges.json";

async function main() {
  const url = process.argv[2] || DEFAULT_URL;
  const outputPath = process.argv[3] || DEFAULT_OUTPUT;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  const data = await res.text();
  console.error(`Downloaded from ${url}`);

  const ranges = [];

  // Default W ranges described in the header of EastAsianWidth.txt
  const defaultWRanges = [
    [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
    [0x4e00, 0x9fff], // CJK Unified Ideographs
    [0xf900, 0xfaff], // CJK Compatibility Ideographs
    [0x20000, 0x2fffd], // Plane 2
    [0x30000, 0x3fffd], // Plane 3
  ];

  for (const line of data.split("\n")) {
    const m = line.match(
      /^([0-9A-F]{4,})(?:\.\.([0-9A-F]{4,}))?\s*;\s*(W|F)\s/,
    );
    if (!m) continue;
    const start = Number.parseInt(m[1], 16);
    const end = m[2] ? Number.parseInt(m[2], 16) : start;
    ranges.push([start, end]);
  }

  for (const [s, e] of defaultWRanges) {
    ranges.push([s, e]);
  }

  ranges.sort((a, b) => a[0] - b[0]);

  // Merge overlapping / adjacent ranges
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = ranges[i];
    if (cur[0] <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }

  const json = `${JSON.stringify(merged, null, 2)}\n`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, json);
  console.error(
    `Wrote ${merged.length} ranges to ${outputPath} (${Buffer.byteLength(json)} bytes)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
