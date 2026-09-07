/**
 * Guards for the persisted chat history.
 *
 * A streamed turn that fails before producing anything still reaches `onFinish` with an
 * assistant message whose `parts` is `[]`. Once such a shell is stored, every later
 * request loads it and `validateUIMessages` rejects the whole session
 * ("Message must contain at least one part"), so the chat is dead until the row is
 * removed. Drop such messages both before saving and before validating.
 */
export function dropEmptyMessages<T extends { parts?: unknown }>(messages: T[]): T[] {
  const kept = messages.filter((m) => Array.isArray(m.parts) && m.parts.length > 0);
  return kept.length === messages.length ? messages : kept;
}
