import { canAccessSkill } from "./skill-access";

const fakeDb = () => {
  const fn: any = () => fn;
  fn.from = () => fn;
  fn.where = () => fn;
  fn.select = async () => []; // no rbac rows
  return fn;
};

describe("canAccessSkill", () => {
  it("allows the creator to read a private skill", async () => {
    const db = fakeDb();
    const skill = { id: "s1", rights_mode: "private", created_by: 42 };
    const user = { id: 42, type: "user" } as any;
    expect(await canAccessSkill(db, skill, "read", user)).toBe(true);
  });
  it("denies a non-creator reading a private skill", async () => {
    const db = fakeDb();
    const skill = { id: "s2", rights_mode: "private", created_by: 42 };
    const user = { id: 7, type: "user" } as any;
    expect(await canAccessSkill(db, skill, "read", user)).toBe(false);
  });
  it("allows anyone to read a public skill", async () => {
    const db = fakeDb();
    const skill = { id: "s3", rights_mode: "public", created_by: 42 };
    const user = { id: 7, type: "user" } as any;
    expect(await canAccessSkill(db, skill, "read", user)).toBe(true);
  });
});
