import { verifySharePassword } from "./shared-artifacts";

export type GuestAuthMode = "public" | "password" | "regular";

export interface PublicAgentView {
  id: string;
  name: string;
  description: string;
  image: string | null;
  welcomemessage: string;
  slug: string;
  guest_auth_mode: GuestAuthMode;
  guest_has_cover: boolean;
}

/**
 * The ONLY projection public endpoints may return. Never widen without
 * updating the spec's security section (no instructions/tools/model leak).
 */
export const publicAgentView = (
  row: {
    id: string;
    name?: string | null;
    description?: string | null;
    image?: string | null;
    welcomemessage?: string | null;
    guest_auth_mode?: string | null;
    guest_cover_image?: string | null;
  },
  slug: string,
): PublicAgentView => ({
  id: row.id,
  name: row.name ?? "",
  description: row.description ?? "",
  image: row.image ?? null,
  welcomemessage: row.welcomemessage ?? "",
  slug,
  guest_auth_mode: (row.guest_auth_mode as GuestAuthMode) || "regular",
  guest_has_cover: !!row.guest_cover_image,
});

export type GuestGate =
  | { allowed: true; via: "rbac-public" | "guest" }
  | { allowed: false; status: number; message: string };

/**
 * Single decision for the agent run route (spec §3.4). Run-only: a `true`
 * here must never be used to authorize GraphQL reads/writes.
 * - anonymous: rights_mode=public (legacy) OR guest public OR guest password
 *   with a verifying `x-guest-password`.
 * - authenticated: any user may run a guest-enabled agent regardless of the
 *   agent's internal RBAC. When it returns allowed:false for an authenticated
 *   user the caller falls back to the normal checkRecordAccess path.
 */
export const evaluateGuestChatAccess = async (
  agent: {
    rights_mode?: string | null;
    guest_access?: boolean | null;
    guest_auth_mode?: string | null;
    guest_password_hash?: string | null;
  },
  userId: string | number | undefined,
  guestPassword: string | undefined,
): Promise<GuestGate> => {
  // When the admin explicitly published the agent (guest_access), the guest
  // mode GOVERNS anonymous access — even for internally-public agents.
  // Otherwise a guest password/login gate would be silently bypassed by the
  // legacy rights_mode=public anonymous path below.
  if (agent.guest_access) {
    if (userId != null) return { allowed: true, via: "guest" };
    const mode = (agent.guest_auth_mode as GuestAuthMode) || "regular";
    if (mode === "public") return { allowed: true, via: "guest" };
    if (mode === "password") {
      if (agent.guest_password_hash && guestPassword) {
        const ok = await verifySharePassword(guestPassword, agent.guest_password_hash);
        if (ok) return { allowed: true, via: "guest" };
        return { allowed: false, status: 401, message: "Incorrect password." };
      }
      return { allowed: false, status: 401, message: "Password required." };
    }
    return { allowed: false, status: 401, message: "Authentication required." };
  }
  // Legacy: internally-public agents stay anonymously reachable when the
  // agent is NOT guest-published (pre-existing rights_mode=public behavior).
  if (userId == null && agent.rights_mode === "public") {
    return { allowed: true, via: "rbac-public" };
  }
  return { allowed: false, status: 401, message: "Authentication required." };
};
