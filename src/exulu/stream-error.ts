/**
 * streamText's onError callback for chat/run turns.
 *
 * It must never throw. The AI SDK invokes it from inside the stream's error
 * path; a throw there is not caught by the route's try/catch and surfaces as
 * an unhandled rejection, which exits the Node process (observed 2026-09-11 on
 * a LiteLLM "Budget has been exceeded" reply, and earlier on Vertex connection
 * failures). The error itself still reaches the client: the UI message stream
 * emits an error part, mapped by the route's onError, and the turn is stored
 * as failed by the route.
 */
export function onChatStreamError({ error }: { error: unknown }): void {
  const detail =
    error instanceof Error ? error.message : error === undefined ? "unknown error" : safeStringify(error);
  console.error("[EXULU] chat stream error.", detail);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
