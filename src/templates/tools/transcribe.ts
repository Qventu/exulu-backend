import { ExuluTool } from "@SRC/exulu/tool";
import { transcribeAudio } from "@SRC/exulu/transcribe.ts";
import {
  isLiteLLMEnabled,
  waitForLiteLLMReady,
} from "@SRC/exulu/litellm/supervisor.ts";
import { getS3ObjectBytes, listS3ObjectsByPrefix, uploadFile } from "@SRC/uppy";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const SANDBOX_ROOT = "/tmp/exulu-sessions";

// Map a sandbox-style file path the agent might pass in (`file:///tmp/...`,
// `/tmp/...`) to its (sessionId, relative-path-inside-session) pair. Returns
// null when the path doesn't live under the session sandbox root.
const parseSandboxPath = (
  input: string,
): { sessionId: string; relPath: string } | null => {
  const stripped = input.startsWith("file://") ? input.slice("file://".length) : input;
  if (!stripped.startsWith(`${SANDBOX_ROOT}/`)) return null;
  const tail = stripped.slice(SANDBOX_ROOT.length + 1);
  const slash = tail.indexOf("/");
  if (slash < 1) return null;
  const sessionId = tail.slice(0, slash);
  const relPath = tail.slice(slash + 1);
  if (!relPath) return null;
  return { sessionId, relPath };
};

// Tools that fetch a Buffer from S3 lose the upstream content-type header, so
// derive a best-effort audio mimetype from the file extension. Only the
// extensions the upstream transcription model is documented to accept are
// mapped; everything else throws so we surface a clear error to the agent
// rather than passing a silently-wrong type.
const audioMimetypeFromExtension = (filename: string): string => {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    case "ogg":
    case "oga":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "webm":
      return "audio/webm";
    case "aac":
      return "audio/aac";
    case "mpga":
    case "mpeg":
      return "audio/mpeg";
    default:
      throw new Error(
        `Unable to infer an audio mimetype from filename "${filename}". ` +
        "Supported extensions: mp3, m4a, mp4, wav, ogg, flac, webm, aac, mpga.",
      );
  }
};

export const transcribeTool = new ExuluTool({
  id: "transcribe_audio",
  name: "Transcribe Audio",
  description:
    "Transcribe an audio file (mp3, wav, m4a, etc.) from a URL to text using the configured speech-to-text model. The transcript is stored as a .txt file on S3 and the URL is returned; use this for clips that may be too long to inline in the conversation.",
  inputSchema: z.object({
    audio_url: z
      .string()
      .describe(
        "Location of the audio file to transcribe. Accepts a publicly fetchable URL " +
        "(https URL or presigned S3 URL), or a sandbox path such as " +
        "'/tmp/exulu-sessions/<sessionId>/<file>' or 'file:///tmp/exulu-sessions/<sessionId>/<file>' — " +
        "sandbox paths are resolved to their persisted S3 copy.",
      ),
    language: z
      .string()
      .optional()
      .describe(
        "ISO-639-1 language code of the audio, e.g. 'en' or 'de'. Omit to let the model auto-detect.",
      ),
  }),
  type: "function",
  config: [{
    name: "default_language",
    description: "ISO-639-1 language code of the audio, e.g. 'en' or 'de'. Omit to let the model auto-detect.",
    type: "string",
    default: undefined,
  }],
  execute: async ({ audio_url, language, user, exuluConfig, sessionID }: any) => {

    if (!language && exuluConfig?.default_language) {
      language = exuluConfig?.default_language;
    } else {
      language = "en";
    }

    language = exuluConfig?.default_language;

    console.log("[EXULU] Exulu config", exuluConfig);

    if (!isLiteLLMEnabled()) {
      console.error("[EXULU] Speech-to-text is not enabled on this deployment (EXULU_USE_LITELLM is not 'true').");
      throw new Error(
        "Speech-to-text is not enabled on this deployment (EXULU_USE_LITELLM is not 'true').",
      );
    }

    if (!process.env.TRANSCRIPTION_MODEL) {
      console.error("[EXULU] TRANSCRIPTION_MODEL env var is not set.");
      throw new Error("TRANSCRIPTION_MODEL env var is not set.");
    }

    if (!exuluConfig?.fileUploads) {
      console.error("[EXULU] File uploads are not configured; the transcribe tool requires S3 to store transcripts.");
      throw new Error(
        "File uploads are not configured; the transcribe tool requires S3 to store transcripts.",
      );
    }

    // When the agent passes a path inside the session sandbox (the skill
    // sandbox creates files under /tmp/exulu-sessions/<sessionId>/...), fetch
    // the persisted copy from S3 rather than the local disk — the sandbox
    // mirrors every artifact to S3 under user_<userId>/sessions/<sessionId>/
    // so it always exists there, and going through S3 keeps this tool working
    // when the sandbox runs in a separate process from the agent.
    const sandboxPath = parseSandboxPath(audio_url);

    let buffer: Buffer;
    let mimetype: string;
    let originalname: string;

    if (sandboxPath) {
      if (!user?.id) {
        throw new Error(
          "Sandbox audio paths require an authenticated user; got no user on the tool call.",
        );
      }
      if (sessionID && sandboxPath.sessionId !== sessionID) {
        throw new Error(
          `Refusing to transcribe an audio file from a different session's sandbox ` +
          `(path session=${sandboxPath.sessionId}, current session=${sessionID}).`,
        );
      }

      const rawKey = `user_${user.id}/sessions/${sandboxPath.sessionId}/${sandboxPath.relPath}`;
      console.log("[EXULU] Transcribing audio from sandbox path", {
        rawKey,
      });
      // listS3ObjectsByPrefix applies the configured general s3prefix internally
      // and returns the full key, which getS3ObjectBytes needs.
      const matches = await listS3ObjectsByPrefix(rawKey, exuluConfig);
      const found = matches.find((m) => m.key.endsWith(rawKey));
      if (!found) {
        console.error("[EXULU] Sandbox audio file not found in S3 storage at", {
          rawKey,
          matches,
        });
        throw new Error(
          `Sandbox audio file not found in S3 storage at "${rawKey}". ` +
          "The file may not have been persisted yet — try again after the sandbox flushes it.",
        );
      }

      buffer = await getS3ObjectBytes(found.key, exuluConfig);
      originalname = decodeURIComponent(
        sandboxPath.relPath.split("/").pop() || "audio",
      );
      mimetype = audioMimetypeFromExtension(originalname);
    } else {
      console.log("[EXULU] Fetching audio from URL", {
        audio_url,
      });
      const upstream = await fetch(audio_url);
      if (!upstream.ok) {
        console.error("[EXULU] Failed to fetch audio from", {
          audio_url,
          upstream,
        });
        throw new Error(
          `Failed to fetch audio from ${audio_url}: ${upstream.status} ${upstream.statusText}`,
        );
      }
      mimetype = upstream.headers.get("content-type") || "audio/mpeg";
      if (!mimetype.startsWith("audio/")) {
        throw new Error(
          `URL did not return an audio file (content-type: ${mimetype}).`,
        );
      }
      buffer = Buffer.from(await upstream.arrayBuffer());

      originalname = "audio";
      try {
        const pathname = new URL(audio_url).pathname;
        const last = pathname.split("/").pop();
        if (last) originalname = decodeURIComponent(last);
      } catch {
        // audio_url is not a parseable URL — keep the fallback name.
      }
    }

    const { text } = await transcribeAudio({
      file: { buffer, originalname, mimetype },
      language: language,
    });

    const transcriptBuffer = Buffer.from(text, "utf-8");
    const transcriptFilename = `${randomUUID()}.txt`;

    // Route the upload through the session prefix when a sessionID is
    // available so the transcript appears next to other sandbox artifacts
    // (and is restored into the session dir on the next cold start).
    const transcriptKey = sessionID
      ? `sessions/${sessionID}/transcripts/${transcriptFilename}`
      : `transcripts/${transcriptFilename}`;

    console.log("[EXULU] Uploading transcript to S3", {
      transcriptFilename,
      transcriptKey,
    });

    const url = await uploadFile(
      transcriptBuffer,
      transcriptKey,
      exuluConfig,
      { contentType: "text/plain" },
      user?.id,
    );

    console.log("[EXULU] Uploaded transcript to S3", {
      url,
    });

    // Mirror the transcript into the live session sandbox dir so the agent
    // (and any subsequent bash/readFile call inside the sandbox) can see it
    // immediately, without waiting for a cold-start S3 restore. Failures are
    // logged but non-fatal — the S3 copy is the source of truth and `url` is
    // already in hand.
    let sandboxLocalPath: string | undefined;
    if (sessionID) {
      sandboxLocalPath = join(
        SANDBOX_ROOT,
        sessionID,
        "transcripts",
        transcriptFilename,
      );
      console.log("[EXULU] Mirroring transcript into session sandbox", {
        sandboxLocalPath,
      });
      try {
        await mkdir(dirname(sandboxLocalPath), { recursive: true });
        await writeFile(sandboxLocalPath, transcriptBuffer);
      } catch (err) {
        console.error(
          `[EXULU] Failed to write transcript to sandbox dir ${sandboxLocalPath}; S3 copy is unaffected.`,
          err,
        );
        sandboxLocalPath = undefined;
      }
    }

    console.log("[EXULU] Transcribed audio successfully", {
      text,
      url,
      sandboxLocalPath,
      length: text.length,
    });

    return {
      result: sandboxLocalPath
        ? `Transcript stored at: ${url} (also available in the session sandbox at ${sandboxLocalPath}, ${text.length} characters).`
        : `${url}`,
    };
  },
});
