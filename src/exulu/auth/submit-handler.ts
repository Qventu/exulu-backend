import type { Request, Response } from "express";
import { z } from "zod";
import { authRegistry } from "./registry";
import { credentialStore } from "./credential-store";
import { verifyCredentialNonce } from "./credentials-request";
import { requestValidators } from "../../validators/requests";

const bodySchema = z.object({
  nonce: z.string().min(1),
  values: z.record(z.string(), z.string()),
});

/**
 * Handles POST /credentials/submit for user_credentials auth flow.
 * Requires an authenticated session; cross-checks session userId against the
 * nonce's userId to prevent nonce-replay attacks across users.
 */
export async function handleCredentialSubmit(req: Request, res: Response): Promise<void> {
  // Require an authenticated session — session is the source of truth for identity
  const authResult = await requestValidators.authenticate(req);
  if (!authResult.user?.id) {
    res.status(401).json({ ok: false, error: "authentication required" });
    return;
  }
  const sessionUserId = authResult.user.id;

  // Validate request body
  let parsed;
  try {
    parsed = bodySchema.parse(req.body);
  } catch (caught) {
    res.status(400).json({ ok: false, error: "invalid body" });
    return;
  }

  const { nonce, values } = parsed;

  // Decrypt and parse nonce to get userId and provider
  let nonceData;
  try {
    nonceData = verifyCredentialNonce(nonce);
  } catch (e: any) {
    res.status(401).json({
      ok: false,
      error: /expired/i.test(e.message) ? "nonce expired" : "nonce invalid",
    });
    return;
  }

  // Cross-check: session userId must match the nonce's userId.
  // Prevents an attacker from replaying a leaked nonce under their own session
  // to overwrite another user's credentials.
  if (sessionUserId !== Number(nonceData.userId)) {
    res.status(403).json({ ok: false, error: "userId mismatch" });
    return;
  }

  const config = authRegistry.getByProvider(nonceData.provider);
  if (!config || config.authType !== "user_credentials") {
    res.status(400).json({
      ok: false,
      error: "provider is not a user_credentials provider",
    });
    return;
  }

  // Check field-set equality: expected fields == submitted values
  const expectedFields = new Set(config.fields.map((f) => f.name));
  const submittedFields = new Set(Object.keys(values));

  if (expectedFields.size !== submittedFields.size || [...expectedFields].some((f) => !submittedFields.has(f))) {
    res.status(400).json({
      ok: false,
      error: "field set mismatch",
    });
    return;
  }

  // Run the optional validate hook
  if (config.validate) {
    try {
      await config.validate(values);
    } catch (e: any) {
      res.status(400).json({
        ok: false,
        error: `validation failed: ${e.message}`,
      });
      return;
    }
  }

  // Validate the session userId (redundant given auth check above, but defensive)
  if (!Number.isInteger(sessionUserId) || sessionUserId <= 0) {
    res.status(401).json({ ok: false, error: "nonce invalid" });
    return;
  }

  // Persist credentials — use session userId (source of truth), not nonce's
  await credentialStore.upsert({
    provider: nonceData.provider,
    userId: sessionUserId,
    authType: "user_credentials",
    data: values,
  });

  res.status(200).json({ ok: true });
}
