import { userCredentialsSchema } from "./core-schema";

describe("userCredentialsSchema", () => {
    const sql = userCredentialsSchema();
    it("names the table user_credentials", () => {
        expect(sql).toMatch(/CREATE TABLE\s+(IF NOT EXISTS\s+)?user_credentials/i);
    });
    it("has auth_type column with check constraint", () => {
        expect(sql).toMatch(/auth_type\s+text[^,]+CHECK\s*\(\s*auth_type\s+IN\s*\(\s*'oauth'\s*,\s*'user_credentials'\s*\)\s*\)/i);
    });
    it("has jsonb data column", () => {
        expect(sql).toMatch(/data\s+jsonb\s+NOT NULL/i);
    });
    it("has unique index on (provider, user_id)", () => {
        expect(sql).toMatch(/UNIQUE.*\(\s*provider\s*,\s*user_id\s*\)/i);
    });
});
