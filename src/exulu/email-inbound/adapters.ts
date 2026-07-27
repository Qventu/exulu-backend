// Content-type adapters that normalize non-MIME webhook payloads into the
// shared InboundEmail shape (spec §4.2). Raw MIME still goes through
// normalize.ts:parseRawMime; this module handles the documented JSON shape.
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import Busboy from "busboy";
import type { InboundEmail } from "./types";

const htmlToText = (html: string): string =>
  html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

const parseFrom = (from: unknown): { address: string; name?: string } => {
  if (typeof from === "string" && from.includes("@")) return { address: from.trim() };
  if (from && typeof from === "object") {
    const address = (from as any).address;
    if (typeof address === "string" && address.includes("@")) {
      const name = (from as any).name;
      return typeof name === "string" && name ? { address: address.trim(), name } : { address: address.trim() };
    }
  }
  throw new Error("Invalid payload: `from` must be an email address or { address, name }.");
};

const decodeAttachment = (a: any): { filename: string; contentType: string; content: Buffer } => {
  const filename = typeof a?.filename === "string" && a.filename ? a.filename : "attachment";
  const contentType = typeof a?.content_type === "string" && a.content_type ? a.content_type : "application/octet-stream";
  const b64 = typeof a?.content_base64 === "string" ? a.content_base64 : "";
  // Node is lenient with base64; validate round-trip to reject junk.
  const content = Buffer.from(b64, "base64");
  if (b64 && content.toString("base64").replace(/=+$/, "") !== b64.replace(/\s|=+$/g, "")) {
    throw new Error(`Invalid attachment: "${filename}" content_base64 is not valid base64.`);
  }
  return { filename, contentType, content };
};

export function detectPayloadFormat(contentType: string): "eml" | "json" | "multipart" {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("multipart/form-data")) return "multipart";
  if (ct.includes("application/json")) return "json";
  return "eml"; // message/rfc822, text/plain, empty → raw MIME
}

const MIME_FIELD_NAMES = new Set(["body-mime", "email", "message"]);

/** Extract the raw MIME bytes from a Mailgun-style multipart form. */
export function extractMultipartMimePart(rawBody: Buffer, contentType: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let found: Buffer | null = null;
    const bb = Busboy({ headers: { "content-type": contentType }, defParamCharset: "latin1" });
    bb.on("field", (name: string, value: string) => {
      if (found === null && MIME_FIELD_NAMES.has(name.toLowerCase())) {
        found = Buffer.from(value, "latin1"); // byte-fidelity for 8-bit MIME
      }
    });
    bb.on("close", () => {
      if (found) resolve(found);
      else reject(new Error("No raw MIME part found (expected a body-mime, email, or message field)."));
    });
    bb.on("error", (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
    Readable.from(rawBody).pipe(bb);
  });
}

export function jsonToInboundEmail(raw: unknown): InboundEmail {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid payload: expected a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  const from = parseFrom(obj.from);
  const subject = typeof obj.subject === "string" ? obj.subject : "";
  const html = typeof obj.html === "string" ? obj.html : undefined;
  const text = typeof obj.text === "string" && obj.text ? obj.text : html ? htmlToText(html) : "";
  const messageId = typeof obj.message_id === "string" && obj.message_id ? obj.message_id : `<${randomUUID()}@webhook.local>`;
  const attachments = Array.isArray(obj.attachments) ? obj.attachments.map(decodeAttachment) : [];
  const headers = new Map<string, string>([["message-id", messageId]]);
  return {
    messageId,
    from,
    recipient: "", // set by the intake to trigger:{id}; not a routing field here
    subject,
    text,
    ...(html ? { html } : {}),
    attachments,
    headers,
  };
}
