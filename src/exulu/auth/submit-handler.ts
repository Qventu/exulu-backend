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
    let detail = "Invalid request body";
    if (caught instanceof z.ZodError && Array.isArray(caught.errors) && caught.errors.length > 0) {
      detail = caught.errors[0].message;
    }
    res.status(400).json({ detail });
    return;
  }

  const { nonce, values } = parsed;

  // Decrypt and parse nonce to get userId and provider
  let nonceData;
  try {
    nonceData = verifyCredentialNonce(nonce);
  } catch {
    res.status(401).json({
      detail: "Invalid or expired nonce",
    });
    return;
  }

  const config = authRegistry.getByProvider(nonceData.provider);
  if (!config || config.authType !== "user_credentials") {
    res.status(400).json({
      detail: `No user_credentials configuration for provider "${nonceData.provider}"`,
    });
    return;
  }

  // Check field-set equality: expected fields == submitted values
  const expectedFields = new Set(config.fields.map((f) => f.name));
  const submittedFields = new Set(Object.keys(values));

  if (expectedFields.size !== submittedFields.size || [...expectedFields].some((f) => !submittedFields.has(f))) {
    res.status(400).json({
      detail: "Submitted fields do not match expected fields",
    });
    return;
  }

  // Run the optional validate hook
  if (config.validate) {
    try {
      await config.validate(values);
    } catch (caught) {
      res.status(400).json({
        detail: caught instanceof Error ? caught.message : "Validation failed",
      });
      return;
    }
  }

  // Persist credentials
  await credentialStore.upsert({
    provider: nonceData.provider,
    userId: parseInt(nonceData.userId, 10),
    authType: "user_credentials",
    data: values,
  });

  res.status(200).json({ ok: true });
}
