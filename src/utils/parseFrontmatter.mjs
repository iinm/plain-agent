/**
 * Parse simple key-value frontmatter using regex.
 * Only supports `key: value` format. No multiline strings.
 * @param {string} frontmatter - The YAML frontmatter content (without --- delimiters)
 * @returns {Record<string, string>} Parsed key-value pairs
 */
export function parseFrontmatter(frontmatter) {
  /** @type {Record<string, string>} */
  const result = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^(\w[\w-]*):\s?(.*)$/);
    if (match) {
      result[match[1]] = match[2].trimEnd();
    }
  }

  return result;
}
