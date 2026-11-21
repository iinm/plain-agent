/**
 * @typedef {Object} WebSearch
 * @property {string[]} keywords
 */

/**
 * @typedef {Object} WebSearchInput
 * @property {WebSearch[]} searches
 * @property {string} question
 */

/**
 * A URL that appeared in the search results, with the number used to cite it.
 * `key` is `<search number>.<position in that search>`, e.g. `1.2`.
 *
 * @typedef {Object} SearchSource
 * @property {string} key
 * @property {string} url
 * @property {string=} title
 */

export {};
