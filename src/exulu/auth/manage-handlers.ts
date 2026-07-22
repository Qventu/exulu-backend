import type { Request, Response } from "express";
import { credentialStore } from "./credential-store";
import { requestValidators } from "../../validators/requests";

/**
 * GET /credentials — the caller's stored tool credentials, metadata only
 * (spec 2026-07-22-tool-credentials-chat-ui §1.3). Values never leave the
 * store through this path. Auth-namespace response dialect: { ok, ... }.
 */
export const handleCredentialList = async (req: Request, res: Response): Promise<void> => {
  const authResult = await requestValidators.authenticate(req);
  if (!authResult.user?.id) {
    res.status(authResult.code ?? 401).json({ ok: false, error: "authentication required" });
    return;
  }
  const credentials = await credentialStore.listByUser(authResult.user.id);
  res.status(200).json({ ok: true, credentials });
};

/**
 * DELETE /credentials/:provider — revoke the caller's stored credentials for
 * one provider. Idempotent: deleting an absent row still returns { ok: true }.
 * The session user is the only identity ever used (never client-supplied).
 */
export const handleCredentialDelete = async (req: Request, res: Response): Promise<void> => {
  const authResult = await requestValidators.authenticate(req);
  if (!authResult.user?.id) {
    res.status(authResult.code ?? 401).json({ ok: false, error: "authentication required" });
    return;
  }
  const provider = req.params.provider;
  if (!provider) {
    res.status(400).json({ ok: false, error: "provider is required" });
    return;
  }
  await credentialStore.delete(provider, authResult.user.id);
  res.status(200).json({ ok: true });
};
