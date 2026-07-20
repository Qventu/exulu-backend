import type { ExuluAuthConfig, ExuluOauthConfig, ExuluUserCredentialsConfig } from "./types";

describe("ExuluAuthConfig union", () => {
    it("narrows on authType === 'oauth'", () => {
        const cfg: ExuluAuthConfig = {
            authType: "oauth",
            provider: "jira",
            authorizationUrl: "https://x",
            tokenUrl: "https://y",
            clientId: "c",
            clientSecret: "s",
            scopes: ["a"],
            pkce: true,
        };
        if (cfg.authType === "oauth") {
            const _oauth: ExuluOauthConfig = cfg;
            expect(_oauth.clientId).toBe("c");
        } else {
            throw new Error("expected oauth branch");
        }
    });

    it("narrows on authType === 'user_credentials'", () => {
        const cfg: ExuluAuthConfig = {
            authType: "user_credentials",
            provider: "moco",
            fields: [{ name: "subdomain", label: "Subdomain", type: "text" }],
        };
        if (cfg.authType === "user_credentials") {
            const _uc: ExuluUserCredentialsConfig = cfg;
            expect(_uc.fields[0].name).toBe("subdomain");
        } else {
            throw new Error("expected user_credentials branch");
        }
    });
});
