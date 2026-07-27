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
