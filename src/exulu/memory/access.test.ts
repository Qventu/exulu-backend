import { canEditMemory } from "./access";

const context: any = { id: "mem", name: "Memory", fields: [] };
const dbWith = (grants: any[]) => jest.fn(() => ({ where: () => ({ select: async () => grants }) }));
const row: any = { id: "m1", created_by: 9, rights_mode: "public" };

describe("canEditMemory", () => {
  it("allows the creator and super admins without touching rbac", async () => {
    const db = dbWith([]);
    expect(await canEditMemory(context, row, { id: 9 } as any, db)).toBe(true);
    expect(await canEditMemory(context, row, { id: 1, super_admin: true } as any, db)).toBe(true);
    expect(db).not.toHaveBeenCalled();
  });
  it("denies everyone else on public and private items unless a write grant matches them", async () => {
    expect(await canEditMemory(context, row, { id: 4 } as any, dbWith([]))).toBe(false);
    expect(await canEditMemory(context, { ...row, rights_mode: "private" }, { id: 4 } as any, dbWith([]))).toBe(false);
    expect(await canEditMemory(context, row, { id: 4 } as any, dbWith([{ access_type: "User", user_id: 4 }]))).toBe(true);
    expect(await canEditMemory(context, row, { id: 4, role: { id: "r1" } } as any, dbWith([{ access_type: "Role", role_id: "r1" }]))).toBe(true);
    expect(await canEditMemory(context, row, { id: 4, team: { id: "t1" } } as any, dbWith([{ access_type: "Team", team_id: "t9" }]))).toBe(false);
    expect(await canEditMemory(context, row, undefined, dbWith([]))).toBe(false);
  });
});
