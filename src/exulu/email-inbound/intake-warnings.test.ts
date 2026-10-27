import { detectIntakeWarnings, INTAKE_WARNING_TEXTS } from "./intake-warnings";

const email = (text: string, attachments: number) => ({
  from: { address: "a@b.c" }, subject: "WG: I26100025", text, html: undefined, messageId: "<x>",
  attachments: Array.from({ length: attachments }, (_, i) => ({ filename: `f${i}.pdf`, contentType: "application/pdf", content: Buffer.from("x") })),
}) as any;

describe("detectIntakeWarnings", () => {
  it("flags a mail that announces an attachment when none was delivered", () => {
    expect(detectIntakeWarnings(email("anbei unsere Anfrage I26100025 als PDF-Anhang", 0))).toEqual(["attachment_mentioned_but_none_received"]);
    expect(detectIntakeWarnings(email("Please find our inquiry attached as a PDF file.", 0))).toEqual(["attachment_mentioned_but_none_received"]);
    expect(detectIntakeWarnings(email("Bilder des Aggregats haben wir dieser Anfrage als Anlage beigefügt.", 0))).toEqual(["attachment_mentioned_but_none_received"]);
  });

  it("stays silent when attachments arrived or none is mentioned", () => {
    expect(detectIntakeWarnings(email("anbei unsere Anfrage als PDF-Anhang", 1))).toEqual([]);
    expect(detectIntakeWarnings(email("Welcher Dichtsatz passt für AZBZ 110?", 0))).toEqual([]);
  });

  it("has a human-readable text for every warning code", () => {
    expect(INTAKE_WARNING_TEXTS.attachment_mentioned_but_none_received).toMatch(/Anhang/);
  });
});
