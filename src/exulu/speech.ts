/**
 * Text-to-speech via the LiteLLM proxy's /v1/audio/speech endpoint.
 *
 * Design doc: docs/superpowers/specs/2026-05-25-text-to-speech-design.md
 *
 * The caller (the /speech route) is responsible for feature-gate checks,
 * authentication, text validation, and waiting for the LiteLLM supervisor to
 * be ready. This module just forwards a text string upstream and returns the
 * MP3 bytes.
 */

export class SpeechError extends Error {
  constructor(
    public readonly upstreamStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "SpeechError";
  }
}

export async function synthesizeSpeech(args: {
  text: string;
}): Promise<Buffer> {
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  const model = process.env.TTS_MODEL;
  const voice = process.env.TTS_VOICE;

  if (!masterKey) throw new Error("LITELLM_MASTER_KEY is not set");
  if (!model) throw new Error("TTS_MODEL is not set");
  // LiteLLM's router requires `voice` even when the upstream provider doesn't
  // strictly need one — without it, /v1/audio/speech 500s with
  // "Router.aspeech() missing 1 required positional argument: 'voice'".
  if (!voice) throw new Error("TTS_VOICE is not set");

  const body: Record<string, unknown> = {
    model,
    input: args.text,
    voice,
    response_format: "mp3",
  };

  const res = await fetch(`http://${host}:${port}/v1/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${masterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SpeechError(
      res.status,
      `LiteLLM speech failed (status ${res.status}): ${text}`.trim(),
    );
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}
