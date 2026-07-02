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
