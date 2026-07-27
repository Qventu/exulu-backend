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
});
