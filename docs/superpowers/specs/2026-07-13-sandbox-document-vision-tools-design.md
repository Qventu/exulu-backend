# Sandbox Document Vision Tools — Design

**Date:** 2026-07-13
**Status:** Approved (pending spec review)

## Problem

A user uploaded `test.pdf` to the session files panel and asked about an image on page 2. The agent could not answer: it ran shell tricks (`file`, exit 127) and apologized. Two gaps cause this:

1. Tool results in the agentic loop are text-only. The sandbox already has `pdftoppm` (a required system dependency), so the agent *can* render a PDF page to PNG — but there is no channel that puts that image into the model's context. Rendered PNGs only become S3 artifacts with download links for the human.
2. The agent has no cheap way to orient itself inside a document (which page holds what) without dumping raw binary through `readFile`/`bash`.

## Scope decision

Deep or full document processing is **not** a chat-sandbox concern. Users who need documents fully processed (OCR, layout analysis, VLM validation) should ingest them into a knowledge base — an `ExuluContext` with a processor configured, backed by the EE `documentProcessor` pipeline (`ee/python/documents/processing/doc_processor.ts`).

The sandbox gets exactly two small on-demand tools. Explicitly rejected during design (as overcomplication for this problem): parse-on-upload with basic/advanced tiers, upload-time dialogs, sidecar status files, background parse jobs, and sandbox file substitution.

## Design

Both tools are host-side internal tools registered alongside `read_session_file` (`src/templates/tools/session-file-read-tool.ts`) whenever `fileUploads` is configured. They follow its conventions: base-name-only filenames, path-traversal rejection, `{ error }` returns instead of throws, and files fetched via presigned S3 URL (like `read_session_file` — works whether or not the sandbox is live).

### Tool 1: `parse_document`

Purpose: locate content inside a document cheaply — no LLM, no license gate.

- **Input:** `{ filename: string, pages?: string, offset?: number, limit?: number }` (pages e.g. `"2"` or `"1-5"`; offset/limit are line-based with the same defaults as `read_session_file`).
- **PDF:** `pdftotext` with form-feed page breaks converted to `--- page N ---` markers, so the agent learns which page holds what.
- **Office formats (docx/xlsx/pptx/odt/...):** officeparser text extraction (same library `processFilePartsInMessages` in `src/exulu/provider.ts` already uses). No page markers (the formats don't have fixed pages pre-render).
- **Output:** text, capped at 16,000 chars per call with pagination, matching `read_session_file` limits.
- **Dependency:** add `pdftotext` to `REQUIRED_SYSTEM_DEPENDENCIES` (`src/exulu/system-dependencies.ts`). It ships in the same poppler package as the already-required `pdftoppm`.

### Tool 2: `view_document_page`

Purpose: let the agent actually see a page or image.

- **Input:** `{ filename: string, page?: number }` (page defaults to 1; ignored for image files).
- **PDF:** render page N to PNG via `pdftoppm` at ~150 DPI, capped at 1568px on the long edge (Anthropic's recommended vision size) and ~4MB encoded; downscale rather than reject when over cap.
- **Office formats:** convert to PDF first by reusing the existing LibreOffice preview path (`getPdfPreviewBytes` in `src/sessions/pdf-preview-cache.ts`, ETag-cached), then render the requested page.
- **Image files (png/jpg/jpeg/gif/webp):** return the image directly. This also fixes the agent's blindness to plain screenshots in the sandbox.
- **Delivery:** via `prepareStep` message injection (see next section): the tool result is a small marker JSON; a prepareStep guard inserts the rendered image as a user-message image part immediately after the tool-result message, so the model sees the pixels within the same agentic loop.
- **Vision gating:** if the session model lacks `supports_vision` (LiteLLM catalog flag, `src/exulu/litellm/catalog.ts`), the tool returns a text error stating vision is unavailable on this model. Deterministic refusal, no silent failure.

### Agent flow for the originating scenario

"What's the image on page 2 of test.pdf?" → `parse_document` (orient: confirm page 2, read caption/context) → `view_document_page { filename: "test.pdf", page: 2 }` → model sees the page render → answers.

## Delivery mechanism (amended 2026-07-13 after implementation research)

The originally planned primary path — AI SDK `toModelOutput` emitting an image content block in the tool result — is confirmed dead through LiteLLM: `@ai-sdk/openai-compatible@latest` serializes `content`-type tool outputs with `JSON.stringify`, so the model would receive base64 as text, never pixels. The originally designed fallback is therefore the primary mechanism:

- `view_document_page` stashes the rendered PNG in an in-process map keyed by `toolCallId` and returns only a small marker JSON as its tool result.
- A new `imageAttachmentGuard` prepareStep (composed into the existing `composePrepareSteps` chains in `src/exulu/provider.ts` and `src/exulu/openai-gateway.ts`) walks the step messages and inserts a user message with an image part directly after any tool-result message whose `toolCallId` is stashed. User-message image parts are serialized by the openai-compatible provider as standard `image_url` data URLs — supported by every vision model LiteLLM routes to.
- The stash is bounded (LRU + TTL); images are never persisted to chat history, so later turns see only the marker text. The agent can re-call the tool if it needs to look again.

A tsx repro script against local LiteLLM verifies an injected user-message image reaches (a) a Claude model and (b) one non-Anthropic vision model.

## Error handling

- Missing file, invalid page number, or render/conversion failure → `{ error: string }` in the tool result; never throws.
- Non-vision model calling `view_document_page` → `{ error }` explaining the model cannot receive images.
- Oversized renders are downscaled to fit the byte cap.
- Encrypted/corrupt PDFs surface the poppler error message truncated.

## Out of scope (future work)

- Embedded-image extraction (`pdfimages`) as an alternative to full-page renders.
- Wiring `supports_pdf_input` models to receive native PDFs on the message-attach path (`processFilePartsInMessages` currently flattens documents to officeparser text).
- Knowledge-base ingestion UX improvements for the EE `documentProcessor`.

## Testing

- **Unit (CI):** both tools against fixtures (born-digital PDF, scanned PDF, DOCX, PNG): page-marker output, pagination caps, traversal rejection, vision-gate refusal, downscaling, error shapes.
- **Repro script (dev loop):** image tool-result through local LiteLLM to Claude + one non-Anthropic vision model; decides primary vs. `prepareStep` fallback.
- **Manual E2E:** replay the original failing scenario end-to-end — upload `test.pdf`, ask about the page-2 image, confirm parse → view → correct answer.
