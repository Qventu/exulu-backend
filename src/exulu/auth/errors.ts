export class CredentialInvalidError extends Error {
    readonly provider: string;
    readonly reason?: string;
    constructor(provider: string, reason?: string) {
        super(reason ? `Credential invalid for provider '${provider}': ${reason}` : `Credential invalid for provider '${provider}'`);
        this.name = "CredentialInvalidError";
        this.provider = provider;
        this.reason = reason;
    }
}
