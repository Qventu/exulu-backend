# Gemini-via-chat STT for the composer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat composer's speech-to-text work with a GCP model by transcribing short clips through Vertex **Gemini chat completions** (`input_audio`) instead of LiteLLM's `/audio/transcriptions` endpoint, which has no Vertex support.

**Architecture:** `transcribe.ts` looks up `TRANSCRIPTION_MODEL` in the LiteLLM catalog and routes: a Gemini/Vertex upstream → `POST /v1/chat/completions` with an audio part; anything else (whisper, deepgram) → the existing `/audio/transcriptions` path. The `input_audio.format` is derived from the upload's mimetype — verification (Task 1) confirmed Vertex Gemini accepts the browser's native `webm`/`mp4` directly, so **no client-side conversion and no frontend change are needed**. No new env var, no route/GraphQL change. Backend-only.

**Tech Stack:** TypeScript, Node 22, backend tests in **jest** (`npm test`, `@SRC/*` path alias), frontend tests in **vitest** (`vitest run`, colocated `*.test.ts`), `tsx` for repro scripts, WebAudio (`AudioContext` / `OfflineAudioContext`) in the browser.

**Spec:** [docs/superpowers/specs/2026-08-03-gemini-chat-transcription-design.md](../specs/2026-08-03-gemini-chat-transcription-design.md)

## Global Constraints

- **No new env var.** Routing is decided from LiteLLM catalog metadata only.
- **Backwards compatible.** The `/transcribe` route, gating (`EXULU_USE_LITELLM=true` **and** `TRANSCRIPTION_MODEL` set), 25 MB multer limit, `TranscriptionError(status, body)`, and the `{ text }` response shape are unchanged. Existing whisper deployments (selise) keep using `/audio/transcriptions`.
- **Catalog-miss fallback:** if `findLiteLLMModel()` returns `undefined` or throws, use the audio endpoint (today's behavior).
- **Two repos:** backend = `/Users/daniel.claessen/Desktop/Projects/exulu/backend`; frontend = `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`; newlkiag config = `/Users/daniel.claessen/Desktop/Projects/newlkiag/config.litellm.yaml`. Do code changes on a feature branch/worktree, not on `develop`/`main` directly.
- **`reasoning_effort: "disable"`** on every chat transcription request (Gemini thinking-token starvation guard).
- **System prompt (verbatim, reused everywhere):**
  `You are a speech-to-text transcription engine. Detect the language actually spoken and transcribe it word-for-word in that same language. Never translate. Output only the transcript text — no quotes, labels, or commentary. If there is no intelligible speech, output nothing.`

---

### Task 1: Verify-first repro (decision gate) — ✅ DONE 2026-08-03

**Result:** Against the real newlkiag upstream `vertex_ai/gemini-3.5-flash` (via local LiteLLM :4000), `webm/opus`, `mp4/aac`, `wav`, and `ogg` **all returned the exact verbatim transcript** with `reasoning_effort: "disable"` + `temperature: 0` and the system prompt below. The `webm` sample was a genuine opus-in-webm clip (encoded via the backend's bundled PyAV). **Conclusion: no audio conversion is needed — Tasks 4 & 5 are dropped, the composer is unchanged.** The backend derives `input_audio.format` from the upload mimetype.

The original repro procedure is retained below for reference.

Confirm whether `webm` needs conversion and that the `input_audio` + `reasoning_effort: "disable"` request shape returns clean text from Gemini through local LiteLLM.

**Files:**
- Create (throwaway, not committed): `backend/scripts/repro-transcribe-gemini.ts`

**Prerequisites (manual):** a local LiteLLM proxy running with a Vertex Gemini model registered as `gemini-transcribe` (`model: vertex_ai/gemini-2.5-flash`, `dx-newlift`, location `eu`) and Vertex creds available; two short sample clips of the same speech — `sample.webm` and `sample.wav`.

- [ ] **Step 1: Write the repro script**

```ts
// npx tsx scripts/repro-transcribe-gemini.ts <path-to-audio> [model-name]
import { readFileSync } from "node:fs";

const [, , audioPath, model = "gemini-transcribe"] = process.argv;
if (!audioPath) throw new Error("usage: repro-transcribe-gemini.ts <audio> [model]");

const host = process.env.LITELLM_HOST ?? "127.0.0.1";
const port = process.env.LITELLM_PORT ?? "4000";
const key = process.env.LITELLM_MASTER_KEY ?? "";
const buf = readFileSync(audioPath);
const ext = (audioPath.split(".").pop() ?? "").toLowerCase();
const format = ext === "m4a" ? "mp4" : ext; // input_audio "format"

const body = {
  model,
  temperature: 0,
  reasoning_effort: "disable",
  messages: [
    {
      role: "system",
      content:
        "You are a speech-to-text transcription engine. Detect the language actually spoken and transcribe it word-for-word in that same language. Never translate. Output only the transcript text — no quotes, labels, or commentary. If there is no intelligible speech, output nothing.",
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Transcribe this audio." },
        { type: "input_audio", input_audio: { data: buf.toString("base64"), format } },
      ],
    },
  ],
};

const res = await fetch(`http://${host}:${port}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify(body),
});
console.log("format:", format, "status:", res.status);
console.log(await res.text());
```

- [ ] **Step 2: Run against the WAV sample**

Run: `LITELLM_MASTER_KEY=<key> npx tsx scripts/repro-transcribe-gemini.ts ./sample.wav gemini-transcribe`
Expected: `status: 200` and `choices[0].message.content` containing the spoken words (verbatim, no commentary). Confirms the chat request shape works.

- [ ] **Step 3: Run against the WEBM sample**

Run: `LITELLM_MASTER_KEY=<key> npx tsx scripts/repro-transcribe-gemini.ts ./sample.webm gemini-transcribe`
Expected: either a 400 "Unsupported MIME type" (→ WAV conversion IS needed; do Tasks 4–5) **or** a clean 200 transcript (→ record the finding; Tasks 4–5 may be skipped). **Record the outcome in the plan before proceeding.**

- [ ] **Step 4: Delete the throwaway script**

```bash
rm backend/scripts/repro-transcribe-gemini.ts
```

No commit for this task (verification only).

---

### Task 2: Backend pure helpers (routing decision + transcript cleanup)

**Files:**
- Modify: `backend/src/exulu/transcribe.ts` (add two exported pure functions + system-prompt constant)
- Test: `backend/src/exulu/transcribe.test.ts` (create)

**Interfaces:**
- Produces: `isGeminiChatTranscriptionModel(entry: { upstream_model: string | null } | undefined): boolean`
- Produces: `cleanTranscript(raw: string | null | undefined): string`
- Produces: `TRANSCRIBE_SYSTEM_PROMPT: string`

- [ ] **Step 1: Write the failing tests**

```ts
// backend/src/exulu/transcribe.test.ts
import { isGeminiChatTranscriptionModel, cleanTranscript } from "./transcribe";

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- transcribe.test.ts`
Expected: FAIL — `isGeminiChatTranscriptionModel`/`cleanTranscript` are not exported.

- [ ] **Step 3: Add the helpers to `transcribe.ts`**

Add near the top of `backend/src/exulu/transcribe.ts` (after the imports):

```ts
export const TRANSCRIBE_SYSTEM_PROMPT =
  "You are a speech-to-text transcription engine. Detect the language actually spoken " +
  "and transcribe it word-for-word in that same language. Never translate. Output only " +
  "the transcript text — no quotes, labels, or commentary. If there is no intelligible " +
  "speech, output nothing.";

/**
 * True when TRANSCRIPTION_MODEL resolves to a Vertex Gemini chat model, which
 * accepts audio via /v1/chat/completions. Whisper/Deepgram/Chirp all return
 * false → they use the /audio/transcriptions path. Chirp is deliberately
 * excluded: it is not a chat model and LiteLLM cannot transcribe it at all.
 */
export function isGeminiChatTranscriptionModel(
  entry: { upstream_model: string | null } | undefined,
): boolean {
  const upstream = entry?.upstream_model ?? "";
  return /^vertex_ai\//i.test(upstream) && /gemini/i.test(upstream);
}

/** Normalises a Gemini transcript: trims and strips one pair of wrapping quotes. */
export function cleanTranscript(raw: string | null | undefined): string {
  let text = (raw ?? "").trim();
  const wrapped = text.match(/^(["'`])([\s\S]*)\1$/);
  if (wrapped) text = wrapped[2].trim();
  return text;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- transcribe.test.ts`
Expected: PASS (8 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/transcribe.ts src/exulu/transcribe.test.ts
git commit -m "feat(transcribe): pure helpers for Gemini STT routing + transcript cleanup"
```

---

### Task 3: Backend chat transcription path + routing wire-up

Split the existing multipart logic into `transcribeViaAudioEndpoint`, add `transcribeViaChat`, and branch `transcribeAudio` on the catalog lookup.

**Files:**
- Modify: `backend/src/exulu/transcribe.ts`
- Test: `backend/src/exulu/transcribe.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveLiteLLMTarget()` from `./litellm/env` (already imported) → `{ baseUrl, authHeaders }`.
- Consumes: `findLiteLLMModel(model)` from `./litellm/catalog` → `Promise<LiteLLMCatalogEntry | undefined>` (has `.upstream_model`).
- Consumes: `isGeminiChatTranscriptionModel`, `cleanTranscript`, `TRANSCRIBE_SYSTEM_PROMPT` (Task 2).
- Produces: unchanged public `transcribeAudio(args): Promise<{ text: string }>`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to backend/src/exulu/transcribe.test.ts
import { transcribeAudio, TranscriptionError } from "./transcribe";

jest.mock("./litellm/catalog", () => ({
  findLiteLLMModel: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findLiteLLMModel } = require("./litellm/catalog") as { findLiteLLMModel: jest.Mock };

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
    findLiteLLMModel.mockReset();
  });
  afterEach(() => { global.fetch = realFetch; });

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
      ok: false, status: 500, text: async () => "boom",
    }) as unknown as typeof fetch;

    await expect(transcribeAudio(audioArgs())).rejects.toBeInstanceOf(TranscriptionError);
  });

  it("derives the input_audio format from the upload mimetype (webm/opus)", async () => {
    findLiteLLMModel.mockResolvedValue({ upstream_model: "vertex_ai/gemini-2.5-flash" });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await transcribeAudio({
      file: { buffer: Buffer.from("a"), originalname: "recording.webm", mimetype: "audio/webm;codecs=opus" },
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[1].content[1].input_audio.format).toBe("webm");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- transcribe.test.ts`
Expected: FAIL — routing still always posts multipart to `/audio/transcriptions`.

- [ ] **Step 3: Refactor `transcribeAudio` and add the chat path**

In `backend/src/exulu/transcribe.ts`: add the import, rename the current body into `transcribeViaAudioEndpoint`, add `transcribeViaChat`, and make `transcribeAudio` the router.

```ts
import { resolveLiteLLMTarget, type LiteLLMTarget } from "./litellm/env";
import { findLiteLLMModel } from "./litellm/catalog";

type TranscribeArgs = {
  file: { buffer: Buffer; originalname: string; mimetype: string };
  language?: string;
};

export async function transcribeAudio(args: TranscribeArgs): Promise<{ text: string }> {
  const target = resolveLiteLLMTarget();
  const model = process.env.TRANSCRIPTION_MODEL;
  if (!model) throw new Error("TRANSCRIPTION_MODEL is not set");

  const entry = await findLiteLLMModel(model).catch(() => undefined);
  if (isGeminiChatTranscriptionModel(entry)) {
    return transcribeViaChat(args, target, model);
  }
  return transcribeViaAudioEndpoint(args, target, model);
}

/** Existing behaviour: multipart upload to LiteLLM /v1/audio/transcriptions. */
async function transcribeViaAudioEndpoint(
  args: TranscribeArgs,
  target: LiteLLMTarget,
  model: string,
): Promise<{ text: string }> {
  const form = new FormData();
  form.append("file", new Blob([args.file.buffer], { type: args.file.mimetype }), args.file.originalname);
  form.append("model", model);
  if (args.language) form.append("language", args.language);

  const res = await fetch(`${target.baseUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { ...target.authHeaders },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TranscriptionError(res.status, `LiteLLM transcription failed (status ${res.status}): ${body}`.trim());
  }
  const json = (await res.json()) as { text?: string };
  return { text: typeof json.text === "string" ? json.text : "" };
}

/** Gemini path: send audio as an input_audio part to /v1/chat/completions. */
async function transcribeViaChat(
  args: TranscribeArgs,
  target: LiteLLMTarget,
  model: string,
): Promise<{ text: string }> {
  const subtype = args.file.mimetype.replace(/^audio\//, "").split(";")[0];
  const format = (subtype && subtype.length > 0 ? subtype : "wav").toLowerCase();
  // No language hint: the composer's UI locale (often "en") nudged Gemini into
  // translating non-English speech. Rely on auto-detection + the never-translate prompt.
  const body = {
    model,
    temperature: 0,
    reasoning_effort: "disable",
    messages: [
      { role: "system", content: TRANSCRIBE_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this audio." },
          { type: "input_audio", input_audio: { data: args.file.buffer.toString("base64"), format } },
        ],
      },
    ],
  };

  const res = await fetch(`${target.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { ...target.authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new TranscriptionError(res.status, `LiteLLM transcription failed (status ${res.status}): ${errBody}`.trim());
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return { text: cleanTranscript(json.choices?.[0]?.message?.content) };
}
```

Delete the old inline body of `transcribeAudio` (the original `FormData`/`fetch` block) — it now lives in `transcribeViaAudioEndpoint`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- transcribe.test.ts`
Expected: PASS (all Task 2 + Task 3 tests).

- [ ] **Step 5: Type-check**

Run: `npm run type-check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/exulu/transcribe.ts src/exulu/transcribe.test.ts
git commit -m "feat(transcribe): route Gemini STT through /chat/completions with audio input"
```

---

### Task 4: Frontend WAV encoder + re-encode util — ❌ DROPPED (Task 1 proved webm works)

> **Do not implement.** Verification showed Vertex Gemini accepts the browser's native `webm`/`mp4`
> directly, so no client-side conversion is needed. The code below is kept only as the documented
> escape-hatch reference (see spec §3). **Skip to Task 6.**

**Files:**
- Create: `frontend/app/(application)/chat/components/audio-to-wav.ts`
- Test: `frontend/app/(application)/chat/components/audio-to-wav.test.ts`

**Interfaces:**
- Produces: `encodeWavPcm16(samples: Float32Array, sampleRate: number): ArrayBuffer`
- Produces: `reencodeToWavMono16k(blob: Blob): Promise<Blob>` (browser-only; decode/resample not unit-tested)

- [ ] **Step 1: Write the failing test (pure encoder)**

```ts
// frontend/app/(application)/chat/components/audio-to-wav.test.ts
import { describe, it, expect } from "vitest";
import { encodeWavPcm16 } from "./audio-to-wav";

describe("encodeWavPcm16", () => {
  it("writes a valid 16kHz mono PCM16 WAV header", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const buf = encodeWavPcm16(samples, 16000);
    const view = new DataView(buf);
    const str = (o: number, n: number) =>
      String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(o + i)));

    expect(str(0, 4)).toBe("RIFF");
    expect(str(8, 4)).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(buf.byteLength).toBe(44 + samples.length * 2);
  });

  it("clamps out-of-range samples", () => {
    const buf = encodeWavPcm16(new Float32Array([2, -2]), 16000);
    const view = new DataView(buf);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `frontend/`): `npx vitest run app/\(application\)/chat/components/audio-to-wav.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the util**

```ts
// frontend/app/(application)/chat/components/audio-to-wav.ts

/** Encode mono Float32 PCM samples as a 16-bit PCM WAV ArrayBuffer. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = rate * blockAlign
  view.setUint16(32, 2, true); // block align = channels * bytesPerSample
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buffer;
}

/**
 * Decode a recorded audio blob and re-encode it to 16 kHz mono WAV — the
 * format Gemini accepts (it rejects webm). Throws on decode failure so the
 * caller can fall back to the original blob.
 */
export async function reencodeToWavMono16k(blob: Blob): Promise<Blob> {
  const AudioCtx =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const arrayBuf = await blob.arrayBuffer();
  const decodeCtx = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    void decodeCtx.close();
  }
  const targetRate = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return new Blob([encodeWavPcm16(rendered.getChannelData(0), targetRate)], { type: "audio/wav" });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `frontend/`): `npx vitest run app/\(application\)/chat/components/audio-to-wav.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/(application)/chat/components/audio-to-wav.ts" "app/(application)/chat/components/audio-to-wav.test.ts"
git commit -m "feat(composer): 16kHz-mono WAV re-encode util for Gemini STT"
```

---

### Task 5: Wire WAV re-encode into the composer — ❌ DROPPED (Task 1 proved webm works)

> **Do not implement.** The composer is unchanged. Kept only as escape-hatch reference. **Skip to Task 6.**

**Files:**
- Modify: `frontend/app/(application)/chat/components/composer.tsx` (`handleRecordingStop`, ~line 372–390; add import near the other component imports)

**Interfaces:**
- Consumes: `reencodeToWavMono16k` (Task 4).

- [ ] **Step 1: Add the import**

Near the top of `composer.tsx`, with the other local imports:

```ts
import { reencodeToWavMono16k } from "./audio-to-wav";
```

- [ ] **Step 2: Re-encode before building the FormData**

In `handleRecordingStop`, replace the block that builds `formData` (currently):

```ts
    setRecordingState("transcribing");
    const formData = new FormData();
    formData.append("file", blob, `recording.${ext}`);
```

with:

```ts
    setRecordingState("transcribing");

    // Gemini STT only accepts wav/ogg/etc. (not webm), so re-encode to
    // 16kHz-mono WAV client-side. Whisper accepts WAV too, so this is safe for
    // every backend. Fall back to the raw recording if decoding fails.
    let uploadBlob: Blob = blob;
    let filename = `recording.${ext}`;
    try {
      uploadBlob = await reencodeToWavMono16k(blob);
      filename = "recording.wav";
    } catch {
      // exotic codec / decode failure → upload the original and let the backend try
    }

    const formData = new FormData();
    formData.append("file", uploadBlob, filename);
```

(The existing `if (locale) formData.append("language", locale);` line stays directly after.)

- [ ] **Step 3: Type-check / build the frontend**

Run (from `frontend/`): `npx tsc --noEmit`
Expected: no new errors from `composer.tsx`.

- [ ] **Step 4: Commit**

```bash
git add "app/(application)/chat/components/composer.tsx"
git commit -m "feat(composer): re-encode recordings to WAV before transcription upload"
```

---

### Task 6: newlkiag config change — mostly DONE (needs proxy restart + smoke test)

**Status:** The user already edited `config.litellm.yaml` to `model_name: gemini-transcribe` →
`model: vertex_ai/gemini-3.5-flash` (type `speech_to_text`), and set
`TRANSCRIPTION_MODEL=gemini-transcribe` + `EXULU_USE_LITELLM=true`. The **running** LiteLLM proxy
on :4000 still shows the old `chirp3` entry, so it must be **restarted** to load the rename.

**Files:**
- Already modified: `/Users/daniel.claessen/Desktop/Projects/newlkiag/config.litellm.yaml`

- [ ] **Step 1: Restart the LiteLLM proxy** so `/v1/models` lists `gemini-transcribe` (not `chirp3`).

Verify: `curl -s http://127.0.0.1:4000/v1/models -H "Authorization: Bearer $KEY"` includes `gemini-transcribe`.

- [ ] **Step 2: Smoke-test the composer**

Record a short clip in the composer (Chrome **and** Safari); confirm German + English clips
transcribe, the model does **not** appear in the inference model picker, and a LiteLLM spend-log
row is written for `gemini-transcribe`.

Commit any further config tweaks in the newlkiag repo per its own conventions.

---

## Self-Review

**Spec coverage:**
- Root cause / approach → Tasks 2–3 (routing + chat path). ✓
- Routing by config metadata, no env var, catalog-miss fallback → Task 2 (`isGeminiChatTranscriptionModel`) + Task 3 (wiring, fallback test). ✓
- Chat request shape (input_audio, system prompt, `reasoning_effort: "disable"`, temperature 0, response cleanup) → Task 3 + Task 2 (`cleanTranscript`). ✓
- Audio format, verify-first → Task 1 (DONE: webm/mp4/wav/ogg all work → conversion dropped, Tasks 4–5 not implemented; format derived from mimetype in Task 3). ✓
- Config change → Task 6. ✓
- Error handling (non-200 → TranscriptionError, silent → empty, decode fallback) → Task 3 tests + Task 5 fallback. ✓
- **Deviation from spec (Section 5):** the "`supports_audio_input` false → fail fast" guard is intentionally **dropped**. `supports_audio_input` is an optional config field that authors frequently leave unset (→ `false`), which would wrongly reject valid Gemini models; a Gemini upstream inherently supports audio, so the upstream-match rule already carries that guarantee. A genuinely mis-pointed model surfaces as a normal `TranscriptionError` from the Gemini 4xx.

**Placeholder scan:** no TBD/TODO; every code step has full code. ✓

**Type consistency:** `transcribeViaChat` / `transcribeViaAudioEndpoint` / `transcribeAudio` signatures, `LiteLLMTarget`, `TranscribeArgs`, `encodeWavPcm16`, `reencodeToWavMono16k` names match across tasks. ✓
