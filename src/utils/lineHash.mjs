/**
 * Compute a short hash of a line's full content (including whitespace).
 * Uses the DJB2 hash algorithm, producing a 3-hex-char digest (4,096 values).
 * @param {string} line
 * @returns {string} 3-character lowercase hex string
 */
export function lineHash(line) {
  let hash = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(3, "0").slice(0, 3);
}
