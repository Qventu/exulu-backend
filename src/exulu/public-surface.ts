/**
 * The public agent surface (`/public/agents/...`) is a GUEST surface.
 *
 * Signed-in people can reach it too — `evaluateGuestChatAccess` lets any
 * authenticated user through a guest-published agent — and the page renders
 * in guest mode either way: no ＋ menu, no prompts, no knowledge picker. Until
 * this header existed, the backend disagreed with that: it keyed guest
 * behaviour off `!user?.id`, so a signed-in visitor got user treatment behind
 * a guest-looking page. Recalled memories appeared although the agent's
 * `guests.showRecalled` was off, and recall ran against that person's PRIVATE
 * memories on a public link.
 *
 * The Next proxy (`app/public/agents/[id]/chat/route.ts`) sets this header on
 * every request it forwards. It is server-side and the public page is its only
 * caller, so the header cannot be attached by accident from elsewhere.
 *
 * It can only ever REMOVE privileges — the backend reads it as "also treat this
 * as a guest", never as "grant access". A forged header therefore buys a caller
 * nothing: the worst it can do is give itself the guest experience.
 */
export const PUBLIC_SURFACE_HEADER = "x-public-surface";

export function isPublicSurface(req: { headers?: Record<string, unknown> } | undefined): boolean {
  const raw = req?.headers?.[PUBLIC_SURFACE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "1" || value === "true";
}

/**
 * Whether this request gets guest treatment: either there is nobody signed in,
 * or the request came through the public surface. One place, because the rule
 * was previously spelled `!user?.id` at each decision and the public surface
 * was missing from all of them.
 */
export function treatAsGuest(
  req: { headers?: Record<string, unknown> } | undefined,
  user: { id?: unknown } | null | undefined,
): boolean {
  return isPublicSurface(req) || !user?.id;
}
