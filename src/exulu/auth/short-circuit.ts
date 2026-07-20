import type { CredentialRequestPayload } from "./credentials-request";

export function credentialRequestResult(request: CredentialRequestPayload) {
  return { credentialRequest: request, result: null };
}
