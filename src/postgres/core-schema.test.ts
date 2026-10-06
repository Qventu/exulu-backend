import { addCoreFields, coreSchemas } from "./core-schema";

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

  it("transcription_jobs carries reviewed_at, so review is independent of publication", () => {
    const schema = coreSchemas.get().transcriptionJobsSchema();
    const names = schema.fields.map((f) => f.name);
    expect(names).toContain("reviewed_at");
    expect(names).toContain("saved_item_id");
  });
});

describe("memory_usages schema", () => {
  test("is registered with the usage columns and no RBAC", () => {
    const schema = coreSchemas.get().memoryUsagesSchema();
    expect(schema.name).toEqual({ plural: "memory_usages", singular: "memory_usage" });
    expect(schema.RBAC).toBeFalsy();
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]));
    expect(byName.memory_id).toMatchObject({ type: "uuid", required: true });
    expect(byName.context).toMatchObject({ type: "text", required: true });
    expect(byName.agent).toMatchObject({ type: "text", required: true });
    expect(byName.session).toMatchObject({ type: "text" });
    expect(byName.message_id).toMatchObject({ type: "text", required: true });
    expect(byName.user).toMatchObject({ type: "number" });
    expect(byName.guest).toMatchObject({ type: "boolean", default: false });
    // no RBAC → addCoreFields must not add rights_mode/created_by
    expect(byName.rights_mode).toBeUndefined();
    expect(byName.created_by).toBeUndefined();
  });
});

describe("addCoreFields", () => {
  test("created_by is nullable in the API: item tables store it as text and SDK-created rows have none", () => {
    const schema = addCoreFields({ name: { plural: "x_items", singular: "x_item" }, type: "items", RBAC: true, fields: [] } as any);
    const field = schema.fields.find((f) => f.name === "created_by");
    expect(field).toBeDefined();
    expect(field?.required).toBe(false);
  });
});

describe("memory conflict schemas", () => {
  test("memory_conflicts holds groups and decisions without RBAC", () => {
    const schema = coreSchemas.get().memoryConflictsSchema();
    expect(schema.name).toEqual({ plural: "memory_conflicts", singular: "memory_conflict" });
    expect(schema.RBAC).toBeFalsy();
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]));
    expect(byName.context).toMatchObject({ type: "text", required: true });
    expect(byName.kind).toMatchObject({ type: "text", required: true });
    expect(byName.key).toMatchObject({ type: "text", required: true, unique: true });
    expect(byName.members).toMatchObject({ type: "json", required: true });
    expect(byName.similarity).toMatchObject({ type: "number", required: true });
    expect(byName.reason).toMatchObject({ type: "text" });
    expect(byName.status).toMatchObject({ type: "text", required: true, default: "open" });
    expect(byName.resolution).toMatchObject({ type: "text" });
    expect(byName.resolved_by).toMatchObject({ type: "number" });
    expect(byName.resolved_at).toMatchObject({ type: "date" });
    expect(byName.merged_into).toMatchObject({ type: "uuid" });
    expect(byName.scanned_at).toMatchObject({ type: "date", required: true });
    expect(byName.created_by).toBeUndefined();
  });
  test("memory_judgements remembers judged pairs", () => {
    const schema = coreSchemas.get().memoryJudgementsSchema();
    expect(schema.name).toEqual({ plural: "memory_judgements", singular: "memory_judgement" });
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]));
    expect(byName.context).toMatchObject({ type: "text", required: true });
    expect(byName.key).toMatchObject({ type: "text", required: true, unique: true });
    expect(byName.verdict).toMatchObject({ type: "text", required: true });
    expect(byName.reason).toMatchObject({ type: "text" });
    expect(byName.judged_at).toMatchObject({ type: "date", required: true });
  });
  test("memory_conflict_scans keeps one dated row per base", () => {
    const schema = coreSchemas.get().memoryConflictScansSchema();
    expect(schema.name).toEqual({ plural: "memory_conflict_scans", singular: "memory_conflict_scan" });
    expect(schema.RBAC).toBeFalsy();
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]));
    expect(byName.context).toMatchObject({ type: "text", required: true, unique: true });
    expect(byName.scanned_at).toMatchObject({ type: "date", required: true });
    for (const field of ["open", "judged", "unjudged", "skipped"]) expect(byName[field]).toMatchObject({ type: "number" });
  });
});

describe("context_projections schema", () => {
  test("holds one fitted projection per context, without RBAC", () => {
    const schema = coreSchemas.get().contextProjectionsSchema();
    expect(schema.name).toEqual({ plural: "context_projections", singular: "context_projection" });
    expect(schema.RBAC).toBeFalsy();
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]));
    expect(byName.context).toMatchObject({ type: "text", required: true, unique: true });
    expect(byName.dims).toMatchObject({ type: "number", required: true });
    expect(byName.components).toMatchObject({ type: "number", required: true });
    expect(byName.mean).toMatchObject({ type: "json", required: true });
    expect(byName.basis).toMatchObject({ type: "json", required: true });
    expect(byName.map).toMatchObject({ type: "json", required: true });
    expect(byName.intercept).toMatchObject({ type: "json", required: true });
    expect(byName.method).toMatchObject({ type: "text", required: true });
    expect(byName.version).toMatchObject({ type: "number", required: true });
    expect(byName.sample_size).toMatchObject({ type: "number" });
    expect(byName.residual).toMatchObject({ type: "number" });
    expect(byName.fitted_at).toMatchObject({ type: "date", required: true });
    expect(byName.created_by).toBeUndefined();
  });
});

describe("context_map_topics", () => {
  it("is registered with the fields the map reads", () => {
    const schema = coreSchemas.get().contextMapTopicsSchema();
    expect(schema.type).toBe("context_map_topics");
    expect(schema.RBAC).toBeFalsy();
    const names = schema.fields.map((f) => f.name);
    for (const field of ["context", "topic_index", "label", "count", "x", "y", "z", "version", "fitted_at"]) {
      expect(names).toContain(field);
    }
    // Many rows per context: a unique context would make a refit fail on the
    // second cluster instead of replacing the set.
    expect(schema.fields.find((f) => f.name === "context")?.unique).toBeFalsy();
    expect(schema.fields.find((f) => f.name === "context")?.index).toBe(true);
  });
});
