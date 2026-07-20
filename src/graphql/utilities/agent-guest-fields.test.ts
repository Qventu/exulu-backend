import { verifySharePassword } from "../../exulu/shared-artifacts";
import { applyAgentGuestFieldTransforms } from "./agent-guest-fields";

describe("applyAgentGuestFieldTransforms", () => {
  test("hashes guest_password into guest_password_hash and strips the plaintext", async () => {
    const out = await applyAgentGuestFieldTransforms({
      name: "x",
      guest_password: "hunter2",
      guest_auth_mode: "password",
    });
    expect(out.guest_password).toBeUndefined();
    expect(typeof out.guest_password_hash).toBe("string");
    expect(await verifySharePassword("hunter2", out.guest_password_hash)).toBe(true);
  });

  test("empty guest_password is stripped without touching the stored hash", async () => {
    const out = await applyAgentGuestFieldTransforms({ guest_password: "" });
    expect(out.guest_password).toBeUndefined();
    expect(out.guest_password_hash).toBeUndefined();
  });

  test("switching guest_auth_mode away from password clears the hash", async () => {
    const out = await applyAgentGuestFieldTransforms({ guest_auth_mode: "public" });
    expect(out.guest_password_hash).toBeNull();
    const out2 = await applyAgentGuestFieldTransforms({ guest_auth_mode: "regular" });
    expect(out2.guest_password_hash).toBeNull();
  });

  test("a client-supplied guest_password_hash is always discarded", async () => {
    const out = await applyAgentGuestFieldTransforms({
      guest_password_hash: "$2a$10$attacker",
      guest_auth_mode: "password",
      guest_password: "real",
    });
    expect(await verifySharePassword("real", out.guest_password_hash)).toBe(true);
  });

  test("unrelated input passes through untouched", async () => {
    const out = await applyAgentGuestFieldTransforms({ name: "y", active: true });
    expect(out).toEqual({ name: "y", active: true });
  });
});
