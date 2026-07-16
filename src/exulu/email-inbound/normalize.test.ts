import { parseRawMime } from "./normalize";

const CRLF = "\r\n";

const plainEmail = Buffer.from(
  [
    "Message-ID: <abc-123@mail.example.com>",
    'From: "Anna Service" <Service@KONE.com>',
    "To: spare-parts-1a2b3c4d@mail.client.com",
    "Subject: Ersatzteil Anfrage",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Wir brauchen ein Ersatzteil.",
  ].join(CRLF),
);

const htmlOnlyEmail = Buffer.from(
  [
    "Message-ID: <html-1@mail.example.com>",
    "From: service@kone.com",
    "To: spare-parts-1a2b3c4d@mail.client.com",
    "Subject: HTML only",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><p>Bitte <b>dringend</b> liefern.</p></body></html>",
  ].join(CRLF),
);

const umlautEmail = Buffer.from(
  [
    "Message-ID: <umlaut-1@mail.example.com>",
    "From: service@kone.com",
    "To: spare-parts-1a2b3c4d@mail.client.com",
    "Subject: =?utf-8?Q?Ersatzteilanfrage_f=C3=BCr_Aufzug?=",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "T=C3=BCr klemmt im 3. OG.",
  ].join(CRLF),
);

const attachmentEmail = Buffer.from(
  [
    "Message-ID: <att-1@mail.example.com>",
    "From: service@kone.com",
    "To: spare-parts-1a2b3c4d@mail.client.com",
    "Subject: With attachment",
    'Content-Type: multipart/mixed; boundary="BOUNDARY"',
    "",
    "--BOUNDARY",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See attachment.",
    "--BOUNDARY",
    'Content-Type: application/pdf; name="order.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="order.pdf"',
    "",
    Buffer.from("PDFDATA").toString("base64"),
    "--BOUNDARY--",
  ].join(CRLF),
);

const emptyBodyEmail = Buffer.from(
  [
    "From: service@kone.com",
    "To: spare-parts-1a2b3c4d@mail.client.com",
    "Subject: Empty",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "",
  ].join(CRLF),
);

const noFromEmail = Buffer.from(
  ["Subject: Orphan", "Content-Type: text/plain", "", "hello"].join(CRLF),
);

// Not valid MIME: the transfer was truncated mid-header (From cut off
// inside the quoted display name, before any address) and there is no
// blank-line header/body separator.
const truncatedEmail = Buffer.from(
  ["Message-ID: <trunc-1@mail.exampl", 'From: "Anna Serv'].join(CRLF),
);

describe("parseRawMime", () => {
  it("parses a plain-text email into InboundEmail", async () => {
    const email = await parseRawMime(plainEmail);
    expect(email.messageId).toBe("<abc-123@mail.example.com>");
    expect(email.from).toEqual({ address: "service@kone.com", name: "Anna Service" });
    expect(email.recipient).toBe("spare-parts-1a2b3c4d@mail.client.com");
    expect(email.subject).toBe("Ersatzteil Anfrage");
    expect(email.text.trim()).toBe("Wir brauchen ein Ersatzteil.");
    expect(email.attachments).toEqual([]);
  });

  it("lowercases header names", async () => {
    const email = await parseRawMime(plainEmail);
    expect(email.headers.has("subject")).toBe(true);
    expect(email.headers.has("Subject")).toBe(false);
  });

  it("derives text from an HTML-only body", async () => {
    const email = await parseRawMime(htmlOnlyEmail);
    expect(email.text).toContain("dringend");
    expect(email.text).not.toContain("<b>");
    expect(email.html).toContain("<b>dringend</b>");
  });

  it("decodes encoded-word subjects and quoted-printable bodies (umlauts)", async () => {
    const email = await parseRawMime(umlautEmail);
    expect(email.subject).toBe("Ersatzteilanfrage für Aufzug");
    expect(email.text).toContain("Tür klemmt");
  });

  it("parses attachments with filename, contentType and Buffer content", async () => {
    const email = await parseRawMime(attachmentEmail);
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]!.filename).toBe("order.pdf");
    expect(email.attachments[0]!.contentType).toBe("application/pdf");
    expect(email.attachments[0]!.content.toString("utf8")).toBe("PDFDATA");
  });

  it("returns '' for an empty body and a deterministic generated message id", async () => {
    const first = await parseRawMime(emptyBodyEmail);
    const second = await parseRawMime(emptyBodyEmail);
    expect(first.text).toBe("");
    expect(first.messageId).toMatch(/^generated-[0-9a-f]{64}$/);
    expect(second.messageId).toBe(first.messageId);
  });

  it("throws on MIME without a parseable From address", async () => {
    await expect(parseRawMime(noFromEmail)).rejects.toThrow(/From address/);
  });

  it("throws on malformed/truncated MIME (headers cut mid-line, no body separator)", async () => {
    // mailparser is lenient and does not reject truncated input, but the
    // cut-off From header yields no parseable address, so parseRawMime
    // throws — the same contract Task 8's intake catch relies on to record
    // a sanitized `failed` job_results row (raw .eml retained).
    await expect(parseRawMime(truncatedEmail)).rejects.toThrow(/From address/);
  });
});
