/**
 * Speech-to-text via the LiteLLM proxy's /v1/audio/transcriptions endpoint.
 *
 * Design doc: docs/superpowers/specs/2026-05-24-speech-to-text-transcription-design.md
 *
 * The caller (the /transcribe route) is responsible for feature-gate checks,
 * authentication, file validation, and waiting for the LiteLLM supervisor to
 * be ready. This module just forwards a parsed multipart file upstream.
 */

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
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  const model = process.env.TRANSCRIPTION_MODEL;

  if (!masterKey) throw new Error("LITELLM_MASTER_KEY is not set");
  if (!model) throw new Error("TRANSCRIPTION_MODEL is not set");

  const form = new FormData();
  form.append(
    "file",
    new Blob([args.file.buffer], { type: args.file.mimetype }),
    args.file.originalname,
  );
  form.append("model", model);
  if (args.language) form.append("language", args.language);

  const res = await fetch(`http://${host}:${port}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${masterKey}` },
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
