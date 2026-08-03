import {
  isGeminiChatTranscriptionModel,
  cleanTranscript,
  transcribeAudio,
  TranscriptionError,
} from "./transcribe";

jest.mock("./litellm/catalog", () => ({
  findLiteLLMModel: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findLiteLLMModel } = require("./litellm/catalog") as { findLiteLLMModel: jest.Mock };

describe("isGeminiChatTranscriptionModel", () => {
  it("is true for a vertex gemini upstream", () => {
    expect(isGeminiChatTranscriptionModel({ upstream_model: "vertex_ai/gemini-2.5-flash" })).toBe(true);
  });
  it("is false for whisper", () => {
    expect(isGeminiChatTranscriptionModel({ upstream_model: "whisper-1" })).toBe(false);
  });
  it("is false for vertex chirp (not a chat model)", () => {
    expect(isGeminiChatTranscriptionModel({ upstream_model: "vertex_ai/chirp-3" })).toBe(false);
  });
  it("is false for a non-gemini vertex model", () => {
    expect(isGeminiChatTranscriptionModel({ upstream_model: "vertex_ai/qwen/qwen3-235b" })).toBe(false);
  });
  it("is false for undefined / null upstream", () => {
    expect(isGeminiChatTranscriptionModel(undefined)).toBe(false);
    expect(isGeminiChatTranscriptionModel({ upstream_model: null })).toBe(false);
  });
});

describe("cleanTranscript", () => {
  it("trims whitespace", () => {
    expect(cleanTranscript("  hallo welt \n")).toBe("hallo welt");
  });
  it("strips a single pair of surrounding quotes", () => {
    expect(cleanTranscript('"hallo welt"')).toBe("hallo welt");
    expect(cleanTranscript("`hallo`")).toBe("hallo");
  });
  it("returns empty string for null/undefined/blank", () => {
    expect(cleanTranscript(null)).toBe("");
    expect(cleanTranscript(undefined)).toBe("");
    expect(cleanTranscript("   ")).toBe("");
  });
});

const audioArgs = () => ({
  file: { buffer: Buffer.from("fake-audio"), originalname: "recording.wav", mimetype: "audio/wav" },
  language: "de",
});

describe("transcribeAudio routing", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.TRANSCRIPTION_MODEL = "gemini-transcribe";
    process.env.LITELLM_HOST = "127.0.0.1";
    process.env.LITELLM_PORT = "4000";
    process.env.LITELLM_MASTER_KEY = "sk-test";
    delete process.env.LITELLM_BASE_URL;
    findLiteLLMModel.mockReset();
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("routes a gemini model to /chat/completions and cleans the content", async () => {
    findLiteLLMModel.mockResolvedValue({ upstream_model: "vertex_ai/gemini-2.5-flash" });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '"hallo welt"' } }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await transcribeAudio(audioArgs());

    expect(out).toEqual({ text: "hallo welt" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:4000/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gemini-transcribe");
    expect(body.reasoning_effort).toBe("disable");
    expect(body.messages[1].content[1]).toEqual({
      type: "input_audio",
      input_audio: { data: Buffer.from("fake-audio").toString("base64"), format: "wav" },
    });
    // The UI locale must NOT be injected as a language hint — doing so nudged
    // Gemini into translating (e.g. German speech → English) despite language "de".
    expect(body.messages[1].content[0].text).toBe("Transcribe this audio.");
    expect(body.messages[0].content).toMatch(/never translate/i);
  });

  it("routes a whisper model to /audio/transcriptions", async () => {
    findLiteLLMModel.mockResolvedValue({ upstream_model: "whisper-1" });
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ text: "hallo" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await transcribeAudio(audioArgs());

    expect(out).toEqual({ text: "hallo" });
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:4000/v1/audio/transcriptions");
  });

  it("falls back to /audio/transcriptions when the catalog lookup fails", async () => {
    findLiteLLMModel.mockRejectedValue(new Error("catalog down"));
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ text: "x" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await transcribeAudio(audioArgs());

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:4000/v1/audio/transcriptions");
  });

  it("throws TranscriptionError on a non-200 chat response", async () => {
    findLiteLLMModel.mockResolvedValue({ upstream_model: "vertex_ai/gemini-2.5-flash" });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    }) as unknown as typeof fetch;

    await expect(transcribeAudio(audioArgs())).rejects.toBeInstanceOf(TranscriptionError);
  });

  it("derives the input_audio format from the upload mimetype (webm/opus)", async () => {
    findLiteLLMModel.mockResolvedValue({ upstream_model: "vertex_ai/gemini-2.5-flash" });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await transcribeAudio({
      file: { buffer: Buffer.from("a"), originalname: "recording.webm", mimetype: "audio/webm;codecs=opus" },
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[1].content[1].input_audio.format).toBe("webm");
  });
});
