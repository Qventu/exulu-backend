// Verifies the image delivery mechanism used by view_document_page: an image
// injected as a user-message image part (exactly what imageAttachmentGuard
// produces) must reach the model through the local LiteLLM proxy.
// Also documents the negative case: the same image inside a tool-result is
// JSON-stringified by @ai-sdk/openai-compatible and arrives as base64 text.
//
// Usage: npx tsx scripts/repro-view-page-image.ts <litellm-model-id> <path-to-image>
//   e.g. npx tsx scripts/repro-view-page-image.ts claude-sonnet ./screenshot.png
// Run once against a Claude model and once against a non-Anthropic vision model.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const [modelId, imagePath] = process.argv.slice(2);
if (!modelId || !imagePath) {
  console.error("Usage: npx tsx scripts/repro-view-page-image.ts <litellm-model-id> <path-to-image>");
  process.exit(1);
}

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function main() {
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  if (!masterKey) throw new Error("LITELLM_MASTER_KEY is required");

  const litellm = createOpenAICompatible({
    name: "litellm",
    baseURL: `http://${host}:${port}/v1`,
    apiKey: masterKey,
  });

  const mediaType = MEDIA_TYPES[extname(imagePath).toLowerCase()];
  if (!mediaType) throw new Error(`Unsupported image extension on ${imagePath}`);
  const imageBase64 = readFileSync(imagePath).toString("base64");

  // The exact message shape imageAttachmentGuard injects.
  const { text } = await generateText({
    model: litellm(modelId),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "[Image attached from tool call: test.pdf page 2]" },
          { type: "image", image: imageBase64, mediaType },
        ],
      },
      {
        role: "user",
        content: "Describe the attached image in one short sentence. If you cannot see any image, reply exactly: NO IMAGE VISIBLE",
      },
    ],
  });

  console.log(`model: ${modelId}`);
  console.log(`response: ${text}`);
  if (text.includes("NO IMAGE VISIBLE")) {
    console.error("FAIL — the injected user-message image did not reach the model.");
    process.exit(1);
  }
  console.log("PASS — injected user-message image reached the model.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
