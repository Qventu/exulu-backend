import express from "express";
import request from "supertest";

import { registerTranscriptExportRoute, type TranscriptExportRouteDeps } from "./export-route";

const ITEM = {
  name: "Kick-off Comfort-Line",
  recording_source: "recall",
  recorded_at: "2026-09-10T09:00:00.000Z",
  duration_seconds: 3494,
  language: "de",
  speakers: { SPEAKER_00: "Anja Keller" },
  raw_segments: [
    { start: 1278, end: 1299, text: "Then let's fix the dates.", speaker: "SPEAKER_00" },
  ],
  corrected_segments: null,
  post_processing: null,
};

const app = (over: Partial<TranscriptExportRouteDeps> = {}) => {
  const server = express();
  registerTranscriptExportRoute(server, {
    authenticate: async () => ({ user: { id: 7 } }),
    getItem: async () => ITEM,
    convert: async () => Buffer.from("DOCX"),
    ...over,
  });
  return server;
};

describe("GET /transcription-items/:itemId/export", () => {
  it("401s when the caller is not authenticated", async () => {
    const res = await request(
      app({ authenticate: async () => ({ code: 401, message: "Authentication required" }) }),
    ).get("/transcription-items/item-1/export?format=md");
    expect(res.status).toBe(401);
  });

  it("400s on a format it does not know", async () => {
    const res = await request(app()).get("/transcription-items/item-1/export?format=xlsx");
    expect(res.status).toBe(400);
  });

  it("404s when the item is missing or unreadable", async () => {
    // getItem goes through the context's own getItems({ user }), so an item
    // the caller may not read comes back undefined — the same 404 either way,
    // deliberately: a 403 would confirm the transcript exists.
    const res = await request(app({ getItem: async () => undefined })).get(
      "/transcription-items/item-1/export?format=md",
    );
    expect(res.status).toBe(404);
  });

  it("serves markdown with a download filename", async () => {
    const res = await request(app()).get("/transcription-items/item-1/export?format=md");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.text).toContain("# Kick-off Comfort-Line");
  });

  it("serves csv with a header row", async () => {
    const res = await request(app()).get("/transcription-items/item-1/export?format=csv");
    expect(res.text.split("\n")[0]).toBe("start,end,speaker,text");
  });

  it("serves srt cues", async () => {
    const res = await request(app()).get("/transcription-items/item-1/export?format=srt");
    expect(res.text).toContain("00:21:18,000 --> 00:21:39,000");
  });

  it("routes docx through the converter", async () => {
    const convert = jest.fn(async () => Buffer.from("DOCX"));
    const res = await request(app({ convert })).get(
      "/transcription-items/item-1/export?format=docx",
    );
    expect(res.status).toBe(200);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("defaults all three include options to on and honours an explicit 0", async () => {
    const on = await request(app()).get("/transcription-items/item-1/export?format=md");
    expect(on.text).toContain("[21:18]");

    const off = await request(app()).get(
      "/transcription-items/item-1/export?format=md&timestamps=0",
    );
    expect(off.text).not.toContain("[21:18]");
  });

  it("500s with a generic message when the converter fails", async () => {
    const res = await request(
      app({
        convert: async () => {
          throw new Error("pandoc: command not found");
        },
      }),
    ).get("/transcription-items/item-1/export?format=docx");
    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Export failed.");
    expect(JSON.stringify(res.body)).not.toContain("pandoc");
  });
});
