/**
 * The one error a context without an embedder produces.
 *
 * Before this, the same misconfiguration failed three different ways: a raw
 * throw from vectorSearch, a silent empty result from the agentic pipeline,
 * and an unhandled tool error from the session-items tool. A permanent
 * misconfiguration that nobody is told about is the worst of those.
 */
export const embedderNotConfiguredMessage = (contextId: string): string =>
  `The knowledge base "${contextId}" has no embedding model configured, so it cannot be ` +
  `searched. An admin can configure one in its pipeline settings.`;

export class ContextEmbedderNotConfiguredError extends Error {
  public readonly contextId: string;
  constructor(contextId: string) {
    super(embedderNotConfiguredMessage(contextId));
    this.name = "ContextEmbedderNotConfiguredError";
    this.contextId = contextId;
  }
}

/** Structural check — survives module duplication and async boundaries. */
export const isEmbedderNotConfigured = (
  err: unknown,
): err is ContextEmbedderNotConfiguredError =>
  !!err && (err as Error).name === "ContextEmbedderNotConfiguredError";
