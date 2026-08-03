/**
 * Speech-to-text via the LiteLLM proxy's /v1/audio/transcriptions endpoint.
 *
 * Design doc: docs/superpowers/specs/2026-05-24-speech-to-text-transcription-design.md
 *
 * The caller (the /transcribe route) is responsible for feature-gate checks,
 * authentication, file validation, and waiting for the LiteLLM supervisor to
 * be ready. This module just forwards a parsed multipart file upstream.
 */

import { resolveLiteLLMTarget, type LiteLLMTarget } from "./litellm/env";
import { findLiteLLMModel } from "./litellm/catalog";

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
  if (wrapped) text = (wrapped[2] ?? "").trim();
  return text;
}

export class TranscriptionError extends Error {
  constructor(
    public readonly upstreamStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

type TranscribeArgs = {
  file: { buffer: Buffer; originalname: string; mimetype: string };
  // ISO-639-1 language code (e.g. "de", "en"). When omitted the model
  // auto-detects, which is unreliable on short clips — pass the user's UI
  // locale from the client whenever possible.
  language?: string;
};

/**
 * Transcribe an audio upload via LiteLLM. Routes on the configured
 * TRANSCRIPTION_MODEL: a Vertex Gemini chat model goes through
 * /v1/chat/completions (audio as an input_audio part); everything else
 * (whisper, deepgram, …) uses the /v1/audio/transcriptions endpoint. A failed
 * catalog lookup falls back to the audio endpoint (unchanged legacy behaviour).
 */
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

/** Legacy path: multipart upload to LiteLLM /v1/audio/transcriptions (whisper etc.). */
async function transcribeViaAudioEndpoint(
  args: TranscribeArgs,
  target: LiteLLMTarget,
  model: string,
): Promise<{ text: string }> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([args.file.buffer], { type: args.file.mimetype }),
    args.file.originalname,
  );
  form.append("model", model);
  if (args.language) form.append("language", args.language);

  const res = await fetch(`${target.baseUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { ...target.authHeaders },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TranscriptionError(
      res.status,
      `LiteLLM transcription failed (status ${res.status}): ${body}`.trim(),
    );
  }

  const json = (await res.json()) as { text?: string };
  return { text: typeof json.text === "string" ? json.text : "" };
}

/**
 * Gemini path: send the audio as an input_audio part to /v1/chat/completions.
 * Vertex Gemini accepts the browser's native webm/mp4 directly (verified), so
 * the format is derived from the upload mimetype — no conversion needed.
 */
async function transcribeViaChat(
  args: TranscribeArgs,
  target: LiteLLMTarget,
  model: string,
): Promise<{ text: string }> {
  // e.g. "audio/webm;codecs=opus" → "webm"; empty/unknown → "wav".
  const subtype = args.file.mimetype.replace(/^audio\//, "").split(";")[0];
  const format = (subtype && subtype.length > 0 ? subtype : "wav").toLowerCase();
  // NB: deliberately no language hint. The composer sends the user's UI locale,
  // which is often "en" even when the speaker uses another language — passing it
  // as an authoritative hint nudged Gemini into translating German speech to
  // English. Gemini auto-detects the spoken language; the system prompt forbids
  // translation. (args.language stays meaningful only for the whisper path.)
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
          {
            type: "input_audio",
            input_audio: { data: args.file.buffer.toString("base64"), format },
          },
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
    throw new TranscriptionError(
      res.status,
      `LiteLLM transcription failed (status ${res.status}): ${errBody}`.trim(),
    );
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return { text: cleanTranscript(json.choices?.[0]?.message?.content) };
}
