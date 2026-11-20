import { decideInbound, isUserActive, type DecideDeps, type InboundMessage } from "./decide";
import type { ChannelLink } from "./links";

const NOW = new Date("2026-11-16T12:00:00Z");
const CODE = "ABCD-2345";

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channelId: "chA",
  threadId: "t1",
  identity: "whatsapp:+4915112345678",
  messageId: "m1",
  text: "Wie reset ich den Aufzug?",
  hasAttachments: false,
  ...over,
});

const link = (over: Partial<ChannelLink> = {}): ChannelLink => ({
  id: "l1",
  channel: "chA",
  identity: "whatsapp:+4915112345678",
  user: 7,
  linked_at: new Date("2026-11-10T12:00:00Z"),
  expires_at: new Date("2026-11-20T12:00:00Z"),
  revoked_at: null,
  last_seen_at: null,
  ...over,
});

const makeDeps = (over: Partial<DecideDeps> = {}) => {
  const deps = {
    now: () => NOW,
    config: { linkTtlDays: 30 } as any,
    linkUrl: "https://app.example/link",
    links: {
      find: jest.fn(async () => link()),
      upsert: jest.fn(async (p: any) => link({ user: p.userId, expires_at: new Date("2026-12-16T12:00:00Z") })),
      revoke: jest.fn(async () => undefined),
      touch: jest.fn(async () => undefined),
    },
    consumeCode: jest.fn(async () => ({ channelId: "chA", userId: 7 })),
    codeAttemptsExceeded: jest.fn(async () => false),
    linkPromptAllowed: jest.fn(async () => true),
    accessAllowed: jest.fn(async () => true),
    rateLimited: jest.fn(() => false),
    runInFlight: jest.fn(async () => false),
    markNewSession: jest.fn(async () => undefined),
    takeNewSession: jest.fn(async () => false),
    audit: jest.fn(),
    ...over,
  };
  return deps as typeof deps & DecideDeps;
};

type D = ReturnType<typeof makeDeps>;
const notCalled = (deps: D, ...names: string[]) => {
  for (const n of names) {
    const fn: any = (deps as any)[n] ?? (deps.links as any)[n];
    expect({ n, calls: fn.mock.calls.length }).toEqual({ n, calls: 0 });
  }
};
const ALL = [
  "find", "upsert", "revoke", "touch", "consumeCode", "codeAttemptsExceeded", "linkPromptAllowed",
  "accessAllowed", "rateLimited", "runInFlight", "markNewSession", "takeNewSession", "audit",
];
const onlyCalled = (deps: D, ...allowed: string[]) =>
  notCalled(deps, ...ALL.filter((n) => !allowed.includes(n)));

describe("step 1: not text", () => {
  it("attachments -> textOnly, nothing else called", async () => {
    const deps = makeDeps();
    expect(await decideInbound(msg({ hasAttachments: true }), deps)).toEqual({ kind: "reply", key: "textOnly" });
    onlyCalled(deps);
  });
  it("empty / whitespace text -> textOnly", async () => {
    const deps = makeDeps();
    expect(await decideInbound(msg({ text: "  \n " }), deps)).toEqual({ kind: "reply", key: "textOnly" });
    onlyCalled(deps);
  });
});

describe("step 2: code path", () => {
  const asUnlinked = (over: Partial<DecideDeps> = {}) =>
    makeDeps({ links: { ...makeDeps().links, find: jest.fn(async () => undefined) } as any, ...over });
  const linkedWith = (over: Partial<DecideDeps> = {}) => makeDeps(over);

  it("unlinked and locked out -> silent, audited, consumeCode not called", async () => {
    const deps = asUnlinked({ codeAttemptsExceeded: jest.fn(async () => true) });
    expect(await decideInbound(msg({ text: CODE }), deps)).toEqual({ kind: "silent" });
    expect(deps.audit).toHaveBeenCalledWith({ type: "code_lockout", identity: msg().identity });
    onlyCalled(deps, "codeAttemptsExceeded", "audit", "find");
  });
  it("unlinked, unknown code -> codeInvalid", async () => {
    const deps = asUnlinked({ consumeCode: jest.fn(async () => null) });
    expect(await decideInbound(msg({ text: CODE }), deps)).toEqual({ kind: "reply", key: "codeInvalid" });
    onlyCalled(deps, "codeAttemptsExceeded", "consumeCode", "find");
  });
  it("unlinked, code issued for channel B sent to channel A -> codeInvalid, no link", async () => {
    const deps = asUnlinked({ consumeCode: jest.fn(async () => ({ channelId: "chB", userId: 7 })) });
    expect(await decideInbound(msg({ text: CODE }), deps)).toEqual({ kind: "reply", key: "codeInvalid" });
    onlyCalled(deps, "codeAttemptsExceeded", "consumeCode", "find");
  });
  it("unlinked, user no longer allowed -> codeInvalid, no link", async () => {
    const deps = asUnlinked({ accessAllowed: jest.fn(async () => false) });
    expect(await decideInbound(msg({ text: CODE }), deps)).toEqual({ kind: "reply", key: "codeInvalid" });
    onlyCalled(deps, "codeAttemptsExceeded", "consumeCode", "accessAllowed", "find");
  });
  it("valid code from an unlinked sender -> upsert with ttl, audit linked, reply linked with expiry", async () => {
    const deps = asUnlinked();
    expect(await decideInbound(msg({ text: " abcd 2345 " }), deps)).toEqual({
      kind: "reply",
      key: "linked",
      vars: { expiresAt: new Date("2026-12-16T12:00:00Z") },
    });
    expect(deps.consumeCode).toHaveBeenCalledWith(CODE);
    expect(deps.links.upsert).toHaveBeenCalledWith({
      channelId: "chA", identity: msg().identity, userId: 7, linkTtlDays: 30, now: NOW,
    });
    expect(deps.audit).toHaveBeenCalledWith({ type: "linked", identity: msg().identity, userId: 7 });
    onlyCalled(deps, "codeAttemptsExceeded", "consumeCode", "accessAllowed", "upsert", "audit");
  });
  it("linked user sends a valid code for another user -> linked as that user, no run", async () => {
    const deps = linkedWith({ consumeCode: jest.fn(async () => ({ channelId: "chA", userId: 9 })) });
    expect(await decideInbound(msg({ text: CODE }), deps)).toMatchObject({ kind: "reply", key: "linked" });
    expect(deps.accessAllowed).toHaveBeenCalledWith(9);
    expect(deps.links.upsert).toHaveBeenCalledWith(expect.objectContaining({ userId: 9 }));
    onlyCalled(deps, "codeAttemptsExceeded", "consumeCode", "accessAllowed", "upsert", "audit");
  });
  it("linked user, code-shaped text that does not resolve -> run, not codeInvalid", async () => {
    const deps = linkedWith({ consumeCode: jest.fn(async () => null) });
    expect(await decideInbound(msg({ text: CODE }), deps)).toEqual({ kind: "run", userId: 7, newSession: false });
    expect(deps.codeAttemptsExceeded).toHaveBeenCalledTimes(1);
    expect(deps.links.find).toHaveBeenCalledTimes(1);
    expect(deps.links.touch).toHaveBeenCalledWith("l1", NOW);
    notCalled(deps, "upsert", "revoke");
  });
  it("linked user, code for another channel -> run", async () => {
    const deps = linkedWith({ consumeCode: jest.fn(async () => ({ channelId: "chB", userId: 9 })) });
    expect(await decideInbound(msg({ text: CODE }), deps)).toEqual({ kind: "run", userId: 7, newSession: false });
    notCalled(deps, "upsert");
  });
  it("linked user, locked out, code-shaped text -> run, consumeCode not called", async () => {
    const deps = linkedWith({ codeAttemptsExceeded: jest.fn(async () => true) });
    expect(await decideInbound(msg({ text: CODE }), deps)).toEqual({ kind: "run", userId: 7, newSession: false });
    expect(deps.audit).toHaveBeenCalledWith({ type: "code_lockout", identity: msg().identity });
    expect(deps.links.find).toHaveBeenCalledTimes(1);
    notCalled(deps, "consumeCode", "upsert");
  });
  it("linked user whose access was withdrawn, non-resolving code text -> revoked, linkRequired, never run", async () => {
    const deps = linkedWith({ consumeCode: jest.fn(async () => null), accessAllowed: jest.fn(async () => false) });
    expect(await decideInbound(msg({ text: CODE }), deps)).toMatchObject({ kind: "reply", key: "linkRequired" });
    expect(deps.links.revoke).toHaveBeenCalledWith("l1", NOW);
    notCalled(deps, "touch", "runInFlight", "takeNewSession", "upsert");
  });
  it("a sentence containing a code is not a code: goes to step 4", async () => {
    const deps = makeDeps({ links: { ...makeDeps().links, find: jest.fn(async () => undefined) } as any });
    expect(await decideInbound(msg({ text: `mein code ist ${CODE}` }), deps)).toEqual({
      kind: "reply", key: "linkRequired", vars: { linkUrl: "https://app.example/link" },
    });
    notCalled(deps, "codeAttemptsExceeded", "consumeCode");
  });
  it("a dependency throwing propagates and never runs", async () => {
    const deps = makeDeps({ consumeCode: jest.fn(async () => { throw new Error("redis down"); }) });
    await expect(decideInbound(msg({ text: CODE }), deps)).rejects.toThrow("redis down");
    notCalled(deps, "upsert", "touch");
  });
});

describe("step 3: commands", () => {
  it.each(["/neu", "/new", "  /NEU  ", "/New"])("%j with valid link -> markNewSession + newSession", async (text) => {
    const deps = makeDeps();
    expect(await decideInbound(msg({ text }), deps)).toEqual({ kind: "reply", key: "newSession" });
    expect(deps.markNewSession).toHaveBeenCalledWith(msg().identity);
    onlyCalled(deps, "find", "markNewSession");
  });
  it("/neu with a longer text is not a command", async () => {
    const deps = makeDeps();
    expect((await decideInbound(msg({ text: "/neu bitte" }), deps)).kind).toBe("run");
    notCalled(deps, "markNewSession");
  });
  it("/neu without a link -> linkRequired, no markNewSession", async () => {
    const deps = makeDeps({ links: { ...makeDeps().links, find: jest.fn(async () => undefined) } as any });
    expect(await decideInbound(msg({ text: "/neu" }), deps)).toMatchObject({ kind: "reply", key: "linkRequired" });
    notCalled(deps, "markNewSession", "accessAllowed", "rateLimited", "runInFlight");
  });
  it("/neu with expired link -> linkRequired", async () => {
    const deps = makeDeps({
      links: { ...makeDeps().links, find: jest.fn(async () => link({ expires_at: new Date(NOW.getTime() - 1) })) } as any,
    });
    expect(await decideInbound(msg({ text: "/new" }), deps)).toMatchObject({ kind: "reply", key: "linkRequired" });
    notCalled(deps, "markNewSession");
  });
  it.each(["/abmelden", "/logout", "/LOGOUT"])("%s with valid link -> revoke, audit, unlinked", async (text) => {
    const deps = makeDeps();
    expect(await decideInbound(msg({ text }), deps)).toEqual({ kind: "reply", key: "unlinked" });
    expect(deps.links.revoke).toHaveBeenCalledWith("l1", NOW);
    expect(deps.audit).toHaveBeenCalledWith({ type: "unlinked", identity: msg().identity, userId: 7 });
    onlyCalled(deps, "find", "revoke", "audit");
  });
  it("/abmelden with expired link -> still revoked and unlinked", async () => {
    const deps = makeDeps({
      links: { ...makeDeps().links, find: jest.fn(async () => link({ expires_at: new Date(NOW.getTime() - 1) })) } as any,
    });
    expect(await decideInbound(msg({ text: "/abmelden" }), deps)).toEqual({ kind: "reply", key: "unlinked" });
    expect(deps.links.revoke).toHaveBeenCalledTimes(1);
  });
  it("/abmelden from an unlinked sender -> linkRequired, not an error", async () => {
    const deps = makeDeps({ links: { ...makeDeps().links, find: jest.fn(async () => undefined) } as any });
    expect(await decideInbound(msg({ text: "/abmelden" }), deps)).toMatchObject({ kind: "reply", key: "linkRequired" });
    notCalled(deps, "revoke", "audit", "accessAllowed", "rateLimited", "runInFlight");
  });
  it("/abmelden with an already revoked link -> linkRequired, no second revoke", async () => {
    const deps = makeDeps({
      links: { ...makeDeps().links, find: jest.fn(async () => link({ revoked_at: new Date("2026-11-15T00:00:00Z") })) } as any,
    });
    expect(await decideInbound(msg({ text: "/logout" }), deps)).toMatchObject({ kind: "reply", key: "linkRequired" });
    notCalled(deps, "revoke", "audit");
  });
});

describe("step 4: link not valid", () => {
  const withLink = (l: ChannelLink | undefined, over: Partial<DecideDeps> = {}) =>
    makeDeps({ links: { ...makeDeps().links, find: jest.fn(async () => l) } as any, ...over });

  it("no link -> linkRequired with url", async () => {
    const deps = withLink(undefined);
    expect(await decideInbound(msg(), deps)).toEqual({
      kind: "reply", key: "linkRequired", vars: { linkUrl: "https://app.example/link" },
    });
    onlyCalled(deps, "find", "linkPromptAllowed");
  });
  it("link expired one millisecond ago -> linkRequired", async () => {
    const deps = withLink(link({ expires_at: new Date(NOW.getTime() - 1) }));
    expect(await decideInbound(msg(), deps)).toMatchObject({ kind: "reply", key: "linkRequired" });
    onlyCalled(deps, "find", "linkPromptAllowed");
  });
  it("expiring exactly now -> linkRequired", async () => {
    const deps = withLink(link({ expires_at: NOW }));
    expect(await decideInbound(msg(), deps)).toMatchObject({ key: "linkRequired" });
  });
  it("revoked -> linkRequired", async () => {
    const deps = withLink(link({ revoked_at: new Date("2026-11-15T00:00:00Z") }));
    expect(await decideInbound(msg(), deps)).toMatchObject({ key: "linkRequired" });
    notCalled(deps, "accessAllowed", "touch");
  });
  it("second prompt inside the window -> silent", async () => {
    const deps = withLink(undefined, { linkPromptAllowed: jest.fn(async () => false) });
    expect(await decideInbound(msg(), deps)).toEqual({ kind: "silent" });
    onlyCalled(deps, "find", "linkPromptAllowed");
  });
});

describe("step 5: access re-check", () => {
  it("access denied -> revoke, audit access_rejected, then linkRequired", async () => {
    const deps = makeDeps({ accessAllowed: jest.fn(async () => false) });
    expect(await decideInbound(msg(), deps)).toMatchObject({ kind: "reply", key: "linkRequired" });
    expect(deps.accessAllowed).toHaveBeenCalledWith(7);
    expect(deps.links.revoke).toHaveBeenCalledWith("l1", NOW);
    expect(deps.audit).toHaveBeenCalledWith({ type: "access_rejected", identity: msg().identity, userId: 7 });
    notCalled(deps, "rateLimited", "runInFlight", "touch", "takeNewSession");
  });
  it("access denied and prompt window used -> silent", async () => {
    const deps = makeDeps({
      accessAllowed: jest.fn(async () => false),
      linkPromptAllowed: jest.fn(async () => false),
    });
    expect(await decideInbound(msg(), deps)).toEqual({ kind: "silent" });
    expect(deps.links.revoke).toHaveBeenCalledTimes(1);
    notCalled(deps, "rateLimited", "runInFlight", "touch");
  });
});

describe("steps 6-8", () => {
  it("rate limited -> rateLimited", async () => {
    const deps = makeDeps({ rateLimited: jest.fn(() => true) });
    expect(await decideInbound(msg(), deps)).toEqual({ kind: "reply", key: "rateLimited" });
    expect(deps.rateLimited).toHaveBeenCalledWith(7);
    notCalled(deps, "runInFlight", "touch", "takeNewSession");
  });
  it("run in flight -> stillWorking", async () => {
    const deps = makeDeps({ runInFlight: jest.fn(async () => true) });
    expect(await decideInbound(msg(), deps)).toEqual({ kind: "reply", key: "stillWorking" });
    expect(deps.runInFlight).toHaveBeenCalledWith(msg().identity);
    notCalled(deps, "touch", "takeNewSession");
  });
  it("otherwise touch and run as the linked user", async () => {
    const deps = makeDeps();
    expect(await decideInbound(msg(), deps)).toEqual({ kind: "run", userId: 7, newSession: false });
    expect(deps.links.touch).toHaveBeenCalledWith("l1", NOW);
    notCalled(deps, "revoke", "upsert", "audit", "markNewSession");
  });
  it("/neu then a question -> run newSession true, the next one false", async () => {
    let flag = false;
    const deps = makeDeps({
      markNewSession: jest.fn(async () => { flag = true; }),
      takeNewSession: jest.fn(async () => { const f = flag; flag = false; return f; }),
    });
    expect(await decideInbound(msg({ text: "/neu" }), deps)).toEqual({ kind: "reply", key: "newSession" });
    expect(await decideInbound(msg(), deps)).toEqual({ kind: "run", userId: 7, newSession: true });
    expect(await decideInbound(msg(), deps)).toEqual({ kind: "run", userId: 7, newSession: false });
  });
  it("a throwing dependency never falls through to run", async () => {
    const deps = makeDeps({ runInFlight: jest.fn(async () => { throw new Error("redis down"); }) });
    await expect(decideInbound(msg(), deps)).rejects.toThrow("redis down");
    notCalled(deps, "touch", "takeNewSession");
  });
});

describe("isUserActive", () => {
  it("false for undefined (user row gone)", () => expect(isUserActive(undefined)).toBe(false));
  it("true for any existing row, including one with a status value", () => {
    expect(isUserActive({})).toBe(true);
    expect(isUserActive({ status: null })).toBe(true);
    expect(isUserActive({ status: "disabled" })).toBe(true); // no deactivation rule exists today
  });
});
