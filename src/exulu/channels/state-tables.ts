import type { Pool } from "pg";

type StateModule = {
  createPostgresState: (options: {
    client: Pool;
    keyPrefix: string;
    autoCreateSchema: boolean;
  }) => { connect(): Promise<void>; disconnect(): Promise<void> };
};

// The chat SDK packages are ESM only and jest runs our sources as CommonJS, so
// they are only ever imported dynamically, and the loader is injectable.
const loadStateModule = (): Promise<StateModule> =>
  import("@chat-adapter/state-pg") as unknown as Promise<StateModule>;

/**
 * Creates the chat SDK's `chat_state_*` tables with the adapter's own DDL
 * (autoCreateSchema), so nothing is copied here and a later SDK version brings
 * its own schema. Only meant to run from `utils:initdb`.
 */
export async function ensureChatStateTables(
  pool: Pool,
  load: () => Promise<StateModule> = loadStateModule,
): Promise<void> {
  const { createPostgresState } = await load();
  const state = createPostgresState({
    client: pool,
    keyPrefix: "exulu-channel",
    autoCreateSchema: true,
  });
  try {
    await state.connect();
  } finally {
    await state.disconnect();
  }
}
