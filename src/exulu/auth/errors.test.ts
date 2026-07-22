import { CredentialInvalidError } from "./errors";

describe("CredentialInvalidError", () => {
    it("carries provider and reason", () => {
        const e = new CredentialInvalidError("moco", "401 from Moco");
        expect(e).toBeInstanceOf(Error);
        expect(e.provider).toBe("moco");
        expect(e.reason).toBe("401 from Moco");
        expect(e.name).toBe("CredentialInvalidError");
    });

    it("is discoverable via instanceof across async boundaries", async () => {
        const thrown = await Promise.resolve().then(() => { throw new CredentialInvalidError("p"); }).catch(e => e);
        expect(thrown instanceof CredentialInvalidError).toBe(true);
    });
});
