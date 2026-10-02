import { downloadAndStoreRecordingVideo } from "./video-storage";
import type { RecallRecording } from "./client";
import type { ExuluConfig } from "@SRC/exulu/app";

jest.mock("@SRC/uppy", () => ({
  uploadFile: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { uploadFile } = require("@SRC/uppy") as { uploadFile: jest.Mock };

const config = { fileUploads: { s3Bucket: "bucket" } } as unknown as ExuluConfig;

const recording = (over: Partial<RecallRecording> = {}): RecallRecording => ({
  id: "rec-1",
  media_shortcuts: {
    video_mixed: {
      status: { code: "done" },
      data: { download_url: "https://recall.example/video.mp4" },
    },
  },
  ...over,
});

beforeEach(() => {
  global.fetch = jest.fn();
  uploadFile.mockReset();
});

describe("downloadAndStoreRecordingVideo — permanent local copy of a Recall meeting video", () => {
  it("returns null when the recording has no video_mixed artifact", async () => {
    const result = await downloadAndStoreRecordingVideo(
      recording({ media_shortcuts: {} }),
      "job-1",
      config,
    );
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns null when the video is still processing (not status 'done')", async () => {
    const result = await downloadAndStoreRecordingVideo(
      recording({
        media_shortcuts: {
          video_mixed: { status: { code: "processing" }, data: { download_url: "https://x" } },
        },
      }),
      "job-1",
      config,
    );
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("downloads the video and uploads it to our own S3, returning the key", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => bytes,
    });
    uploadFile.mockResolvedValue("bucket/recall-videos/job-1.mp4");

    const result = await downloadAndStoreRecordingVideo(recording(), "job-1", config);

    expect(global.fetch).toHaveBeenCalledWith("https://recall.example/video.mp4");
    expect(uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      "recall-videos/job-1.mp4",
      config,
      { contentType: "video/mp4" },
      undefined,
      undefined,
      true,
    );
    expect(result).toBe("bucket/recall-videos/job-1.mp4");
  });

  it("throws a clear error when the download itself fails", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 403 });

    await expect(
      downloadAndStoreRecordingVideo(recording(), "job-1", config),
    ).rejects.toThrow(/403/);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("treats an absent status as ready (older payloads predate status reporting)", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    });
    uploadFile.mockResolvedValue("bucket/recall-videos/job-2.mp4");

    const result = await downloadAndStoreRecordingVideo(
      recording({
        media_shortcuts: {
          video_mixed: { data: { download_url: "https://recall.example/video.mp4" } },
        },
      }),
      "job-2",
      config,
    );
    expect(result).toBe("bucket/recall-videos/job-2.mp4");
  });
});
