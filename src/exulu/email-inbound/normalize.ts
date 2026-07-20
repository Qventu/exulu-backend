// Provider-agnostic MIME normalization seam (spec §4.3): raw MIME in,
// InboundEmail out. Parse failures throw — the intake job turns them into a
// sanitized `failed` run row (spec §9).
import { createHash } from "node:crypto";
import { simpleParser, type AddressObject } from "mailparser";
import type { InboundEmail } from "./types";

// Minimal fallback for HTML-only emails: strip tags/entities into plain
// text. mailparser provides `text` only when a text/plain part exists.
const htmlToText = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

// mailparser header values are strings for unstructured headers
// (Auto-Submitted, Precedence, ...) but structured objects for others.
const headerValueToString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => headerValueToString(v)).join(", ");
  if (value && typeof value === "object") {
    const structured = value as { text?: unknown };
    if (typeof structured.text === "string") return structured.text;
    return JSON.stringify(value);
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
};

const firstAddress = (
  input: AddressObject | AddressObject[] | undefined,
): { address?: string; name?: string } | undefined => {
  const objects = Array.isArray(input) ? input : input ? [input] : [];
  for (const object of objects) {
    const entry = object.value?.[0];
    if (entry?.address) return entry;
  }
  return undefined;
};

export async function parseRawMime(raw: Buffer): Promise<InboundEmail> {
  const parsed = await simpleParser(raw);

  const fromEntry = firstAddress(parsed.from);
  if (!fromEntry?.address) {
    throw new Error("MIME message has no parseable From address.");
  }

  const headers = new Map<string, string>();
  for (const [name, value] of parsed.headers) {
    headers.set(name.toLowerCase(), headerValueToString(value));
  }

  const toEntry = firstAddress(parsed.to);
  const html = typeof parsed.html === "string" ? parsed.html : undefined;
  const text = parsed.text?.trim() ? parsed.text : html ? htmlToText(html) : "";

  return {
    // Message-ID is the dedup key (spec §4.4.5). A missing header gets a
    // deterministic content hash so webhook/job retries still dedup.
    messageId:
      parsed.messageId ?? `generated-${createHash("sha256").update(raw).digest("hex")}`,
    from: {
      address: fromEntry.address.toLowerCase(),
      ...(fromEntry.name ? { name: fromEntry.name } : {}),
    },
    recipient: (toEntry?.address ?? "").toLowerCase(),
    subject: parsed.subject ?? "",
    text,
    ...(html ? { html } : {}),
    attachments: (parsed.attachments ?? []).map((attachment) => ({
      filename: attachment.filename ?? "attachment",
      contentType: attachment.contentType ?? "application/octet-stream",
      content: attachment.content,
    })),
    headers,
  };
}
