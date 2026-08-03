/**
 * Speech-to-text via the LiteLLM proxy's /v1/audio/transcriptions endpoint.
 *
 * Design doc: docs/superpowers/specs/2026-05-24-speech-to-text-transcription-design.md
 *
 * The caller (the /transcribe route) is responsible for feature-gate checks,
 * authentication, file validation, and waiting for the LiteLLM supervisor to
 * be ready. This module just forwards a parsed multipart file upstream.
 */

import { resolveLiteLLMTarget } from "./litellm/env";

export const TRANSCRIBE_SYSTEM_PROMPT =
  "You are an automatic speech recognition engine. Transcribe the audio verbatim in " +
  "its original language. Output only the transcript text — no quotes, labels, " +
  "commentary, or translation. If there is no intelligible speech, output nothing.";

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

export async function transcribeAudio(args: {
  file: { buffer: Buffer; originalname: string; mimetype: string };
  // ISO-639-1 language code (e.g. "de", "en"). When omitted Whisper
  // auto-detects, which is unreliable on short clips — pass the user's UI
  // locale from the client whenever possible.
  language?: string;
}): Promise<{ text: string }> {
  const { baseUrl, authHeaders } = resolveLiteLLMTarget();
  const model = process.env.TRANSCRIPTION_MODEL;

  if (!model) throw new Error("TRANSCRIPTION_MODEL is not set");

  const form = new FormData();
  form.append(
    "file",
    new Blob([args.file.buffer], { type: args.file.mimetype }),
    args.file.originalname,
  );
  form.append("model", model);
  if (args.language) form.append("language", args.language);

  const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { ...authHeaders },
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
