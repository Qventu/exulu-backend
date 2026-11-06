/**
 * An agents-scoped API key is a PUBLIC credential: the storefront chat widget
 * ships it in the page source of every shop page. It exists so the browser can
 * run one specific agent — it is not an identity that may read stored
 * conversations.
 *
 * Two holes made that possible:
 *  - `agent_messages` carries no RBAC at all, so applyAccessControl returned the
 *    query unfiltered. Verified against production: the public widget key listed
 *    all 44 stored messages, content included, across other users' sessions.
 *  - `agent_sessions` has RBAC, but `created_by` short-circuits it in
 *    checkRecordAccess. Once the widget creates its own sessions (planned, so
 *    support can review storefront conversations), every one of them would be
 *    owned by that public key's API user and therefore readable by anyone.
 *
 * Reads are refused for both tables by narrowing the query to match nothing,
 * NOT by throwing. applyAccessControl is also called from
 * markSessionSeenForViewer, where an unknown caller previously got a graceful
 * "not visible" — throwing would turn that into an error, and this code ships to
 * every Exulu deployment, not just this one. An empty result fails just as
 * closed and degrades instead of breaking a page.
 *
 * Creating is deliberately NOT affected: CreateOne never runs through
 * applyAccessControl, so the widget can still open a session it can never read
 * back.
 */
import { applyAccessControl } from "./access-control";

const sessionsTable: any = {
  type: "agent_sessions",
  name: { singular: "agent_session", plural: "agent_sessions" },
  RBAC: true,
  fields: [],
};

const messagesTable: any = {
  type: "agent_messages",
  name: { singular: "agent_message", plural: "agent_messages" },
  fields: [],
};

const agentsScopedKey: any = {
  id: 8,
  type: "api",
  scope_mode: "agents",
  agent_ids: ["b280a40d-7ec0-4f04-8f9b-d8c687c0e283"],
};

/** Chainable knex-ish stub; only reached when access is NOT refused. */
const fakeQuery = () => {
  const q: any = {};
  q.where = jest.fn(() => q);
  q.orWhere = jest.fn(() => q);
  q.whereIn = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
  return q;
};

describe("agents-scoped API keys cannot read conversations", () => {
  it("narrows agent_messages to nothing", () => {
    const q = fakeQuery();
    expect(applyAccessControl(messagesTable, q, agentsScopedKey)).toBe(q);
    expect(q.whereRaw).toHaveBeenCalledWith("1 = 0");
    expect(q.where).not.toHaveBeenCalled();
  });

  it("narrows agent_sessions to nothing, before any RBAC filter runs", () => {
    const q = fakeQuery();
    applyAccessControl(sessionsTable, q, agentsScopedKey);
    expect(q.whereRaw).toHaveBeenCalledWith("1 = 0");
    expect(q.where).not.toHaveBeenCalled();
  });

  it("refuses even when the key is super_admin-flagged — scope wins", () => {
    const q = fakeQuery();
    applyAccessControl(messagesTable, q, { ...agentsScopedKey, super_admin: true });
    expect(q.whereRaw).toHaveBeenCalledWith("1 = 0");
  });

  it("does not throw — markSessionSeenForViewer relies on a graceful miss", () => {
    expect(() => applyAccessControl(sessionsTable, fakeQuery(), agentsScopedKey)).not.toThrow();
  });
});

describe("everyone else is unaffected", () => {
  it("lets an admin-scoped API key through", () => {
    const adminKey: any = { id: 2, type: "api", scope_mode: "admin" };
    const q = fakeQuery();
    expect(applyAccessControl(messagesTable, q, adminKey)).toBe(q);
  });

  it("lets a legacy API key without scope_mode through", () => {
    const legacyKey: any = { id: 3, type: "api" };
    const q = fakeQuery();
    expect(applyAccessControl(messagesTable, q, legacyKey)).toBe(q);
  });

  it("lets a signed-in human through — agent_messages has no RBAC to apply", () => {
    const human: any = { id: 4, role: { agents: "read" } };
    const q = fakeQuery();
    expect(applyAccessControl(messagesTable, q, human)).toBe(q);
  });

  it("still applies the normal RBAC filter on agent_sessions for a human", () => {
    const human: any = { id: 4, role: { agents: "read" } };
    const q = fakeQuery();
    applyAccessControl(sessionsTable, q, human);
    expect(q.where).toHaveBeenCalled();
  });
});
