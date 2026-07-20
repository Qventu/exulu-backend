import type { UIMessage } from "ai";
import {
  EMAIL_RUN_VARIABLES,
  messageHasPendingApproval,
  substituteVariablesInMessage,
} from "./flow-steps";

const msg = (text: string): UIMessage =>
  ({ id: "m1", role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const textOf = (message: UIMessage): string => (message.parts[0] as { text: string }).text;

describe("substituteVariablesInMessage", () => {
  it("substitutes provided variables into text parts", () => {
    const message = msg("Hello {name}, order {order_id}");
    substituteVariablesInMessage(message, { name: "KONE", order_id: "42" });
    expect(textOf(message)).toBe("Hello KONE, order 42");
  });

  it("throws the legacy error for missing user variables", () => {
    const message = msg("Hello {name}");
    expect(() => substituteVariablesInMessage(message, {})).toThrow(
      "Value for variable name not provided in variables",
    );
  });

  it("still rejects empty strings for user-provided variables", () => {
    const message = msg("Hello {name}");
    expect(() => substituteVariablesInMessage(message, { name: "" })).toThrow(
      "Value for variable name not provided in variables",
    );
  });

  it("accepts empty strings for the auto-provided email variables (spec §4.5)", () => {
    const message = msg("From {email_from} Subject {email_subject} Body {email_body}");
    substituteVariablesInMessage(message, {
      email_from: "a@b.com",
      email_subject: "",
      email_body: "",
    });
    expect(textOf(message)).toBe("From a@b.com Subject  Body ");
  });

  it("email variables still throw when entirely absent", () => {
    const message = msg("{email_body}");
    expect(() => substituteVariablesInMessage(message, {})).toThrow(
      "Value for variable email_body not provided in variables",
    );
  });

  it("ignores non-text parts and repeated placeholders replace all occurrences", () => {
    const message = {
      id: "m2",
      role: "user",
      parts: [
        { type: "file", url: "s3://x", mediaType: "application/pdf", filename: "x.pdf" },
        { type: "text", text: "{a} and {a}" },
      ],
    } as unknown as UIMessage;
    substituteVariablesInMessage(message, { a: "x" });
    expect((message.parts[1] as { text: string }).text).toBe("x and x");
  });
});

describe("EMAIL_RUN_VARIABLES", () => {
  it("contains exactly the three auto-provided variables", () => {
    expect([...EMAIL_RUN_VARIABLES].sort()).toEqual(["email_body", "email_from", "email_subject"]);
  });
});

describe("messageHasPendingApproval", () => {
  const approvalPart = {
    type: "tool-create_offer",
    state: "approval-requested",
    approval: { id: "appr-1" },
  };

  it("detects a pending approval tool part on the message", () => {
    const message = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "…" }, approvalPart],
    } as unknown as UIMessage;
    expect(messageHasPendingApproval(message)).toBe(true);
  });

  it("is false for resolved approvals, plain messages, and undefined", () => {
    const resolved = {
      id: "a2",
      role: "assistant",
      parts: [{ ...approvalPart, state: "output-denied" }],
    } as unknown as UIMessage;
    expect(messageHasPendingApproval(resolved)).toBe(false);
    expect(messageHasPendingApproval(msg("hi"))).toBe(false);
    expect(messageHasPendingApproval(undefined)).toBe(false);
  });

  it("detects dynamic-tool parts too", () => {
    const message = {
      id: "a3",
      role: "assistant",
      parts: [{ ...approvalPart, type: "dynamic-tool" }],
    } as unknown as UIMessage;
    expect(messageHasPendingApproval(message)).toBe(true);
  });

  it("ignores answered approvals in state output-denied / approval-responded / output-available (deny path, spec §5.5)", () => {
    for (const state of ["output-denied", "approval-responded", "output-available"]) {
      const message = {
        id: "a4",
        role: "assistant",
        parts: [{ ...approvalPart, state }],
      } as unknown as UIMessage;
      expect(messageHasPendingApproval(message)).toBe(false);
    }
  });
});
