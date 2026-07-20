import { encrypt, decrypt } from "./credential-store";
import type { ExuluUserCredentialsConfig, CredentialField } from "./types";

const DEFAULT_TTL_SECONDS = 15 * 60;

export interface CredentialRequestPayload {
    provider: string;
    fields: CredentialField[];
    submitUrl: string;
    nonce: string;
}

export interface CredentialNonceClaims {
    provider: string;
    userId: string;
    expiresAt: number;
}

export function buildCredentialRequest(
    cfg: ExuluUserCredentialsConfig,
    opts: { baseUrl: string; userId: string; ttlSeconds?: number },
): CredentialRequestPayload {
    const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const claims: CredentialNonceClaims = {
        provider: cfg.provider,
        userId: opts.userId,
        expiresAt: Math.floor(Date.now() / 1000) + ttl,
    };
    const nonce = encrypt(JSON.stringify(claims));
    return {
        provider: cfg.provider,
        fields: cfg.fields,
        submitUrl: `${opts.baseUrl.replace(/\/+$/, "")}/credentials/submit`,
        nonce,
    };
}

export function verifyCredentialNonce(nonce: string): CredentialNonceClaims {
    let claims: CredentialNonceClaims;
    try {
        claims = JSON.parse(decrypt(nonce)) as CredentialNonceClaims;
    } catch {
        throw new Error("Invalid credential nonce");
    }
    if (typeof claims.provider !== "string" || typeof claims.userId !== "string" || typeof claims.expiresAt !== "number") {
        throw new Error("Malformed credential nonce claims");
    }
    if (claims.expiresAt < Math.floor(Date.now() / 1000)) {
        throw new Error("Credential nonce expired");
    }
    return claims;
}
