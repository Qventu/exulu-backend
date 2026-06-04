/**
 * Hermes Agent integration ("advanced agent mode") — public surface.
 *
 * Design doc: docs/superpowers/specs/2026-06-03-hermes-agent-mode-design.md
 */
export {
  isHermesEnabled,
  validateHermesAtBoot,
  getHermesHome,
  getProfileDir,
} from "./config";
export {
  ensureGateway,
  stopGateway,
  getGatewayPoolStatus,
  type GatewayHandle,
} from "./supervisor";
export {
  ensureProfile,
  profileIdFor,
  type ProvisionInput,
} from "./provisioner";
export {
  createHermesRunStream,
  uiMessageText,
  type HermesRunStreamParams,
} from "./run-stream";
export { resolveHermesSessionId } from "./session-map";
