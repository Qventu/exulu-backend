import { coreSchemas } from "./core-schema";

describe("shared_artifacts schema", () => {
  test("is registered with the expected shape", () => {
    const schema = coreSchemas.get().sharedArtifactsSchema();
    expect(schema.name.plural).toBe("shared_artifacts");
    expect(schema.name.singular).toBe("shared_artifact");
    const fieldNames = schema.fields.map((f) => f.name);
    expect(fieldNames).toEqual(
      expect.arrayContaining([
        "name",
        "s3key",
        "auth_mode",
        "password_hash",
        "expires_at",
        "content_type",
        "rights_mode", // added by addCoreFields because RBAC: true
        "created_by",
      ]),
    );
    const nameField = schema.fields.find((f) => f.name === "name");
    expect(nameField?.unique).toBe(true);
  });
});

describe("transcription_jobs schema (live recording columns)", () => {
  test("declares chunk_count (default 0) and last_chunk_at", () => {
    const schema = coreSchemas.get().transcriptionJobsSchema();
    const chunkCount = schema.fields.find((f) => f.name === "chunk_count");
    const lastChunkAt = schema.fields.find((f) => f.name === "last_chunk_at");
    expect(chunkCount).toMatchObject({ type: "number", default: 0 });
    expect(lastChunkAt).toMatchObject({ type: "date" });
  });
});
