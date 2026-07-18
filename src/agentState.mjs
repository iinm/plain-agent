/**
 * @import { Message } from "./model"
 */

/**
 * @typedef {ReturnType<typeof createStateManager>} StateManager
 */

/**
 * Opaque checkpoint marker. Callers must treat it as a black box: obtain one
 * from markCheckpoint() and pass it back to truncateToMarker() or
 * serializeMarker(). The internal representation (a numeric message index) is
 * intentionally hidden so that no other module depends on message-array
 * positions.
 * @typedef {object} Marker
 * @property {never} [__checkpoint] Phantom brand; never present at runtime.
 */

/**
 * A change to the message history.
 *   - "append": `messages` holds only the newly appended messages.
 *   - "replace": `messages` holds the full new message history.
 * @typedef {Object} MessagesChange
 * @property {"append" | "replace"} kind
 * @property {Message[]} messages
 */

/**
 * @typedef {Object} StateEventHandlers
 * @property {(change: MessagesChange) => void} onMessagesChanged
 */

/**
 * Creates a state manager for message handling.
 *
 * The state manager is the single owner of the message array. All structural
 * transformations (append, replace, truncate) happen here and every one of
 * them fires onMessagesChanged, so persistence and UI updates are symmetric.
 * Positions within the array are never exposed; callers refer to points in the
 * history through opaque {@link Marker}s.
 *
 * @param {Message[]} initialMessages
 * @param {StateEventHandlers} handlers
 */
export function createStateManager(initialMessages, handlers) {
  /** @type {Message[]} */
  let messages = [...initialMessages];

  /**
   * Registry of live checkpoints: marker object -> message index it points at.
   * Kept as a strong Map (not a WeakMap) so markers can be pruned/invalidated
   * when the array is replaced or truncated.
   * @type {Map<Marker, number>}
   */
  const checkpoints = new Map();

  /**
   * Register a new checkpoint pointing at the given message index.
   * @param {number} index
   * @returns {Marker}
   */
  function registerCheckpoint(index) {
    const marker = /** @type {Marker} */ (Object.freeze({}));
    checkpoints.set(marker, index);
    return marker;
  }

  return {
    /** Get all messages (immutable copy) */
    getMessages: () => [...messages],

    /** Get message at specific index (supports -1 for last) */
    getMessageAt: /** @param {number} index */ (index) => messages.at(index),

    /** Append messages */
    appendMessages: /** @param {Message[]} newMessages */ (newMessages) => {
      messages = [...messages, ...newMessages];
      handlers.onMessagesChanged({ kind: "append", messages: newMessages });
    },

    /** Replace all messages. Invalidates every outstanding checkpoint. */
    setMessages: /** @param {Message[]} newMessages */ (newMessages) => {
      messages = [...newMessages];
      checkpoints.clear();
      handlers.onMessagesChanged({ kind: "replace", messages: [...messages] });
    },

    /**
     * Mark the current last message and return an opaque marker for it.
     * truncateToMarker(marker) later removes that message and everything after
     * it. Marking an empty history yields a marker at position 0.
     * @returns {Marker}
     */
    markCheckpoint: () => registerCheckpoint(Math.max(0, messages.length - 1)),

    /**
     * Truncate the history back to a marker, removing the marked message and
     * everything after it, then fire a "replace" notification. Checkpoints at
     * or beyond the truncation point (including the given marker) are dropped.
     * @param {Marker} marker
     * @throws {Error} if the marker is unknown (already consumed or invalidated)
     */
    truncateToMarker: /** @param {Marker} marker */ (marker) => {
      const index = checkpoints.get(marker);
      if (index === undefined) {
        throw new Error(
          "truncateToMarker: unknown or already-invalidated marker",
        );
      }
      messages = messages.slice(0, index);
      for (const [m, i] of checkpoints) {
        if (i >= index) {
          checkpoints.delete(m);
        }
      }
      handlers.onMessagesChanged({ kind: "replace", messages: [...messages] });
    },

    /**
     * Resolve a marker to a serializable value (its message index) for
     * persistence. Does not consume the marker.
     * @param {Marker} marker
     * @returns {number}
     * @throws {Error} if the marker is unknown
     */
    serializeMarker: /** @param {Marker} marker */ (marker) => {
      const index = checkpoints.get(marker);
      if (index === undefined) {
        throw new Error(
          "serializeMarker: unknown or already-invalidated marker",
        );
      }
      return index;
    },

    /**
     * Recreate a marker from a previously serialized value. Used when restoring
     * persisted state; the index is clamped to the current history length.
     * @param {number} index
     * @returns {Marker}
     */
    reviveMarker: /** @param {number} index */ (index) =>
      registerCheckpoint(Math.max(0, Math.min(index, messages.length))),
  };
}
