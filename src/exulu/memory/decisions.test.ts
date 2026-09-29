import type { UIMessage } from "ai";
import { collectMemoryDecisions, isMemoryToolPartType, parseMemoryDecision } from "./decisions";

const remember = { v: 1, kind: "remember", title: "T", information: 'He said "no" }\nline2', type: "FACT", rights_mode: "private" };

describe("parseMemoryDecision", () => {
  it("round-trips quotes, braces and newlines in the wording", () => {
    expect(parseMemoryDecision(JSON.stringify(remember))).toEqual(remember);
  });
  it("rejects malformed json, wrong version and unknown kinds", () => {
    expect(parseMemoryDecision("declined")).toBeUndefined();
    expect(parseMemoryDecision(JSON.stringify({ ...remember, v: 2 }))).toBeUndefined();
    expect(parseMemoryDecision(JSON.stringify({ v: 1, kind: "flag" }))).toBeUndefined();
    expect(parseMemoryDecision(undefined)).toBeUndefined();
  });
  it("rejects an invalid rights_mode on remember", () => {
    expect(parseMemoryDecision(JSON.stringify({ ...remember, rights_mode: "everyone" }))).toBeUndefined();
  });
  it("accepts update with only the changed fields, and forget with none", () => {
    expect(parseMemoryDecision(JSON.stringify({ v: 1, kind: "update", information: "new" }))).toEqual({ v: 1, kind: "update", information: "new" });
    expect(parseMemoryDecision(JSON.stringify({ v: 1, kind: "forget" }))).toEqual({ v: 1, kind: "forget" });
  });
  it("drops malformed rbac entries and keeps only well-shaped grants", () => {
    const decision = {
      ...remember,
      rbac: { users: [{ id: 5, rights: "read" }, { id: "x", rights: "admin" }, "junk"], roles: "not-an-array" },
    };
    expect(parseMemoryDecision(JSON.stringify(decision))).toEqual({ ...remember, rbac: { users: [{ id: 5, rights: "read" }] } });
  });
  it("drops an rbac key whose lists are all empty", () => {
    expect(parseMemoryDecision(JSON.stringify({ ...remember, rbac: { users: [] } }))).toEqual(remember);
  });
  it("drops a non-object rbac value", () => {
    expect(parseMemoryDecision(JSON.stringify({ ...remember, rbac: "nope" }))).toEqual(remember);
  });
});

describe("isMemoryToolPartType", () => {
  it("matches only the three memory tool part types", () => {
    expect(isMemoryToolPartType("tool-memory_remember")).toBe(true);
    expect(isMemoryToolPartType("tool-memory_update")).toBe(true);
    expect(isMemoryToolPartType("tool-memory_forget")).toBe(true);
    expect(isMemoryToolPartType("tool-memory_remember_x")).toBe(false);
    expect(isMemoryToolPartType("tool-bash")).toBe(false);
    expect(isMemoryToolPartType("text")).toBe(false);
  });
});

describe("collectMemoryDecisions", () => {
  const msg = (parts: unknown[]): UIMessage => ({ id: "m", role: "assistant", parts } as unknown as UIMessage);

  it("collects approved memory parts keyed by toolCallId", () => {
    const m = msg([
      { type: "tool-memory_remember", toolCallId: "c1", state: "approval-responded", approval: { id: "a1", approved: true, reason: JSON.stringify(remember) } },
      { type: "tool-memory_forget", toolCallId: "c2", state: "approval-responded", approval: { id: "a2", approved: true, reason: JSON.stringify({ v: 1, kind: "forget" }) } },
    ]);
    const map = collectMemoryDecisions([m]);
    expect([...map.keys()]).toEqual(["c1", "c2"]);
    expect(map.get("c1")).toEqual(remember);
  });

  it("ignores denials, non-memory tools, unparseable reasons and user messages", () => {
    const m = msg([
      { type: "tool-memory_remember", toolCallId: "c1", state: "approval-responded", approval: { id: "a1", approved: false, reason: "declined" } },
      { type: "tool-bash", toolCallId: "c2", state: "approval-responded", approval: { id: "a2", approved: true, reason: JSON.stringify(remember) } },
      { type: "tool-memory_remember", toolCallId: "c3", state: "approval-responded", approval: { id: "a3", approved: true } },
    ]);
    const u = { id: "u", role: "user", parts: [{ type: "tool-memory_remember", toolCallId: "c4", approval: { approved: true, reason: JSON.stringify(remember) } }] } as unknown as UIMessage;
    expect(collectMemoryDecisions([m, u]).size).toBe(0);
  });
});
