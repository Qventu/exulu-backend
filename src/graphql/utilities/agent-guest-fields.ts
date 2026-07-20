import { hashSharePassword } from "../../exulu/shared-artifacts";

/**
 * Normalizes guest fields on an agent mutation input (spec §3.2):
 * - `guest_password` (plaintext, input-only) → bcrypt `guest_password_hash`
 * - client-supplied `guest_password_hash` is discarded (defense in depth;
 *   the field is not in the GraphQL input type, but the generic mutation
 *   spreads input into the UPDATE, so strip it here too)
 * - setting `guest_auth_mode` to anything but "password" clears the hash
 * Mutates and returns the same object, matching the generic mutation style.
 */
export const applyAgentGuestFieldTransforms = async (
  input: Record<string, any>,
): Promise<Record<string, any>> => {
  delete input.guest_password_hash;
  if (typeof input.guest_password === "string" && input.guest_password.length > 0) {
    input.guest_password_hash = await hashSharePassword(input.guest_password);
  }
  delete input.guest_password;
  // Mode takes precedence over password: if the caller sends both a
  // guest_password AND a non-password guest_auth_mode, the freshly-hashed
  // value computed above is intentionally overwritten to null here — the
  // mode wins and no hash is stored.
  if (
    input.guest_auth_mode !== undefined &&
    input.guest_auth_mode !== "password"
  ) {
    input.guest_password_hash = null;
  }
  return input;
};
