import { hasAgentsReadAccess, hasAgentsWriteAccess } from "./access-control";

describe("hasAgentsReadAccess", () => {
  it("allows super admins regardless of role", () => {
    expect(hasAgentsReadAccess({ super_admin: true } as any)).toBe(true);
  });

  it("allows a role with read or write rights on agents", () => {
    expect(hasAgentsReadAccess({ role: { agents: "read" } } as any)).toBe(true);
    expect(hasAgentsReadAccess({ role: { agents: "write" } } as any)).toBe(true);
  });

  it("refuses a signed-in user without agents rights, guests, and no user at all", () => {
    expect(hasAgentsReadAccess({ role: { agents: "none" } } as any)).toBe(false);
    expect(hasAgentsReadAccess({ role: {} } as any)).toBe(false);
    expect(hasAgentsReadAccess({} as any)).toBe(false);
    expect(hasAgentsReadAccess(undefined)).toBe(false);
  });
});

describe("hasAgentsWriteAccess", () => {
  it("is true for super admins and agents:write only", () => {
    expect(hasAgentsWriteAccess({ super_admin: true } as any)).toBe(true);
    expect(hasAgentsWriteAccess({ role: { agents: "write" } } as any)).toBe(true);
    expect(hasAgentsWriteAccess({ role: { agents: "read" } } as any)).toBe(false);
    expect(hasAgentsWriteAccess(undefined)).toBe(false);
  });
});
