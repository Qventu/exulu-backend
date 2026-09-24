import { assertOwnsTranscriptionJob, TranscriptionJobAccessError } from "./authorize";

// Minimal knex-shaped fake: db.from(table).select([...]).where({id}).first()
const dbWith = (row: unknown) => {
  const first = jest.fn(async () => row);
  const db = { from: jest.fn(() => ({ select: () => ({ where: () => ({ first }) }) })) };
  return { db, first };
};

describe("assertOwnsTranscriptionJob", () => {
  it("rejects when there is no user (403) without touching the db", async () => {
    const { db } = dbWith(null);
    await expect(assertOwnsTranscriptionJob(db, null, "job-1")).rejects.toMatchObject({ code: 403 });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("lets a super admin through without reading the row", async () => {
    const { db } = dbWith(null);
    await expect(assertOwnsTranscriptionJob(db, { id: 9, super_admin: true }, "job-1")).resolves.toBeUndefined();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("404s when the row does not exist", async () => {
    const { db } = dbWith(undefined);
    await expect(assertOwnsTranscriptionJob(db, { id: 1 }, "missing")).rejects.toMatchObject({ code: 404 });
  });

  it("lets anyone act on a public row", async () => {
    const { db } = dbWith({ created_by: "2", rights_mode: "public" });
    await expect(assertOwnsTranscriptionJob(db, { id: 1 }, "job-1")).resolves.toBeUndefined();
  });

  it("compares created_by (text) against user.id (int) as strings", async () => {
    const { db } = dbWith({ created_by: "7", rights_mode: "private" });
    await expect(assertOwnsTranscriptionJob(db, { id: 7 }, "job-1")).resolves.toBeUndefined();
  });

  it("403s a stranger on a private row", async () => {
    const { db } = dbWith({ created_by: "7", rights_mode: "private" });
    const err = await assertOwnsTranscriptionJob(db, { id: 8 }, "job-1").catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptionJobAccessError);
    expect(err.code).toBe(403);
    expect(err.message).toBe("Not authorized to act on this transcription job");
  });
});
