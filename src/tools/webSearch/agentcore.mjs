/**
 * @import { CallModel } from '../../model'
 * @import { SearchSource, WebSearchInput } from './types.mjs'
 */

import { styleText } from "node:util";
import {
  loadAwsCredentials,
  signAwsRequest,
} from "../../providers/platform/awsSigV4.mjs";
import {
  DEFAULT_MAX_LENGTH_PER_SEARCH,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_RETRIES,
  runSearches,
  truncateText,
} from "./answer.mjs";

/**
 * Filters applied to every search by the `bedrock-agentcore` provider.
 *
 * @typedef {Object} WebSearchToolAgentCoreFilters
 * @property {{ include?: string[], exclude?: string[] }=} domainFilter
 * @property {{ publishedAfter?: string, publishedBefore?: string }=} publishedDateFilter
 */

/**
 * JSON-serializable configuration for the `bedrock-agentcore` provider.
 *
 * Calls the AgentCore `InvokeWebSearch` API once per keyword set; the
 * agent's main model is then used to extract the information relevant to
 * `question`.
 *
 * @typedef {Object} WebSearchToolAgentCoreJsonOptions
 * @property {"bedrock-agentcore"} provider
 * @property {string=} baseURL Data plane endpoint (default `https://bedrock-agentcore.<region>.amazonaws.com`).
 * @property {string=} region AWS region. Derived from `baseURL` when omitted.
 * @property {string} awsProfile AWS CLI profile used to sign requests.
 * @property {number=} maxResults Results per search, 1-25 (default 25).
 * @property {WebSearchToolAgentCoreFilters=} filters Filters applied to each search.
 * @property {number=} timeoutMs Per-request timeout in milliseconds (default 30000).
 * @property {number=} delayBetweenRequestsMs Delay between searches in milliseconds (default 1000).
 * @property {number=} maxLengthPerSearch Truncate each search's output to this many characters (default 50000).
 * @property {number=} maxTotalLength Truncate the combined output to this many characters (default 200000).
 */

/**
 * Runtime configuration for the `bedrock-agentcore` provider.
 *
 * Calls the AgentCore `InvokeWebSearch` API once per keyword set and distils
 * the combined results into an answer for `question`. `modelCaller` is
 * injected by the caller (e.g., `main.mjs`) using the agent's main model.
 *
 * @typedef {WebSearchToolAgentCoreJsonOptions & { modelCaller: CallModel }} WebSearchToolAgentCoreOptions
 */

/**
 * @typedef {Object} AgentCoreWebSearchResult
 * @property {string=} title
 * @property {string=} url
 * @property {string=} publishedAt
 * @property {string} text
 */

/** @type {string} */
const AGENTCORE_WEB_SEARCH_ID = "web-search.v1";

/** @type {number} */
const MAX_SEARCH_QUERY_LENGTH = 200;

/** @type {number} */
const DEFAULT_MAX_RESULTS = 25;

/**
 * @param {WebSearchToolAgentCoreOptions} config
 * @param {WebSearchInput} input
 * @returns {Promise<string | Error>}
 */
export async function webSearchViaAgentCore(config, input) {
  const endpoint = resolveAgentCoreEndpoint(config);
  /**
   * @param {string[]} keywords
   * @param {number} searchNumber
   */
  const searchOne = async (keywords, searchNumber) => {
    const result = await invokeAgentCoreWebSearch(
      config,
      endpoint,
      keywords,
      searchNumber,
      0,
    );
    if (result instanceof Error) {
      throw result;
    }
    const { text, truncated, originalLength } = truncateText(
      result.text,
      config.maxLengthPerSearch ?? DEFAULT_MAX_LENGTH_PER_SEARCH,
    );
    return {
      text,
      truncated,
      originalLength,
      sources: result.sources.filter((source) =>
        text.includes(`[${source.key}]`),
      ),
    };
  };
  return runSearches(config, input, searchOne, {
    failureLabel: "bedrock-agentcore",
    resultDescription:
      'Each search\'s results are wrapped in a <search keywords="..."> tag; entries include a title, URL, publication date, and a text extract when available.',
  });
}

/**
 * Resolve the AgentCore data plane endpoint and signing region.
 *
 * The region comes from `region` when set, otherwise it is derived from
 * `baseURL` (`https://bedrock-agentcore.<region>.amazonaws.com`).
 *
 * @param {{ baseURL?: string, region?: string }} config
 * @returns {{ baseURL: string, region: string }}
 */
export function resolveAgentCoreEndpoint(config) {
  const region =
    config.region ??
    config.baseURL?.match(
      /bedrock-agentcore\.([a-z0-9-]+)\.amazonaws\.com/,
    )?.[1];
  if (!region) {
    throw new Error(
      "The bedrock-agentcore provider requires `region` or a `baseURL` containing the region.",
    );
  }
  const baseURL = (
    config.baseURL ?? `https://bedrock-agentcore.${region}.amazonaws.com`
  ).replace(/\/+$/, "");
  return { baseURL, region };
}

/**
 * Build the API's `searchQuery` from a keyword set.
 *
 * The API accepts at most 200 characters; longer queries are truncated.
 *
 * @param {string[]} keywords
 * @returns {string}
 */
export function buildAgentCoreSearchQuery(keywords) {
  const query = keywords.join(" ");
  if (query.length <= MAX_SEARCH_QUERY_LENGTH) {
    return query;
  }
  console.error(
    styleText(
      "yellow",
      `Search query truncated to ${MAX_SEARCH_QUERY_LENGTH} characters.`,
    ),
  );
  return query.slice(0, MAX_SEARCH_QUERY_LENGTH);
}

/**
 * Format AgentCore results as entries numbered `<search>.<position>`, and
 * return the citable sources under the same keys. Both are produced here so
 * the keys in the text and the keys in `sources` cannot drift apart.
 *
 * @param {AgentCoreWebSearchResult[]} results
 * @param {number} searchNumber 1-based position of the search in the request.
 * @returns {{ text: string, sources: SearchSource[] }}
 */
export function formatAgentCoreSearchResults(results, searchNumber) {
  /** @type {SearchSource[]} */
  const sources = [];
  const text =
    results.length === 0
      ? "(no results)"
      : results
          .map((result, index) => {
            const key = `${searchNumber}.${index + 1}`;
            if (typeof result.url === "string" && result.url !== "") {
              sources.push({
                key,
                url: result.url,
                ...(result.title ? { title: result.title } : {}),
              });
            }
            const meta = [result.title, result.url, result.publishedAt]
              .filter((value) => typeof value === "string" && value.length > 0)
              .join(" - ");
            return meta === ""
              ? `[${key}]\n${result.text}`
              : `[${key}] ${meta}\n${result.text}`;
          })
          .join("\n\n");
  return { text, sources };
}

/**
 * Call `InvokeWebSearch` with SigV4 signing, retrying throttling and server errors.
 *
 * @param {WebSearchToolAgentCoreOptions} config
 * @param {{ baseURL: string, region: string }} endpoint
 * @param {string[]} keywords
 * @param {number} searchNumber 1-based position of the search in the request.
 * @param {number} retryCount
 * @returns {Promise<{ text: string, sources: SearchSource[] } | Error>}
 */
async function invokeAgentCoreWebSearch(
  config,
  endpoint,
  keywords,
  searchNumber,
  retryCount,
) {
  const url = new URL(
    `${endpoint.baseURL}/web-search/${AGENTCORE_WEB_SEARCH_ID}/invoke`,
  );
  const payload = JSON.stringify({
    searchQuery: buildAgentCoreSearchQuery(keywords),
    maxResults: config.maxResults ?? DEFAULT_MAX_RESULTS,
    ...(config.filters && { filters: config.filters }),
  });

  const credentials = await loadAwsCredentials(config.awsProfile);
  const signed = signAwsRequest(
    {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        host: url.hostname,
        "Content-Type": "application/json",
      },
      body: payload,
    },
    { region: endpoint.region, service: "bedrock-agentcore", credentials },
  );

  const response = await fetch(url, {
    method: signed.method,
    headers: signed.headers,
    body: signed.body,
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS),
  });

  if (response.status === 429 || response.status >= 500) {
    if (retryCount >= MAX_RETRIES) {
      return new Error(
        `Bedrock AgentCore web search failed after ${retryCount + 1} attempts: status=${response.status}, body=${await response.text()}`,
      );
    }
    const interval =
      (await readRetryAfterSeconds(response)) ??
      Math.min(2 * 2 ** retryCount, 16);
    console.error(
      styleText(
        "yellow",
        `Bedrock AgentCore returned ${response.status}. Retrying in ${interval} seconds...`,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    return invokeAgentCoreWebSearch(
      config,
      endpoint,
      keywords,
      searchNumber,
      retryCount + 1,
    );
  }

  if (!response.ok) {
    return new Error(
      `Bedrock AgentCore web search failed: status=${response.status}, body=${await response.text()}`,
    );
  }

  /** @type {{ results?: AgentCoreWebSearchResult[] }} */
  const body = await response.json();
  const results = body.results;
  if (!Array.isArray(results)) {
    return new Error(
      `Unexpected response from Bedrock AgentCore: ${JSON.stringify(body)}`,
    );
  }
  return formatAgentCoreSearchResults(results, searchNumber);
}

/**
 * @param {Response} response
 * @returns {Promise<number | undefined>}
 */
async function readRetryAfterSeconds(response) {
  try {
    const body = await response.json();
    const seconds = body?.retryAfterSeconds;
    return typeof seconds === "number" && seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}
