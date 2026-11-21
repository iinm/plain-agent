/**
 * @import { CallModel } from '../../model'
 * @import { WebSearchInput } from './types.mjs'
 */

import { execFile } from "node:child_process";
import {
  DEFAULT_MAX_LENGTH_PER_SEARCH,
  DEFAULT_SEARCH_TIMEOUT_MS,
  extractUrls,
  runSearches,
  truncateText,
} from "./answer.mjs";

/**
 * Runtime configuration for the `command` provider.
 *
 * Runs `command` once per keyword set with `args` followed by the keywords
 * (no shell). `modelCaller` is injected by the caller (e.g., `main.mjs`)
 * using the agent's main model and is used to distil the combined results
 * down to entries relevant to `question`.
 *
 * @typedef {Object} WebSearchToolCommandOptions
 * @property {"command"} provider
 * @property {string} command Executable used to perform each search (e.g., a wrapper around a search API).
 * @property {string[]} args Arguments passed before the keywords (e.g., `["-n", "5"]`).
 * @property {number=} timeoutMs Per-search timeout in milliseconds (default 30000).
 * @property {Record<string, string>=} env Extra environment variables, merged on top of PATH / HOME / LANG.
 * @property {CallModel} modelCaller
 * @property {number=} maxLengthPerSearch Truncate each search's output to this many characters (default 50000).
 * @property {number=} maxTotalLength Truncate the combined output across searches to this many characters (default 200000).
 * @property {number=} delayBetweenRequestsMs Delay between each search request in milliseconds (default 1000).
 */

/** @type {number} */
const SEARCH_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * @param {WebSearchToolCommandOptions} config
 * @param {WebSearchInput} input
 * @returns {Promise<string | Error>}
 */
export async function webSearchViaCommand(config, input) {
  /**
   * @param {string[]} keywords
   * @param {number} searchNumber
   */
  const searchOne = async (keywords, searchNumber) => {
    const raw = await runSearchCommand(config, keywords);
    const { text, truncated, originalLength } = truncateText(
      raw,
      config.maxLengthPerSearch ?? DEFAULT_MAX_LENGTH_PER_SEARCH,
    );
    return {
      text,
      truncated,
      originalLength,
      sources: extractUrls(text).map((url, index) => ({
        key: `${searchNumber}.${index + 1}`,
        url,
      })),
    };
  };

  const searchCommandDisplay = [
    config.command,
    ...config.args,
    "<KEYWORDS...>",
  ].join(" ");
  return runSearches(config, input, searchOne, {
    failureLabel: config.command,
    resultDescription: `Each search's raw output is wrapped in a <search keywords="..."> tag and was produced by \`${searchCommandDisplay}\`.`,
  });
}

/**
 * @param {WebSearchToolCommandOptions} config
 * @param {string[]} keywords
 * @returns {Promise<string>}
 */
function runSearchCommand(config, keywords) {
  return new Promise((resolve, reject) => {
    execFile(
      config.command,
      [...config.args, ...keywords],
      {
        shell: false,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          ...(config.env ?? {}),
        },
        timeout: config.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
        maxBuffer: SEARCH_MAX_BUFFER_BYTES,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `${config.command} failed for [${keywords.join(" ")}]: ${err.message}${stderr ? `\n${stderr}` : ""}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}
