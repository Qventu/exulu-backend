import { hashSharePassword } from "./shared-artifacts";
import { evaluateGuestChatAccess, publicAgentView } from "./public-agents";

describe("publicAgentView", () => {
  test("projects ONLY the whitelisted fields", () => {
    const row = {
      id: "a1",
      name: "Support Bot",
      description: "Helps",
      image: "s3/avatar.png",
      welcomemessage: "Hi!",
      instructions: "SECRET SYSTEM PROMPT",
      model: "gpt-x",
      guest_access: true,
      guest_auth_mode: "password",
      guest_password_hash: "$2a$10$secret",
      guest_cover_image: "s3/cover.jpg",
    } as any;
    const view = publicAgentView(row, "/agents/litellm/run");
    expect(view).toEqual({
      id: "a1",
      name: "Support Bot",
      description: "Helps",
      image: "s3/avatar.png",
      welcomemessage: "Hi!",
      slug: "/agents/litellm/run",
      guest_auth_mode: "password",
      guest_has_cover: true,
    });
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expect(JSON.stringify(view)).not.toContain("$2a$");
  });

  test("null-safe defaults", () => {
    const view = publicAgentView({ id: "a2" } as any, "");
    expect(view).toEqual({
      id: "a2",
      name: "",
      description: "",
      image: null,
      welcomemessage: "",
      slug: "",
      guest_auth_mode: "regular",
      guest_has_cover: false,
    });
  });
});

describe("evaluateGuestChatAccess — anonymous (no userId)", () => {
  test("rights_mode=public stays allowed (legacy behavior)", async () => {
    const gate = await evaluateGuestChatAccess(
      { rights_mode: "public" } as any,
      undefined,
      undefined,
    );
    expect(gate).toEqual({ allowed: true, via: "rbac-public" });
  });

  test("guest_access off → 401", async () => {
    const gate = await evaluateGuestChatAccess(
      { rights_mode: "private", guest_access: false } as any,
      undefined,
      undefined,
    );
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.status).toBe(401);
  });

  test("guest public mode → allowed", async () => {
    const gate = await evaluateGuestChatAccess(
      { rights_mode: "private", guest_access: true, guest_auth_mode: "public" } as any,
      undefined,
      undefined,
    );
    expect(gate).toEqual({ allowed: true, via: "guest" });
  });

  test("guest password mode: correct password allowed, wrong/missing rejected", async () => {
    const hash = await hashSharePassword("hunter2");
    const agent = {
      rights_mode: "private",
      guest_access: true,
      guest_auth_mode: "password",
      guest_password_hash: hash,
    } as any;
    expect(await evaluateGuestChatAccess(agent, undefined, "hunter2")).toEqual({
      allowed: true,
      via: "guest",
    });
    const wrong = await evaluateGuestChatAccess(agent, undefined, "nope");
    expect(wrong.allowed).toBe(false);
    const missing = await evaluateGuestChatAccess(agent, undefined, undefined);
    expect(missing.allowed).toBe(false);
  });

  test("guest regular (login) mode rejects anonymous", async () => {
    const gate = await evaluateGuestChatAccess(
      { rights_mode: "private", guest_access: true, guest_auth_mode: "regular" } as any,
      undefined,
      undefined,
    );
    expect(gate.allowed).toBe(false);
  });
});

describe("evaluateGuestChatAccess — authenticated (userId present)", () => {
  test("any authenticated user allowed when guest_access on (any mode)", async () => {
    for (const mode of ["public", "password", "regular"]) {
      const gate = await evaluateGuestChatAccess(
        { rights_mode: "private", guest_access: true, guest_auth_mode: mode } as any,
        "user-1",
        undefined,
      );
      expect(gate).toEqual({ allowed: true, via: "guest" });
    }
  });

  test("authenticated + guest_access off → not allowed via guest (falls back to RBAC)", async () => {
    const gate = await evaluateGuestChatAccess(
      { rights_mode: "private", guest_access: false } as any,
      "user-1",
      undefined,
    );
    expect(gate.allowed).toBe(false);
  });

  test("authenticated + rights_mode=public + guest_access off → falls back to RBAC (not allowed here)", async () => {
    const gate = await evaluateGuestChatAccess(
      { rights_mode: "public", guest_access: false } as any,
      "user-1",
      undefined,
    );
    expect(gate).toEqual({ allowed: false, status: 401, message: "Authentication required." });
  });
});

describe("evaluateGuestChatAccess — anonymous password-mode edge case", () => {
  test("password mode with no stored hash rejects even when a password is sent", async () => {
    const gate = await evaluateGuestChatAccess(
      {
        rights_mode: "private",
        guest_access: true,
        guest_auth_mode: "password",
        guest_password_hash: null,
      } as any,
      undefined,
      "hunter2",
    );
    expect(gate).toEqual({ allowed: false, status: 401, message: "Password required." });
  });
});
