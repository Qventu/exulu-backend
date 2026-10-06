import {
  DEFAULT_BOT_NAME,
  filterLivePresets,
  getTranscriptsSettings,
  resolveTranscriptsSettings,
  saveTranscriptsSettings,
} from "./transcripts-settings";

const first = jest.fn();
const merge = jest.fn();

jest.mock("@SRC/postgres/client", () => ({
  postgresClient: async () => ({
    db: {
      from: () => ({
        where: () => ({ first }),
        insert: () => ({ onConflict: () => ({ merge }) }),
      }),
    },
  }),
}));

beforeEach(() => {
  first.mockReset();
  merge.mockReset();
  delete process.env.RECALL_RECORDING_RETENTION_HOURS;
  delete process.env.RECALL_STORE_VIDEO_LOCALLY;
  delete process.env.TOTAL_MAX_RECORDINGS_DURATION_PER_MONTH;
});

describe("getTranscriptsSettings", () => {
  it("returns all-null when there is no row", async () => {
    first.mockResolvedValue(undefined);
    const settings = await getTranscriptsSettings();
    expect(settings.botName).toBeNull();
    expect(settings.summaryPresets).toBeNull();
  });

  it("parses config_value when pg returns raw JSON text", async () => {
    first.mockResolvedValue({ config_value: '{"botName":"Acme Notetaker"}' });
    expect((await getTranscriptsSettings()).botName).toBe("Acme Notetaker");
  });

  it("accepts config_value already parsed into an object", async () => {
    first.mockResolvedValue({ config_value: { botName: "Acme Notetaker" } });
    expect((await getTranscriptsSettings()).botName).toBe("Acme Notetaker");
  });

  it("returns all-null rather than throwing when the read fails", async () => {
    // Runs on the composer-open and bot-dispatch paths: a database hiccup must
    // degrade to env/code, never block a bot from joining a meeting.
    first.mockRejectedValue(new Error("connection terminated"));
    const settings = await getTranscriptsSettings();
    expect(settings.botName).toBeNull();
  });

  it("returns all-null rather than throwing on unparseable JSON", async () => {
    first.mockResolvedValue({ config_value: "{not json" });
    expect((await getTranscriptsSettings()).botName).toBeNull();
  });
});

describe("resolveTranscriptsSettings", () => {
  it("falls back to the code default bot name", async () => {
    first.mockResolvedValue(undefined);
    const resolved = await resolveTranscriptsSettings();
    expect(resolved.botName).toEqual({ value: DEFAULT_BOT_NAME, source: "code" });
  });

  it("uses the stored bot name over the default", async () => {
    first.mockResolvedValue({ config_value: '{"botName":"Acme Notetaker"}' });
    expect((await resolveTranscriptsSettings()).botName).toEqual({
      value: "Acme Notetaker",
      source: "database",
    });
  });

  it("falls back to the code default for notifyChat (false), matching meetingBotStart's existing default", async () => {
    first.mockResolvedValue(undefined);
    expect((await resolveTranscriptsSettings()).notifyChat).toEqual({
      value: false,
      source: "code",
    });
  });

  it("reads retention from env when nothing is stored", async () => {
    process.env.RECALL_RECORDING_RETENTION_HOURS = "720";
    first.mockResolvedValue(undefined);
    expect((await resolveTranscriptsSettings()).videoRetentionHours).toEqual({
      value: 720,
      source: "env",
    });
  });

  it("a stored retention beats the env var", async () => {
    process.env.RECALL_RECORDING_RETENTION_HOURS = "720";
    first.mockResolvedValue({ config_value: '{"videoRetentionHours":168}' });
    expect((await resolveTranscriptsSettings()).videoRetentionHours).toEqual({
      value: 168,
      source: "database",
    });
  });

  it('carries the "forever" sentinel rather than treating it as unset', async () => {
    process.env.RECALL_RECORDING_RETENTION_HOURS = "720";
    first.mockResolvedValue({ config_value: '{"videoRetentionHours":"forever"}' });
    expect((await resolveTranscriptsSettings()).videoRetentionHours).toEqual({
      value: "forever",
      source: "database",
    });
  });

  it("a stored storeVideoLocally:false beats RECALL_STORE_VIDEO_LOCALLY=true", async () => {
    process.env.RECALL_STORE_VIDEO_LOCALLY = "true";
    first.mockResolvedValue({ config_value: '{"storeVideoLocally":false}' });
    expect((await resolveTranscriptsSettings()).storeVideoLocally).toEqual({
      value: false,
      source: "database",
    });
  });

  it('carries the "none" cap sentinel over an env cap', async () => {
    process.env.TOTAL_MAX_RECORDINGS_DURATION_PER_MONTH = "1500";
    first.mockResolvedValue({ config_value: '{"monthlyRecordingLimitMinutes":"none"}' });
    expect((await resolveTranscriptsSettings()).monthlyRecordingLimitMinutes).toEqual({
      value: "none",
      source: "database",
    });
  });
});

describe("saveTranscriptsSettings", () => {
  it("merges a patch into the existing object rather than replacing it", async () => {
    // Saving one section must not clobber another section's values.
    first.mockResolvedValue({ config_value: '{"botName":"Acme","notifyChat":true}' });
    await saveTranscriptsSettings({ notifyChat: false });
    const written = JSON.parse(merge.mock.calls[0][0].config_value);
    expect(written).toEqual({ botName: "Acme", notifyChat: false });
  });

  it("an explicit null clears one field and leaves the rest", async () => {
    first.mockResolvedValue({ config_value: '{"botName":"Acme","notifyChat":true}' });
    await saveTranscriptsSettings({ botName: null });
    const written = JSON.parse(merge.mock.calls[0][0].config_value);
    expect(written).toEqual({ botName: null, notifyChat: true });
  });
});

describe("filterLivePresets", () => {
  const prompts = new Set(["p1"]);
  const agents = new Set(["a1"]);

  it("keeps a preset whose prompt and agent both exist", () => {
    const { live, stale } = filterLivePresets([{ prompt_id: "p1", agent_id: "a1" }], prompts, agents);
    expect(live).toHaveLength(1);
    expect(stale).toHaveLength(0);
  });

  it("drops a preset whose prompt was deleted", () => {
    const { live, stale } = filterLivePresets([{ prompt_id: "gone", agent_id: "a1" }], prompts, agents);
    expect(live).toHaveLength(0);
    expect(stale).toEqual([{ prompt_id: "gone", agent_id: "a1" }]);
  });

  it("drops a preset whose agent was deleted", () => {
    const { live, stale } = filterLivePresets([{ prompt_id: "p1", agent_id: "gone" }], prompts, agents);
    expect(live).toHaveLength(0);
    expect(stale).toHaveLength(1);
  });

  it("returns both lists for a mixed set", () => {
    const { live, stale } = filterLivePresets(
      [{ prompt_id: "p1", agent_id: "a1" }, { prompt_id: "gone", agent_id: "a1" }],
      prompts,
      agents,
    );
    expect(live).toHaveLength(1);
    expect(stale).toHaveLength(1);
  });

  it("handles an empty preset list", () => {
    expect(filterLivePresets([], prompts, agents)).toEqual({ live: [], stale: [] });
  });
});
