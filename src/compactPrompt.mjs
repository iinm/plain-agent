/**
 * Build the compact context prompt message text.
 *
 * Shared between the interactive `/compact` command and the automatic
 * soft-limit prompt insertion in the agent loop.
 *
 * @param {object} [options]
 * @param {string} [options.invocation] - The invocation string (e.g., "/compact reason").
 *   When omitted, a generic auto-compact preamble is used instead.
 * @param {boolean} [options.isSubagent] - When true, instructs the model to
 *   return to the main agent via `switch_to_main_agent` before compacting.
 * @returns {string}
 */
export function buildCompactPrompt(options) {
  const { invocation, isSubagent } = options ?? {};

  const preamble = invocation
    ? `System: This prompt was invoked as "${invocation}".`
    : "System: Context is approaching the soft limit.";

  if (isSubagent) {
    return [
      preamble,
      "",
      "You are currently running as a subagent. To compact the context:",
      '1. Call "switch_to_main_agent" to return to the main agent first, writing your current progress to the memory file.',
      "2. Once back as the main agent, the context will be compacted automatically.",
    ].join("\n");
  }

  return [
    preamble,
    "",
    "Compact the conversation context:",
    "1. Update the memory file for the current task so it fully captures the task overview, progress, decisions, and next steps in a self-contained way.",
    '2. Then call the "compact_context" tool alone with that memory file path and a brief reason.',
  ].join("\n");
}
