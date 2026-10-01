/**
 * Authorisation gate for setTranscriptsSettings.
 *
 * Review focus: the Transcripts settings page sits behind a menu entry every
 * user sees, so the UI-level check is not the protection — this server-side
 * super_admin gate (createMutations in ./index) is. Calls the real resolver
 * returned by createMutations (same harness as validate-write-access.test.ts)
 * rather than re-implementing the check, so a regression in the actual gate
 * fails this test.
 */

// Mock the heavy graph mutations/index.ts imports (same approach as
// validate-write-access.test.ts / get-items-rbac.test.ts) — jest.mock calls
// are hoisted above the import.
jest.mock("@SRC/exulu/context", () => ({
  getChunksTableName: (id: string) => `${id}_chunks`,
  getTableName: (id: string) => id,
}));
jest.mock("@SRC/exulu/entities", () => ({
  resolveEntityModel: jest.fn(),
  setEntityModelSetting: jest.fn(),
}));
jest.mock("@SRC/exulu/statistics", () => ({ updateStatistic: jest.fn() }));
jest.mock("@SRC/graphql/resolvers/utils", () => ({
  contextItemsProcessorHandler: jest.fn(),
  getRequestedFields: jest.fn(() => []),
}));
jest.mock("@SRC/graphql/utilities/access-control", () => ({
  applyAccessControl: jest.fn((_t: any, q: any) => q),
}));
jest.mock("@SRC/auth/generate-key.ts", () => ({ SALT_ROUNDS: 10 }));
jest.mock("@SRC/graphql/resolvers/apply-filters.ts", () => ({
  applyFilters: jest.fn(),
}));
jest.mock("@SRC/graphql/utilities/validate-super-admin-update.ts", () => ({
  validateCreateOrRemoveSuperAdminPermission: jest.fn(async () => {}),
}));
jest.mock("@SRC/graphql/utilities/encrypt-sensitive-fields.ts", () => ({
  encryptSensitiveFields: (input: any) => input,
}));
jest.mock("@SRC/graphql/utilities/sanitize-and-hydrate-fields.ts", () => ({
  finalizeRequestedFields: jest.fn((f: any) => f),
}));
jest.mock("@SRC/exulu/routines/run-state.ts", () => ({
  cancelRoutineRunRow: jest.fn(),
}));
jest.mock("@EE/queues/queues", () => ({ queues: {} }));
jest.mock("@SRC/graphql/resolvers/index.ts", () => ({
  itemsPaginationRequest: jest.fn(),
  sanitizeRequestedFields: jest.fn((f: any) => f),
}));
jest.mock("@EE/rbac-update.ts", () => ({ handleRBACUpdate: jest.fn() }));

// setTranscriptsSettings-specific mocks: buildTranscriptsSettingsInfo (called
// on every successful save, including the "allows a super admin" case below)
// touches postgresClient (for prompt_library) and exuluApp (for agents), plus
// the Task 2 settings module itself.
//
// Both reads are controllable per-test (promptLibraryBehavior /
// agentsBehavior) so the degradation tests below can force each one to throw
// independently — pinning Review Fix #1: buildTranscriptsSettingsInfo must
// resolve, not reject, when either lookup fails.
let promptLibraryBehavior: "ok" | "throw" = "ok";
let agentsBehavior: "ok" | "throw" = "ok";

jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({
    db: Object.assign((_table: string) => ({}), {
      // .select("id") matters here: it is the shape buildTranscriptsSettingsInfo
      // must call (Review Fix #2 — no full-row prompt_library scan).
      from: (_table: string) => ({
        select: async (_col: string) => {
          if (promptLibraryBehavior === "throw") {
            throw new Error("prompt_library read failed");
          }
          return [] as { id: string }[];
        },
      }),
    }),
  })),
}));
jest.mock("@SRC/exulu/app/singleton", () => ({
  exuluApp: {
    get: () => ({
      agents: async () => {
        if (agentsBehavior === "throw") {
          throw new Error("agents() failed");
        }
        return [];
      },
    }),
  },
}));

const saveTranscriptsSettings = jest.fn(async () => {});
const filterLivePresetsMock = jest.fn(() => ({ live: [], stale: [] }));
const STORED_PRESETS = [{ prompt_id: "p1", agent_id: "a1" }];
jest.mock("@SRC/exulu/transcripts-settings", () => ({
  saveTranscriptsSettings: (...args: unknown[]) => saveTranscriptsSettings(...args),
  resolveTranscriptsSettings: jest.fn(async () => ({
    botName: { value: "IMP Notetaker", source: "code" },
    notifyChat: { value: false, source: "code" },
    recordersMayOverrideBot: { value: true, source: "code" },
    defaultRightsMode: { value: "private", source: "code" },
    summaryPresets: { value: STORED_PRESETS, source: "code" },
    videoRetentionHours: { value: 2160, source: "code" },
    storeVideoLocally: { value: false, source: "code" },
    monthlyRecordingLimitMinutes: { value: "none", source: "code" },
    videoStorageCostPerHour: { value: 0, source: "code" },
  })),
  filterLivePresets: (...args: unknown[]) => filterLivePresetsMock(...(args as [])),
}));

import { createMutations, buildTranscriptsSettingsInfo } from "./index";

// Unrelated to `table` (see ./index's own comment at the registration site),
// so any table-shaped stub works here.
const dummyTable: any = {
  name: { singular: "transcripts_settings_dummy", plural: "transcripts_settings_dummies" },
  type: "model",
  fields: [],
};

const mutations = createMutations(dummyTable, [], [], {} as any);
const callSetTranscriptsSettings = (context: any, input: any) =>
  mutations["setTranscriptsSettings"](null, { input }, context, {});

afterEach(() => {
  promptLibraryBehavior = "ok";
  agentsBehavior = "ok";
  filterLivePresetsMock.mockClear();
});

describe("setTranscriptsSettings authorisation", () => {
  it("rejects an unauthenticated caller", async () => {
    await expect(callSetTranscriptsSettings({ user: null }, {})).rejects.toThrow(/Authentication/i);
  });

  it("rejects an authenticated NON-super-admin", async () => {
    // Review Focus #5: the settings link sits in a menu every user sees, so
    // the UI check is not the protection — this one is.
    await expect(
      callSetTranscriptsSettings({ user: { id: 7, super_admin: false } }, {}),
    ).rejects.toThrow(/super admin/i);
  });

  it("allows a super admin", async () => {
    await expect(
      callSetTranscriptsSettings({ user: { id: 1, super_admin: true } }, { notifyChat: false }),
    ).resolves.toBeTruthy();
  });
});

describe("buildTranscriptsSettingsInfo degradation", () => {
  // transcriptsSettings is a non-null root field, so a throw here would
  // null-bubble the entire GraphQL response on every composer open — these
  // id lookups exist only to label presets live/stale, never to gate the
  // whole query. Review Fix #1.
  it("resolves (does not reject) when the prompt_library read throws, treating stored presets as live", async () => {
    promptLibraryBehavior = "throw";

    const info = await buildTranscriptsSettingsInfo();

    expect(info.summaryPresets.value).toEqual(STORED_PRESETS);
    expect(info.stalePresets).toEqual([]);
    // Filtering with a partial id set would risk mislabelling a real preset
    // as stale, so the degraded path must bypass it entirely.
    expect(filterLivePresetsMock).not.toHaveBeenCalled();
  });

  it("resolves (does not reject) when agents() throws, treating stored presets as live", async () => {
    agentsBehavior = "throw";

    const info = await buildTranscriptsSettingsInfo();

    expect(info.summaryPresets.value).toEqual(STORED_PRESETS);
    expect(info.stalePresets).toEqual([]);
    expect(filterLivePresetsMock).not.toHaveBeenCalled();
  });

  it("still runs filterLivePresets normally when both lookups succeed", async () => {
    const info = await buildTranscriptsSettingsInfo();

    expect(filterLivePresetsMock).toHaveBeenCalledTimes(1);
    expect(info.summaryPresets.value).toEqual([]);
    expect(info.stalePresets).toEqual([]);
  });
});
