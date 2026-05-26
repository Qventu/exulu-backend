import { initLiteLLMDatabase } from "@SRC/exulu/litellm/db-init";
import { getPackageRoot } from "@SRC/utils/python-setup";

export const initLitellmDb = async (): Promise<void> => {
    // Set up LiteLLM's database schema if a `database_url` is configured in
    // config.litellm.yaml. Idempotent (Prisma "already in sync" no-op on
    // re-runs) and safe to call when LiteLLM mode is off (short-circuits).
    // Crucially: if LiteLLM's database_url points at the SAME database Exulu
    // uses, this loudly WARNs and skips the push — LiteLLM's schema sync
    // would otherwise drop every non-LiteLLM_* table in the public schema.
    // See db-init.ts for the full check sequence.
    await initLiteLLMDatabase(getPackageRoot());
    console.log("[EXULU] LiteLLM database initialized.");
    return;
}