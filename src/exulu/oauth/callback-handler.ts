import type { Request, Response } from "express";
import { oauthRegistry } from "./registry";
import { decryptOauthState, exchangeCodeForTokens } from "./flow";
import { oauthTokenStore } from "./token-store";

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderResultPage = ({ success, message }: { success: boolean; message: string }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${success ? "Connected" : "Authorization failed"}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f6f7f9; color: #1a1a2e; }
      main { background: #fff; border-radius: 12px; padding: 40px 48px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); text-align: center; max-width: 420px; }
      .icon { font-size: 40px; }
      h1 { font-size: 20px; margin: 16px 0 8px; }
      p { font-size: 14px; line-height: 1.5; color: #555; margin: 0; }
    </style>
  </head>
  <body>
    <main>
      <div class="icon">${success ? "✓" : "✕"}</div>
      <h1>${success ? "Connected" : "Authorization failed"}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;

/**
 * Generic OAuth callback for oauth-enabled ExuluTools. Intentionally has no
 * auth middleware: the user arrives here from the provider's redirect, and
 * their identity comes from the encrypted state parameter instead.
 */
export const handleOauthCallback = async (req: Request, res: Response) => {
  const send = (status: number, success: boolean, message: string) =>
    res.status(status).type("html").send(renderResultPage({ success, message }));

  const { code, state, error, error_description } = req.query;

  if (error) {
    const reason =
      typeof error_description === "string"
        ? error_description
        : typeof error === "string"
          ? error
          : "unknown error";
    return send(
      400,
      false,
      `The provider rejected the authorization: ${reason}. Return to your chat and run the tool again to retry.`,
    );
  }
  if (typeof code !== "string" || typeof state !== "string") {
    return send(
      400,
      false,
      "Missing code or state parameter. Return to your chat and run the tool again to get a fresh link.",
    );
  }

  let parsed;
  try {
    parsed = decryptOauthState(state);
  } catch {
    return send(
      400,
      false,
      "This authorization link is invalid or has expired. Return to your chat and run the tool again to get a fresh link.",
    );
  }

  const config = oauthRegistry.getByProvider(parsed.provider);
  if (!config) {
    return send(
      404,
      false,
      `No OAuth configuration is registered for provider "${parsed.provider}".`,
    );
  }

  try {
    const record = await exchangeCodeForTokens({
      config,
      code,
      codeVerifier: parsed.codeVerifier,
    });
    await oauthTokenStore.upsert(parsed.provider, parsed.userId, parsed.toolId, record);
  } catch (caught) {
    console.error("[EXULU] OAuth code exchange failed:", caught);
    return send(
      502,
      false,
      "Could not complete the authorization with the provider. Return to your chat and run the tool again to retry.",
    );
  }

  return send(200, true, "You can close this tab and return to your chat.");
};
