/**
 * Collapse newlines (and any whitespace adjacent to them) into a single space
 * and trim. Used for rendering frontmatter values such as `description` in
 * single-line UI contexts (bullet lists, completer rows, console output).
 *
 * @param {string} s
 * @returns {string}
 */
export function toOneLine(s) {
  return s.replace(/\s*\n\s*/g, " ").trim();
}
