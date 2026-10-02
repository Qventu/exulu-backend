import {
  RECALL_RECORDING_RETENTION_DEFAULT_HOURS,
  recallRecordingRetentionHours,
  recallStoreVideoLocally,
} from "./env";

/**
 * Both knobs exist so a deployment can choose its own privacy/cost trade-off
 * (2026-09-22): a customer needing near-zero retention at Recall (the
 * third party) sets RECALL_RECORDING_RETENTION_HOURS very low and pairs it
 * with RECALL_STORE_VIDEO_LOCALLY=true so the video lands on their own
 * server promptly; a customer who doesn't care leaves both at their
 * defaults and the video just lives at Recall for the default window.
 */
describe("recallRecordingRetentionHours — configurable Recall-side retention window", () => {
  const ORIGINAL_ENV = process.env.RECALL_RECORDING_RETENTION_HOURS;
  afterEach(() => {
    process.env.RECALL_RECORDING_RETENTION_HOURS = ORIGINAL_ENV;
  });

  it("defaults to 90 days (2160 hours) when unset", () => {
    delete process.env.RECALL_RECORDING_RETENTION_HOURS;
    expect(recallRecordingRetentionHours()).toBe(RECALL_RECORDING_RETENTION_DEFAULT_HOURS);
    expect(recallRecordingRetentionHours()).toBe(2160);
  });

  it("honors a configured value, e.g. 1 hour for a zero-data-retention customer", () => {
    process.env.RECALL_RECORDING_RETENTION_HOURS = "1";
    expect(recallRecordingRetentionHours()).toBe(1);
  });

  it("falls back to the default for a non-numeric or non-positive value", () => {
    process.env.RECALL_RECORDING_RETENTION_HOURS = "not-a-number";
    expect(recallRecordingRetentionHours()).toBe(2160);
    process.env.RECALL_RECORDING_RETENTION_HOURS = "0";
    expect(recallRecordingRetentionHours()).toBe(2160);
    process.env.RECALL_RECORDING_RETENTION_HOURS = "-5";
    expect(recallRecordingRetentionHours()).toBe(2160);
  });

  it("floors a fractional value", () => {
    process.env.RECALL_RECORDING_RETENTION_HOURS = "2.9";
    expect(recallRecordingRetentionHours()).toBe(2);
  });
});

describe("recallStoreVideoLocally — whether to persist a copy of the meeting video in our own S3", () => {
  const ORIGINAL_ENV = process.env.RECALL_STORE_VIDEO_LOCALLY;
  afterEach(() => {
    process.env.RECALL_STORE_VIDEO_LOCALLY = ORIGINAL_ENV;
  });

  it("defaults to false (off) when unset", () => {
    delete process.env.RECALL_STORE_VIDEO_LOCALLY;
    expect(recallStoreVideoLocally()).toBe(false);
  });

  it("is true only for the exact string 'true'", () => {
    process.env.RECALL_STORE_VIDEO_LOCALLY = "true";
    expect(recallStoreVideoLocally()).toBe(true);
    process.env.RECALL_STORE_VIDEO_LOCALLY = "1";
    expect(recallStoreVideoLocally()).toBe(false);
    process.env.RECALL_STORE_VIDEO_LOCALLY = "TRUE";
    expect(recallStoreVideoLocally()).toBe(false);
  });
});
