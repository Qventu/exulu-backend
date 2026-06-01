import type { ExuluContext } from "@SRC/exulu/context";
import { transcriptionsContext } from "./transcriptions";

/**
 * ExuluContexts that ship with @exulu/backend. Merged into ExuluApp.create()
 * ahead of user-provided contexts. Consumers can override by declaring a
 * context with the same id (a startup warning is logged when this happens).
 */
export const builtInContexts: Record<string, ExuluContext> = {
  transcriptions: transcriptionsContext,
};
