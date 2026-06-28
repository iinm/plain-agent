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
      "The context is growing large. Wrap up your current work:",
      "1. Summarize your progress and findings so far in the memory file.",
      '2. Call "switch_to_main_agent" to hand back control, so the main agent can compact the context.',
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
