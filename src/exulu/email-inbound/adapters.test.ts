import { jsonToInboundEmail } from "./adapters";

describe("jsonToInboundEmail", () => {
  it("maps a full JSON payload including a base64 attachment", () => {
    const email = jsonToInboundEmail({
      from: { address: "service@kone.com", name: "KONE" },
      subject: "Ersatzteil",
      text: "body",
      message_id: "<abc@kone.com>",
      attachments: [
        { filename: "p.pdf", content_type: "application/pdf", content_base64: Buffer.from("hi").toString("base64") },
      ],
    });
    expect(email.from).toEqual({ address: "service@kone.com", name: "KONE" });
    expect(email.subject).toBe("Ersatzteil");
    expect(email.text).toBe("body");
    expect(email.messageId).toBe("<abc@kone.com>");
    expect(email.attachments[0].filename).toBe("p.pdf");
    expect(email.attachments[0].content.toString()).toBe("hi");
  });

  it("accepts a bare-string from and defaults subject/text to ''", () => {
    const email = jsonToInboundEmail({ from: "a@b.com" });
    expect(email.from).toEqual({ address: "a@b.com" });
    expect(email.subject).toBe("");
    expect(email.text).toBe("");
  });

  it("derives text from html when text is absent", () => {
    const email = jsonToInboundEmail({ from: "a@b.com", html: "<p>Hello <b>world</b></p>" });
    expect(email.text).toContain("Hello");
    expect(email.text).toContain("world");
    expect(email.html).toBe("<p>Hello <b>world</b></p>");
  });

  it("generates a message id when absent", () => {
    const email = jsonToInboundEmail({ from: "a@b.com" });
    expect(email.messageId).toMatch(/@webhook\.local>?$/);
  });

  it("throws on missing/invalid from", () => {
    expect(() => jsonToInboundEmail({})).toThrow(/from/i);
    expect(() => jsonToInboundEmail({ from: 123 })).toThrow(/from/i);
    expect(() => jsonToInboundEmail({ from: "@" })).toThrow(/from/i);
  });

  it("accepts a single attachment object, not only an array (one-attachment mails from Node-RED)", () => {
    // ALGI's Node-RED flow serialises `attachments` as an object when a mail
    // carries exactly one attachment and as an array otherwise; the object
    // form was silently dropped, so every one-PDF inquiry lost its PDF.
    const content = Buffer.from("%PDF-1.4 single").toString("base64");
    const email = jsonToInboundEmail({
      from: "sabrina@example.com",
      subject: "WG: I26100025",
      text: "anbei unsere Anfrage als PDF-Anhang",
      attachments: { filename: "I26100025.20261022.pdf", content_type: "application/pdf", content_base64: content },
    });
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0].filename).toBe("I26100025.20261022.pdf");
    expect(email.attachments[0].contentType).toBe("application/pdf");
    expect(email.attachments[0].content.toString()).toBe("%PDF-1.4 single");
  });

  it("rejects attachments that are neither an array nor an attachment object, naming the shape", () => {
    // A silently dropped attachment looked like a successful run with a bad
    // answer (ALGI, 2026-10-23); a shape violation is a payload error now.
    expect(() => jsonToInboundEmail({ from: "a@b.c", attachments: "nope" })).toThrow(/attachments must be an array/);
    expect(() => jsonToInboundEmail({ from: "a@b.c", attachments: { note: "no file here" } })).toThrow(/attachments must be an array/);
    expect(() => jsonToInboundEmail({ from: "a@b.c", attachments: [42] })).toThrow(/attachments\[0\]/);
  });

  it("rejects an attachment without content_base64 instead of storing an empty file", () => {
    expect(() => jsonToInboundEmail({ from: "a@b.c", attachments: [{ filename: "x.pdf", content_type: "application/pdf" }] }))
      .toThrow(/"x.pdf".*content_base64/);
  });

  it("accepts a missing or empty attachments field", () => {
    expect(jsonToInboundEmail({ from: "a@b.c" }).attachments).toEqual([]);
    expect(jsonToInboundEmail({ from: "a@b.c", attachments: [] }).attachments).toEqual([]);
    expect(jsonToInboundEmail({ from: "a@b.c", attachments: null }).attachments).toEqual([]);
  });

  it("throws on malformed base64 attachment", () => {
    expect(() =>
      jsonToInboundEmail({ from: "a@b.com", attachments: [{ filename: "x", content_base64: "!!!not-base64!!!" }] }),
    ).toThrow(/base64|attachment/i);
  });
});

import { detectPayloadFormat, extractMultipartMimePart } from "./adapters";

describe("detectPayloadFormat", () => {
  it("classifies content types", () => {
    expect(detectPayloadFormat("application/json")).toBe("json");
    expect(detectPayloadFormat("application/json; charset=utf-8")).toBe("json");
    expect(detectPayloadFormat("multipart/form-data; boundary=xyz")).toBe("multipart");
    expect(detectPayloadFormat("message/rfc822")).toBe("eml");
    expect(detectPayloadFormat("text/plain")).toBe("eml");
    expect(detectPayloadFormat("")).toBe("eml");
  });
});

describe("extractMultipartMimePart", () => {
  const build = (fieldName: string, value: string) => {
    const boundary = "----exulutest";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${value}\r\n--${boundary}--\r\n`;
    return { buffer: Buffer.from(body, "latin1"), contentType: `multipart/form-data; boundary=${boundary}` };
  };
  it("pulls the raw MIME from a body-mime field", async () => {
    const { buffer, contentType } = build("body-mime", "Subject: hi\r\n\r\nbody");
    const mime = await extractMultipartMimePart(buffer, contentType);
    expect(mime.toString("latin1")).toContain("Subject: hi");
  });
  it("also accepts an `email` field name", async () => {
    const { buffer, contentType } = build("email", "Subject: x\r\n\r\ny");
    expect((await extractMultipartMimePart(buffer, contentType)).toString()).toContain("Subject: x");
  });
  it("throws when no known MIME field is present", async () => {
    const { buffer, contentType } = build("other", "z");
    await expect(extractMultipartMimePart(buffer, contentType)).rejects.toThrow(/body-mime|email|message/i);
  });

  it("preserves 8-bit MIME bytes (latin1 fidelity — byte-for-byte round-trip)", async () => {
    // A MIME header + body containing high bytes: ü = 0xFC, é = 0xE9
    const original = "Subject: Gr\xFCße\r\n\r\ncaf\xE9";
    const boundary = "----exulutest8bit";
    // Build the multipart body using latin1 so high bytes survive as-is
    const bodyStr = `--${boundary}\r\nContent-Disposition: form-data; name="body-mime"\r\n\r\n${original}\r\n--${boundary}--\r\n`;
    const buffer = Buffer.from(bodyStr, "latin1");
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const result = await extractMultipartMimePart(buffer, contentType);
    // The returned Buffer must match the original latin1 bytes exactly
    expect(result.equals(Buffer.from(original, "latin1"))).toBe(true);
  });
});
