/**
 * @import { Tool } from '../tool'
 * @import { PatchFileInput } from './patchFile'
 */

import fs from "node:fs/promises";
import { noThrow } from "../utils/noThrow.mjs";

/**
 * @param {string} [nonce]
 * @returns {Tool}
 */
export function createPatchFileTool(
  nonce = Math.random().toString(36).substring(2, 5),
) {
  return {
    def: {
      name: "patch_file",
      description:
        "Modify a file by replacing specific content with new content.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
          },
          diff: {
            description: `
Format:
<<< ${nonce} <<< SEARCH
old content
=== ${nonce} ===
new content
>>> ${nonce} >>> REPLACE

<<< ${nonce} <<< SEARCH
other old content
=== ${nonce} ===
other new content
>>> ${nonce} >>> REPLACE

- Content is searched as an exact match including indentation and line breaks.
- The first match found will be replaced if there are multiple matches.
          `.trim(),
            type: "string",
          },
        },
        required: ["filePath", "diff"],
      },
    },

    /**
     * @param {PatchFileInput} input
     * @returns {Promise<string | Error>}
     */
    impl: async (input) =>
      await noThrow(async () => {
        const { filePath, diff } = input;

        // Validate marker counts: each block needs exactly one of each marker.
        // Since nonce is random, duplicate markers mean the user accidentally
        // included a marker line in their search/replace content (copy-paste error).
        const searchMarker = `<<< ${nonce} <<< SEARCH`;
        const sepMarker = `=== ${nonce} ===`;
        const replaceMarker = `>>> ${nonce} >>> REPLACE`;
        /** @type {(s: string, sub: string) => number} */
        const count = (s, sub) => s.split(sub).length - 1;
        const nSearch = count(diff, searchMarker);
        const nSep = count(diff, sepMarker);
        const nReplace = count(diff, replaceMarker);

        if (nSearch !== nReplace) {
          throw new Error(
            `Mismatched block markers: found ${nSearch} "${searchMarker}" but ${nReplace} "${replaceMarker}". ` +
              "Did you accidentally include a marker in your search/replace content?",
          );
        }
        if (nSep !== nSearch) {
          throw new Error(
            `Each diff block needs exactly one "${sepMarker}" separator, ` +
              `but found ${nSep} separators for ${nSearch} block(s). ` +
              "Did you accidentally include the separator marker in your search/replace content?",
          );
        }

        const content = await fs.readFile(filePath, "utf8");
        const matches = Array.from(
          diff.matchAll(
            new RegExp(
              `<<< ${nonce} <<< SEARCH\\n(.*?)\\n=== ${nonce} ===\\n(.*?)\\n?>>> ${nonce} >>> REPLACE`,
              "gs",
            ),
          ),
        );
        if (matches.length === 0) {
          throw new Error(
            `Invalid diff format. Each markers must include the nonce: <<< ${nonce} <<< SEARCH, === ${nonce} ===, >>> ${nonce} >>> REPLACE`,
          );
        }
        let newContent = content;
        for (const match of matches) {
          const [_, search, replace] = match;
          if (!newContent.includes(search)) {
            throw new Error(
              JSON.stringify(`Search content not found: ${search}`),
            );
          }
          // Escape $ characters in replacement string to prevent interpretation of $& $1 $$ patterns
          const escapedReplace = replace.replace(/\$/g, "$$$$");
          if (replace === "" && newContent.includes(`${search}\n`)) {
            newContent = newContent.replace(`${search}\n`, "");
          } else if (replace === "" && newContent.includes(`\n${search}`)) {
            newContent = newContent.replace(`\n${search}`, "");
          } else {
            newContent = newContent.replace(search, escapedReplace);
          }
        }
        await fs.writeFile(filePath, newContent);
        return `Patched file: ${filePath}`;
      }),

    /**
     * @param {Record<string, unknown>} input
     * @returns {Record<string, unknown>}
     */
    maskApprovalInput: (input) => {
      const patchFileInput = /** @type {PatchFileInput} */ (input);
      return {
        filePath: patchFileInput.filePath,
      };
    },
  };
}
