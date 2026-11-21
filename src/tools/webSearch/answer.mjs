/**
 * @import { CallModel } from '../../model'
 * @import { SearchSource, WebSearchInput } from './types.mjs'
 */

import { styleText } from "node:util";

/** @type {number} */
export const DEFAULT_MAX_LENGTH_PER_SEARCH = 50_000;

/** @type {number} */
const DEFAULT_MAX_TOTAL_LENGTH = 200_000;

/** @type {number} */
const DEFAULT_DELAY_BETWEEN_REQUESTS_MS = 1_000;

/** @type {number} */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;

/** @type {number} */
export const MAX_RETRIES = 5;

/**
 * The part of a provider's config that `runSearches` needs.
 *
 * @typedef {Object} SearchRunConfig
 * @property {CallModel} modelCaller
 * @property {number=} maxTotalLength
 * @property {number=} delayBetweenRequestsMs
 */

/**
 * One provider's search output, already truncated to the per-search limit.
 * `sources` must contain only sources visible in `text`.
 *
 * @typedef {Object} SearchOneResult
 * @property {string} text
 * @property {boolean} truncated
 * @property {number} originalLength
 * @property {SearchSource[]} sources
 */

/**
 * @typedef {Object} WebSearchResult
 * @property {string[]} keywords
 * @property {string} text
 * @property {boolean} truncated
 * @property {number} originalLength
 * @property {SearchSource[]} sources URLs that can be cited for this search.
 * @property {string=} error
 */

/**
 * Run one search per keyword set and distil the combined output into an
 * answer for `input.question`.
 *
 * `searchOne` must truncate its own output before deriving sources and must
 * reject on failure. Truncation stays provider-side so that `sources` can only
 * contain what is visible in `text`.
 *
 * @param {SearchRunConfig} config
 * @param {WebSearchInput} input
 * @param {(keywords: string[], searchNumber: number) => Promise<SearchOneResult>} searchOne
 * @param {{ failureLabel: string, resultDescription: string }} options
 * @returns {Promise<string | Error>}
 */
export async function runSearches(config, input, searchOne, options) {
  const maxTotalLength = config.maxTotalLength ?? DEFAULT_MAX_TOTAL_LENGTH;
  const delayBetweenRequestsMs =
    config.delayBetweenRequestsMs ?? DEFAULT_DELAY_BETWEEN_REQUESTS_MS;

  /** @type {WebSearchResult[]} */
  const results = [];
  for (const [index, search] of input.searches.entries()) {
    if (delayBetweenRequestsMs > 0 && index > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, delayBetweenRequestsMs),
      );
    }
    try {
      const result = await searchOne(search.keywords, index + 1);
      results.push({ keywords: search.keywords, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(styleText("yellow", message));
      results.push({
        keywords: search.keywords,
        text: "",
        truncated: false,
        originalLength: 0,
        sources: [],
        error: message,
      });
    }
  }

  const successCount = results.filter((result) => !result.error).length;
  if (successCount === 0) {
    return new Error(
      `Failed to run any search via ${options.failureLabel}:\n${results
        .map(
          (result) =>
            `- [${result.keywords.join(" ")}]: ${result.error ?? "unknown"}`,
        )
        .join("\n")}`,
    );
  }

  return summarizeSearchResults(
    config,
    input,
    results,
    maxTotalLength,
    options.resultDescription,
  );
}

/**
 * Truncate `content` to at most `maxLength` characters, keeping the head.
 * When truncation occurs, a `[truncated: ...]` marker is appended.
 *
 * @param {string} content
 * @param {number} maxLength
 * @returns {{ text: string, truncated: boolean, originalLength: number }}
 */
export function truncateText(content, maxLength) {
  if (content.length <= maxLength) {
    return { text: content, truncated: false, originalLength: content.length };
  }
  const head = content.slice(0, maxLength);
  const truncatedLength = content.length - maxLength;
  return {
    text: `${head}\n\n[truncated: ${truncatedLength} of ${content.length} chars omitted]`,
    truncated: true,
    originalLength: content.length,
  };
}

/**
 * Extract unique HTTP(S) URLs from `text` in first-seen order, trimming
 * trailing punctuation that belongs to the surrounding prose.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  const urls = [];
  const seen = new Set();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]}]+/g)) {
    const url = match[0].replace(/[.,;:!?*_、。）」』】]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** Matches `[[1.1]]` and `[[2.3, 2.4]]` citation markers. */
const CITATION_MARKER = /\[\[\s*(\d+\.\d+(?:\s*,\s*\d+\.\d+)*)\s*\]\]/g;

/**
 * Collect the source keys used as citation markers (`[[1.1]]`, `[[2.3, 2.4]]`)
 * in `text`. Double brackets keep citations distinct from incidental `[1]` in
 * prose or code.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function extractCitedKeys(text) {
  const keys = new Set();
  for (const match of text.matchAll(CITATION_MARKER)) {
    for (const part of match[1].split(",")) {
      keys.add(part.trim());
    }
  }
  return keys;
}

/**
 * Rewrite citation markers to plain bracketed numbers for display.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeCitationMarkers(text) {
  return text.replace(CITATION_MARKER, (_, indices) => `[${indices}]`);
}

/**
 * Resolve the citation markers in `answerText` to the sources they refer to,
 * keeping the order of `sources`.
 *
 * @param {string} answerText
 * @param {SearchSource[]} sources
 * @returns {SearchSource[]}
 */
export function selectCitedSources(answerText, sources) {
  const citedKeys = extractCitedKeys(answerText);
  return sources.filter((source) => citedKeys.has(source.key));
}

/**
 * @param {SearchSource[]} citedSources
 * @returns {string | undefined}
 */
export function renderSources(citedSources) {
  if (citedSources.length === 0) {
    return undefined;
  }
  return `Sources:\n${citedSources
    .map((source) => `- [${source.key}] ${formatSource(source)}`)
    .join("\n")}`;
}

/**
 * Distil the combined results of several searches into an answer for
 * `question`, followed by a per-search summary list.
 *
 * @param {{ modelCaller: CallModel }} config
 * @param {WebSearchInput} input
 * @param {WebSearchResult[]} results
 * @param {number} maxTotalLength
 * @param {string} resultDescription Describes how a single search's output is formatted.
 * @returns {Promise<string | Error>}
 */
async function summarizeSearchResults(
  config,
  input,
  results,
  maxTotalLength,
  resultDescription,
) {
  const searchResultsText = renderSearchResults(results, maxTotalLength);
  // AgentCore output carries citation keys; command output only carries URLs.
  // Offering a source the model cannot see invites citations of unseen text.
  const sources = results
    .flatMap((result) => result.sources)
    .filter(
      (source) =>
        searchResultsText.includes(`[${source.key}]`) ||
        searchResultsText.includes(source.url),
    );
  const systemPrompt = [
    "You distil multiple web-search results into entries relevant to the user's question.",
    resultDescription,
    'Some searches may be marked truncated="true"; treat those as partial.',
    "Discard unrelated entries; keep only what helps answer the question.",
    "If none of the results are relevant, say so explicitly rather than guessing.",
    ...(sources.length === 0
      ? []
      : [
          "Cite each source you actually used as [[1.1]] or [[2.3, 2.4]], using the keys in the source list.",
          "Never write URLs yourself; the cited sources are listed after your answer.",
        ]),
  ].join(" ");

  const userPrompt = [
    `Question: ${input.question}`,
    "",
    "Searches run:",
    ...input.searches.map((s, i) => `- ${i + 1}. ${s.keywords.join(" ")}`),
    "",
    "Search results:",
    searchResultsText,
    ...(sources.length === 0
      ? []
      : [
          "",
          "Source list:",
          sources
            .map((source) => `[${source.key}] ${formatSource(source)}`)
            .join("\n"),
        ]),
  ].join("\n");

  const modelResult = await config.modelCaller({
    messages: [
      {
        role: "system",
        content: [{ type: "text", text: systemPrompt }],
      },
      {
        role: "user",
        content: [{ type: "text", text: userPrompt }],
      },
    ],
  });

  if (modelResult instanceof Error) {
    return modelResult;
  }

  const answerText = modelResult.message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();

  const summaryList = results
    .map((r, i) => {
      const suffix = r.error
        ? ` (error: ${r.error})`
        : r.truncated
          ? " (truncated)"
          : "";
      return `- [search ${i + 1}] ${r.keywords.join(" ")}${suffix}`;
    })
    .join("\n");

  const citedSources = selectCitedSources(answerText, sources);

  return [
    normalizeCitationMarkers(answerText),
    renderSources(citedSources),
    summaryList,
  ]
    .filter((section) => section !== undefined)
    .join("\n\n");
}

/**
 * @param {WebSearchResult[]} results
 * @param {number} maxTotalLength
 * @returns {string}
 */
function renderSearchResults(results, maxTotalLength) {
  const sections = results.map((r) => {
    const keywordsAttr = r.keywords.join(" ").replace(/"/g, "'");
    if (r.error) {
      return `<search keywords="${keywordsAttr}" error="${r.error.replace(/"/g, "'")}"></search>`;
    }
    const attrs = r.truncated
      ? ` truncated="true" original_length="${r.originalLength}"`
      : "";
    return `<search keywords="${keywordsAttr}"${attrs}>\n${r.text}\n</search>`;
  });
  return truncateText(sections.join("\n\n"), maxTotalLength).text;
}

/**
 * @param {SearchSource} source
 * @returns {string}
 */
function formatSource(source) {
  return source.title === undefined || source.title === ""
    ? source.url
    : `${source.title} - ${source.url}`;
}
