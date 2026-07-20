import { validateAuthConfig } from "./validate";

describe("validateAuthConfig", () => {
  const ORIGINAL_BACKEND = process.env.BACKEND;

  beforeAll(() => {
    process.env.BACKEND = "https://test.example.com";
  });

  afterAll(() => {
    if (ORIGINAL_BACKEND !== undefined) {
      process.env.BACKEND = ORIGINAL_BACKEND;
    } else {
      delete process.env.BACKEND;
    }
  });

  describe("oauth branch", () => {
    it("accepts a well-formed oauth config", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "oauth",
          provider: "google",
          authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientId: "client-id",
          clientSecret: "client-secret",
          scopes: ["openid", "email"],
          pkce: true,
        })
      ).not.toThrow();
    });

    it("accepts oauth config with empty scopes array", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "oauth",
          provider: "github",
          authorizationUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          clientId: "abc",
          clientSecret: "xyz",
          scopes: [],
        })
      ).not.toThrow();
    });

    it("rejects missing authorizationUrl", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "oauth",
          provider: "google",
          authorizationUrl: "",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientId: "client-id",
          clientSecret: "client-secret",
          scopes: [],
        } as any)
      ).toThrow(/authorizationUrl/);
    });

    it("rejects missing tokenUrl", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "oauth",
          provider: "google",
          authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
          tokenUrl: "",
          clientId: "client-id",
          clientSecret: "client-secret",
          scopes: [],
        } as any)
      ).toThrow(/tokenUrl/);
    });

    it("rejects missing clientId", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "oauth",
          provider: "google",
          authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientId: "",
          clientSecret: "client-secret",
          scopes: [],
        } as any)
      ).toThrow(/clientId/);
    });

    it("rejects missing clientSecret", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "oauth",
          provider: "google",
          authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientId: "client-id",
          clientSecret: "",
          scopes: [],
        } as any)
      ).toThrow(/clientSecret/);
    });

    it("rejects non-array scopes", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "oauth",
          provider: "google",
          authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientId: "client-id",
          clientSecret: "client-secret",
          scopes: "openid email" as any,
        })
      ).toThrow(/scopes must be an array/);
    });

    it("rejects provider with leading whitespace", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "oauth",
          provider: " google",
          authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientId: "client-id",
          clientSecret: "client-secret",
          scopes: [],
        })
      ).toThrow(/provider must be a non-empty string with no leading or trailing whitespace/);
    });

    it("rejects provider with trailing whitespace", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "oauth",
          provider: "google ",
          authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientId: "client-id",
          clientSecret: "client-secret",
          scopes: [],
        })
      ).toThrow(/provider must be a non-empty string with no leading or trailing whitespace/);
    });

    it("rejects empty provider", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "oauth",
          provider: "",
          authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientId: "client-id",
          clientSecret: "client-secret",
          scopes: [],
        })
      ).toThrow(/provider must be a non-empty string with no leading or trailing whitespace/);
    });

    it("rejects missing BACKEND env var", () => {
      delete process.env.BACKEND;
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "oauth",
          provider: "google",
          authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientId: "client-id",
          clientSecret: "client-secret",
          scopes: [],
        })
      ).toThrow(/oauth requires the BACKEND environment variable/);
      // Restore BACKEND for subsequent tests
      process.env.BACKEND = "https://test.example.com";
    });
  });

  describe("user_credentials branch", () => {
    it("accepts a well-formed user_credentials config", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "user_credentials",
          provider: "myapp",
          fields: [
            { name: "username", label: "Username", type: "text" },
            { name: "password", label: "Password", type: "password" },
          ],
        })
      ).not.toThrow();
    });

    it("accepts user_credentials config with single field", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "user_credentials",
          provider: "api",
          fields: [{ name: "token", label: "API Token", type: "password" }],
        })
      ).not.toThrow();
    });

    it("rejects empty fields array", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "user_credentials",
          provider: "myapp",
          fields: [],
        })
      ).toThrow(/fields must contain at least one field/);
    });

    it("rejects duplicate field names", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "user_credentials",
          provider: "myapp",
          fields: [
            { name: "username", label: "Username", type: "text" },
            { name: "username", label: "Username Again", type: "text" },
          ],
        })
      ).toThrow(/duplicate field name/);
    });

    it("rejects invalid field type (not text or password)", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "user_credentials",
          provider: "myapp",
          fields: [
            { name: "username", label: "Username", type: "email" as any },
          ],
        })
      ).toThrow(/type must be 'text' or 'password'/);
    });

    it("rejects provider with leading whitespace on user_credentials", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "user_credentials",
          provider: " myapp",
          fields: [{ name: "token", label: "Token", type: "password" }],
        })
      ).toThrow(/user_credentials.provider must be a non-empty string with no leading or trailing whitespace/);
    });

    it("rejects provider with trailing whitespace on user_credentials", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "user_credentials",
          provider: "myapp ",
          fields: [{ name: "token", label: "Token", type: "password" }],
        })
      ).toThrow(/user_credentials.provider must be a non-empty string with no leading or trailing whitespace/);
    });

    it("rejects empty provider on user_credentials", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "user_credentials",
          provider: "",
          fields: [{ name: "token", label: "Token", type: "password" }],
        })
      ).toThrow(/user_credentials.provider must be a non-empty string with no leading or trailing whitespace/);
    });

    it("rejects field with empty name", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "user_credentials",
          provider: "myapp",
          fields: [
            { name: "", label: "Username", type: "text" },
          ],
        })
      ).toThrow(/fields\[0\].name must be a non-empty string/);
    });

    it("rejects field name with whitespace", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "user_credentials",
          provider: "myapp",
          fields: [
            { name: " username ", label: "Username", type: "text" },
          ],
        })
      ).toThrow(/fields\[0\].name must be a non-empty string/);
    });

    it("rejects missing BACKEND env var on user_credentials", () => {
      delete process.env.BACKEND;
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "user_credentials",
          provider: "myapp",
          fields: [{ name: "token", label: "Token", type: "password" }],
        })
      ).toThrow(/user_credentials requires the BACKEND environment variable/);
      // Restore BACKEND for subsequent tests
      process.env.BACKEND = "https://test.example.com";
    });

    it("includes toolId in error messages", () => {
      const toolId = "my-special-tool";
      expect(() =>
        validateAuthConfig(toolId, {
          authType: "user_credentials",
          provider: "myapp",
          fields: [],
        })
      ).toThrow(new RegExp(`ExuluTool "${toolId}"`));
    });
  });

  describe("unreachable authType", () => {
    it("rejects unknown authType", () => {
      expect(() =>
        validateAuthConfig("test-tool", {
          authType: "unknown",
        } as any)
      ).toThrow(/authType.*not supported/);
    });
  });
});
