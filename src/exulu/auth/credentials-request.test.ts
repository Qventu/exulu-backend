import { buildCredentialRequest, verifyCredentialNonce } from "./credentials-request";

beforeAll(() => {
    process.env.NEXTAUTH_SECRET = "test-secret";
});

describe("credentialRequest", () => {
    const cfg = { authType: "user_credentials" as const, provider: "moco", fields: [
        { name: "subdomain", label: "Subdomain", type: "text" as const },
        { name: "apiKey", label: "API key", type: "password" as const },
    ] };

    it("returns fields and a submit URL", () => {
        const req = buildCredentialRequest(cfg, { baseUrl: "https://app.example", userId: "u1" });
        expect(req.provider).toBe("moco");
        expect(req.fields.map(f => f.name)).toEqual(["subdomain", "apiKey"]);
        expect(req.submitUrl).toBe("https://app.example/credentials/submit");
        expect(req.nonce).toEqual(expect.any(String));
        expect(req.nonce.length).toBeGreaterThan(20);
    });

    it("nonce round-trips to (provider, userId)", () => {
        const req = buildCredentialRequest(cfg, { baseUrl: "https://app.example", userId: "u1" });
        const decoded = verifyCredentialNonce(req.nonce);
        expect(decoded).toEqual({ provider: "moco", userId: "u1", expiresAt: expect.any(Number) });
    });

    it("nonce rejects tampering", () => {
        const req = buildCredentialRequest(cfg, { baseUrl: "https://app.example", userId: "u1" });
        expect(() => verifyCredentialNonce(req.nonce.slice(0, -3) + "AAA")).toThrow();
    });

    it("nonce rejects expired", () => {
        const req = buildCredentialRequest(cfg, { baseUrl: "https://app.example", userId: "u1", ttlSeconds: -1 });
        expect(() => verifyCredentialNonce(req.nonce)).toThrow(/expired/i);
    });
});
