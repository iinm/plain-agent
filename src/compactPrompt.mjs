/**
 * Build the compact context prompt message text.
 *
 * Shared between the interactive `/compact` command and the automatic
 * soft-limit prompt insertion in the agent loop.
 *
 * @param {string} [invocation] - The invocation string (e.g., "/compact reason").
 *   When omitted, a generic auto-compact preamble is used instead.
 * @returns {string}
 */
export function buildCompactPrompt(invocation) {
  const preamble = invocation
    ? `System: This prompt was invoked as "${invocation}".`
    : "System: Context is approaching the soft limit.";

  return [
    preamble,
    "",
    "Compact the conversation context:",
    "1. Update the memory file for the current task so it fully captures the task overview, progress, decisions, and next steps in a self-contained way.",
    '2. Then call the "compact_context" tool alone with that memory file path and a brief reason.',
  ].join("\n");
}
