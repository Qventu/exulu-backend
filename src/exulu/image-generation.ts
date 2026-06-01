/**
 * Image generation + edit via the LiteLLM proxy's OpenAI-compatible
 * /v1/images/generations and /v1/images/edits endpoints.
 *
 * LiteLLM exposes both endpoints for any configured model with
 * `model_info.type: image_generation`. See
 * https://docs.litellm.ai/docs/image_generation and
 * https://docs.litellm.ai/docs/image_edits for the request/response schemas.
 *
 * Responses carry either a `url` or a base64-encoded `b64_json` per result
 * entry depending on the upstream provider (Azure gpt-image-1 returns
 * b64_json by default; OpenAI DALL-E returns url unless response_format is
 * forced to b64_json). This module normalizes both into a Buffer + content-
 * type per generated image so the calling route can just upload to S3.
 *
 * Both helpers return an array of the same length as the requested `n`, so
 * the persistence layer can store aligned arrays of S3 keys and revised
 * prompts.
 */

export class ImageGenerationError extends Error {
  constructor(
    public readonly upstreamStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

export type GeneratedImage = {
  buffer: Buffer;
  contentType: string;
  extension: string;
  revisedPrompt?: string;
};

type ProxyConfig = { host: string; port: string; masterKey: string };

const resolveProxyConfig = (): ProxyConfig => {
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  if (!masterKey) throw new Error("LITELLM_MASTER_KEY is not set");
  return { host, port, masterKey };
};

const normalizeDataEntries = async (
  data: { b64_json?: string; url?: string; revised_prompt?: string }[],
): Promise<GeneratedImage[]> => {
  const out: GeneratedImage[] = [];
  for (const entry of data) {
    let buffer: Buffer;
    let contentType = "image/png";
    let extension = "png";

    if (entry.b64_json) {
      buffer = Buffer.from(entry.b64_json, "base64");
    } else if (entry.url) {
      const upstream = await fetch(entry.url);
      if (!upstream.ok) {
        throw new ImageGenerationError(
          upstream.status,
          `Failed to download generated image from ${entry.url}: ${upstream.status} ${upstream.statusText}`,
        );
      }
      const ct = upstream.headers.get("content-type");
      if (ct && ct.startsWith("image/")) {
        contentType = ct;
        const inferred = ct.split("/")[1]?.split(";")[0]?.trim();
        if (inferred) extension = inferred === "jpeg" ? "jpg" : inferred;
      }
      buffer = Buffer.from(await upstream.arrayBuffer());
    } else {
      throw new ImageGenerationError(
        0,
        "LiteLLM image response entry contained neither b64_json nor url.",
      );
    }

    out.push({ buffer, contentType, extension, revisedPrompt: entry.revised_prompt });
  }
  return out;
};

export async function generateImage(args: {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  signal?: AbortSignal;
}): Promise<GeneratedImage[]> {
  if (!args.model) throw new Error("model is required");
  if (!args.prompt) throw new Error("prompt is required");

  const cfg = resolveProxyConfig();

  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
  };
  if (args.size) body.size = args.size;
  if (args.quality) body.quality = args.quality;
  if (args.n) body.n = args.n;

  const res = await fetch(`http://${cfg.host}:${cfg.port}/v1/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.masterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: args.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ImageGenerationError(
      res.status,
      `LiteLLM image generation failed (status ${res.status}): ${text}`.trim(),
    );
  }

  const json = (await res.json()) as {
    data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
  };
  if (!json?.data || json.data.length === 0) {
    throw new ImageGenerationError(
      res.status,
      "LiteLLM returned no image data in the response.",
    );
  }

  return normalizeDataEntries(json.data);
}

/**
 * Edit one or more reference images with a prompt via LiteLLM's
 * /v1/images/edits multipart endpoint. The caller passes already-loaded
 * Buffers (the route handler fetches them from S3 first and validates
 * ownership) so this module stays free of S3 awareness.
 */
export async function editImage(args: {
  model: string;
  prompt: string;
  // Each ref is a Buffer + a filename hint used in the multipart Content-
  // Disposition. LiteLLM/OpenAI infer image type from the filename, so a
  // truthful extension matters more than a "real" filename.
  references: { buffer: Buffer; filename: string; mimetype?: string }[];
  mask?: { buffer: Buffer; filename: string; mimetype?: string };
  n?: number;
  size?: string;
  quality?: string;
  signal?: AbortSignal;
}): Promise<GeneratedImage[]> {
  if (!args.model) throw new Error("model is required");
  if (!args.prompt) throw new Error("prompt is required");
  if (!args.references || args.references.length === 0) {
    throw new Error("at least one reference image is required");
  }

  const cfg = resolveProxyConfig();

  const form = new FormData();
  form.append("model", args.model);
  form.append("prompt", args.prompt);
  if (args.n != null) form.append("n", String(args.n));
  if (args.size) form.append("size", args.size);
  if (args.quality) form.append("quality", args.quality);
  // Prefer b64_json so we don't need to download a second time — saves a
  // round-trip and avoids the presigned-URL expiry edge case some providers
  // hit when their own download URLs expire faster than ours.
  form.append("response_format", "b64_json");

  for (const ref of args.references) {
    form.append(
      "image",
      new Blob([ref.buffer], { type: ref.mimetype ?? "image/png" }),
      ref.filename,
    );
  }
  if (args.mask) {
    form.append(
      "mask",
      new Blob([args.mask.buffer], { type: args.mask.mimetype ?? "image/png" }),
      args.mask.filename,
    );
  }

  const res = await fetch(`http://${cfg.host}:${cfg.port}/v1/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.masterKey}` },
    body: form,
    signal: args.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ImageGenerationError(
      res.status,
      `LiteLLM image edit failed (status ${res.status}): ${text}`.trim(),
    );
  }

  const json = (await res.json()) as {
    data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
  };
  if (!json?.data || json.data.length === 0) {
    throw new ImageGenerationError(
      res.status,
      "LiteLLM returned no image data in the edit response.",
    );
  }

  return normalizeDataEntries(json.data);
}
