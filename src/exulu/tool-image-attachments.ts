import type { PrepareStepFn } from "./context-guard";

export const INJECTED_IMAGE_PREFIX = "[Image attached from tool call ";

type StashedImage = { data: string; mediaType: string; label: string; stashedAt: number };

/**
 * In-process channel that carries rendered images from view_document_page's
 * execute (which can only return JSON — the openai-compatible transport
 * stringifies rich tool-result content) into the model's context: the guard
 * below injects each stashed image as a user-message image part right after
 * its tool-result message. Bounded because entries outlive the request that
 * created them; images are intentionally never persisted to chat history.
 */
const stash = new Map<string, StashedImage>();
const MAX_ENTRIES = 100;
const TTL_MS = 30 * 60 * 1000;
const MAX_TOTAL_BYTES = 100_000_000;
const STASH_TOOL_NAME = "view_document_page";

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, entry] of stash) {
    if (entry.stashedAt < cutoff) stash.delete(id);
  }
  while (stash.size > MAX_ENTRIES) {
    const oldest = stash.keys().next().value;
    if (oldest === undefined) break;
    stash.delete(oldest);
  }
  let totalBytes = 0;
  for (const entry of stash.values()) totalBytes += entry.data.length;
  while (totalBytes > MAX_TOTAL_BYTES) {
    const oldest = stash.keys().next().value;
    if (oldest === undefined) break;
    totalBytes -= stash.get(oldest)!.data.length;
    stash.delete(oldest);
  }
}

export function stashToolImage(
  toolCallId: string,
  image: { data: string; mediaType: string; label: string },
): void {
  stash.set(toolCallId, { ...image, stashedAt: Date.now() });
  sweep();
}

export function clearImageStash(): void {
  stash.clear();
}

type MessageLike = { role?: string; content?: unknown };
type ToolResultPartLike = { type?: string; toolCallId?: string; toolName?: string };

function stashedIdsInMessage(message: MessageLike): string[] {
  if (message?.role !== "tool" || !Array.isArray(message.content)) return [];
  return (message.content as ToolResultPartLike[])
    .filter(
      (p) =>
        p?.type === "tool-result" &&
        typeof p.toolCallId === "string" &&
        p.toolName === STASH_TOOL_NAME &&
        stash.has(p.toolCallId),
    )
    .map((p) => p.toolCallId as string);
}

function injectedTextFor(id: string, label: string): string {
  return `${INJECTED_IMAGE_PREFIX}${id}: ${label}]`;
}

function firstTextPart(message: MessageLike | undefined): string | undefined {
  if (message?.role !== "user" || !Array.isArray(message.content)) return undefined;
  const first = (message.content as Array<{ type?: string; text?: string }>)[0];
  return first?.type === "text" ? first.text : undefined;
}

/**
 * prepareStep guard: after any tool message whose tool-result toolCallId has a
 * stashed image, insert a user message carrying that image. Idempotent —
 * prepareStep rebuilds messages from response history each step, so the guard
 * re-runs every step and skips positions already followed by an injection.
 */
export function imageAttachmentGuard(): PrepareStepFn {
  return ({ messages }) => {
    sweep(); // purge expired / oversized entries on every read, not just on writes
    if (!Array.isArray(messages) || messages.length === 0 || stash.size === 0) return undefined;
    let changed = false;
    const next: unknown[] = [];
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i] as MessageLike;
      next.push(message);
      const ids = stashedIdsInMessage(message);
      if (ids.length === 0) continue;
      // Collect the injected block already following this tool message so
      // idempotency is judged per toolCallId, not per position — a tool
      // message can carry several tool-result parts.
      // Deliberately scans the ORIGINAL `messages` array: new injections land
      // in `next`; only pre-existing injected blocks matter for idempotency.
      const alreadyInjected: string[] = [];
      for (let j = i + 1; j < messages.length; j++) {
        const text = firstTextPart(messages[j] as MessageLike);
        if (text === undefined || !text.startsWith(INJECTED_IMAGE_PREFIX)) break;
        alreadyInjected.push(text);
      }
      for (const id of ids) {
        if (alreadyInjected.some((text) => text.startsWith(`${INJECTED_IMAGE_PREFIX}${id}:`))) continue;
        const image = stash.get(id)!;
        changed = true;
        next.push({
          role: "user",
          content: [
            { type: "text", text: injectedTextFor(id, image.label) },
            { type: "image", image: image.data, mediaType: image.mediaType },
          ],
        });
      }
    }
    return changed ? { messages: next as never } : undefined;
  };
}
