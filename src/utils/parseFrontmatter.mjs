/**
 * Parse simple key-value frontmatter using regex.
 * Supports `key: value` and YAML block scalars (`key: |` literal,
 * `key: >` folded), with optional chomping indicators (`-`, `+`).
 * Block scalar lines are read while indented further than column 0,
 * using the first non-empty block line's indentation as the base.
 * @param {string} frontmatter - The YAML frontmatter content (without --- delimiters)
 * @returns {Record<string, string>} Parsed key-value pairs
 */
export function parseFrontmatter(frontmatter) {
  /** @type {Record<string, string>} */
  const result = {};

  const lines = frontmatter.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const blockMatch = line.match(/^(\w[\w-]*):\s*([|>])[+-]?\s*$/);
    if (blockMatch) {
      const key = blockMatch[1];
      const style = blockMatch[2];
      i++;

      /** @type {string[]} */
      const blockLines = [];
      let indent = -1;
      while (i < lines.length) {
        const blockLine = lines[i];
        if (blockLine.trim() === "") {
          blockLines.push("");
          i++;
          continue;
        }
        const leadingSpaces = (blockLine.match(/^( *)/)?.[1] ?? "").length;
        if (indent === -1) {
          if (leadingSpaces === 0) break;
          indent = leadingSpaces;
        } else if (leadingSpaces < indent) {
          break;
        }
        blockLines.push(blockLine.slice(indent));
        i++;
      }

      while (blockLines.at(-1) === "") {
        blockLines.pop();
      }

      result[key] =
        style === "|" ? blockLines.join("\n") : foldFolded(blockLines);
      continue;
    }

    const match = line.match(/^(\w[\w-]*):\s?(.*)$/);
    if (match) {
      result[match[1]] = match[2].trimEnd();
    }
    i++;
  }

  return result;
}

/**
 * @param {string[]} blockLines
 * @returns {string}
 */
function foldFolded(blockLines) {
  const paragraphs = [];
  let current = [];
  for (const line of blockLines) {
    if (line === "") {
      paragraphs.push(current.join(" "));
      current = [];
    } else {
      current.push(line);
    }
  }
  paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}
