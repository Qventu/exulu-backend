import type { Request, Response } from "express";
import { z } from "zod";
import { authRegistry } from "./registry";
import { credentialStore } from "./credential-store";
import { verifyCredentialNonce } from "./credentials-request";

const bodySchema = z.object({
  nonce: z.string().min(1),
  values: z.record(z.string(), z.string()),
});

/**
 * Handles POST /credentials/submit for user_credentials auth flow.
 * Unauthenticated by design: the user's identity comes from the encrypted nonce.
 */
export async function handleCredentialSubmit(req: Request, res: Response): Promise<void> {
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

  // Persist credentials
  const uid = Number(nonceData.userId);
  if (!Number.isInteger(uid) || uid <= 0) {
    res.status(401).json({ ok: false, error: "nonce invalid" });
    return;
  }
  await credentialStore.upsert({
    provider: nonceData.provider,
    userId: uid,
    authType: "user_credentials",
    data: values,
  });

  res.status(200).json({ ok: true });
}
