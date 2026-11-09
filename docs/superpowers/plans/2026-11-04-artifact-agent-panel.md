# Artifact Agent Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent assigned to an artifact opens in a chat panel beside it — raised from the artifact's own buttons with the composer prefilled and documents attached, writing into the artifact's data while the user watches.

**Architecture:** The existing identity `MessagePort` between the IMP page and the sandboxed artifact frame becomes a versioned two-way channel: the parent announces host capability, assigned agent slots, panel width and turn progress; the artifact asks for a slot to be opened with prefill and attachments. The panel itself is the real chat surface — `useChatSession` gains a parameterised session destination so it can live on a non-`/chat` URL, and an alternate `ChatShellContext` provider hosts it inside `SidePanel`, exactly as the public guest shell already does.

**Tech Stack:** TypeScript. Backend: Express routes in `src/exulu/routes.ts`, Knex, Jest. Frontend: Next.js App Router, Apollo, AI SDK `useChat`, Radix/shadcn, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-04-artifact-agent-panel-design.md`

Two repositories. Paths are prefixed `backend/` and `frontend/`:
- `backend/` = `/Users/daniel.claessen/Desktop/Projects/exulu/backend`
- `frontend/` = `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`

## Global Constraints

- **Typecheck is an equality, not a threshold.** `npx tsc --noEmit` reports exactly **8** pre-existing errors in each repo at the start of this work. After every task it must still report exactly 8, and they must be the *same* 8 — a drop can mean a stray backtick killed a template literal. Capture the baseline list once before Task 1 and diff against it.
- **Backend tests are typechecked by nothing** (tsconfig excludes them, ts-jest only transpiles, eslint cannot parse them). A fixture can assert a shape no code emits and stay green. Import types and constants from source into tests rather than hand-writing the shape.
- **`addMissingFields` only ever adds columns.** A field shipped with the wrong shape cannot be reshaped. This is why assignments are slots (see Task 1).
- **Prefill never submits.** Every path that seeds the composer fills the textarea and stops. This is already the deliberate rule at `frontend/app/(application)/chat/components/composer.tsx:325`.
- **Channel version is `2`.** `IDENTITY_V = 1` in the existing handshake becomes the channel version `CHANNEL_V = 2`; v1 `exulu:identity:*` messages keep working so a deployed artifact built against v1 is unaffected.
- **The assignment list is the only trust boundary.** Every artifact→parent open request is validated against it server-rendered-side, every time. An artifact may never name an agent id directly.
- **No new chat implementation.** Editing `useChatSession` is sanctioned; forking it is not.
- Commands: backend `npx jest <path>`, `npm run lint`; frontend `npx vitest run <path>`, `npm run lint`.

## Review Focus

Five conditions the spec implies that no task's happy path exercises. Each gets a test in the task that owns the code, listed in that task's steps.

1. **An open request for a slot that is not assigned, or whose agent the user cannot reach** — must be ignored silently, never opened. The port is reachable by any code inside the artifact bundle, including a compromised dependency. (Task 5)
2. **An adopt request naming a key outside the caller's own prefix** — `user_<someone-else>/…`, `global/…`, a `..` traversal, or a bare un-prefixed key — must be 403, not a copy. (Task 3)
3. **A turn finishing after the panel closed or the frame reloaded** — the port is closed; emitting progress into it must not throw and must not be retried. (Task 10)
4. **`?session=` naming a session that belongs to another agent or another user** — must fall back to a new chat, never render someone else's conversation. (Task 8)
5. **An open request arriving before the parent has hydrated** — the identity client retries until answered, but an open request has no retry. It must either be answered or provably dropped before the artifact's button re-enables, never left pending forever. (Task 5)

---

### Task 1: `agent_slots` on `shared_artifacts`

**Files:**
- Modify: `backend/src/postgres/core-schema.ts:968-1001` (`sharedArtifactsSchema.fields`)
- Modify: `backend/src/exulu/shared-artifacts.ts` (add `AgentSlot`, `validateAgentSlots`; extend `UpdateShareInput`, `validateUpdateInput`, `planShareUpdate`)
- Modify: `backend/src/exulu/routes.ts:5287` (settings route response), `:5325` (PATCH route), plus a new read route beside them
- Test: `backend/src/exulu/shared-artifacts.test.ts`, `backend/src/postgres/core-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type AgentSlot = { key: string; agentId: string }`;
  `export const validateAgentSlots = (value: unknown) => { ok: true; slots: AgentSlot[] } | { ok: false; message: string }`.
  The column is `agent_slots`, type `json`, nullable, read by the settings route as `agent_slots: AgentSlot[]` (empty array when null).
  Also `GET /shared-artifacts/:name/panel` → `{ agent_slots: AgentSlot[] }`, for a *viewer* rather than the creator.

**Why a separate read route:** the settings route is creator-or-super-admin only (`canManageShare`, `routes.ts:5287`), so a viewer could not read it — but `/meta` is fetched with no credentials at all (`frontend/app/(application)/artifacts/open/[name]/page.tsx`), so putting slots there would publish agent ids to anyone with the share name. The new route authenticates, requires `auth_mode === "regular"`, and runs the same access check the `/access` route performs, then returns the raw slots. Filtering to agents the user can actually reach happens in the frontend (Task 8), which already has an RBAC-scoped agents query.

- [ ] **Step 1: Write the failing tests**

In `shared-artifacts.test.ts`:

```ts
describe("validateAgentSlots", () => {
  test("accepts a well-formed list", () => {
    const r = validateAgentSlots([{ key: "analyse", agentId: "a1" }]);
    expect(r).toEqual({ ok: true, slots: [{ key: "analyse", agentId: "a1" }] });
  });
  test("accepts an empty list", () => {
    expect(validateAgentSlots([])).toEqual({ ok: true, slots: [] });
  });
  test("rejects a non-array", () => {
    expect(validateAgentSlots({ key: "a" }).ok).toBe(false);
  });
  test("rejects a blank or non-string key", () => {
    expect(validateAgentSlots([{ key: "  ", agentId: "a1" }]).ok).toBe(false);
    expect(validateAgentSlots([{ key: 7, agentId: "a1" }]).ok).toBe(false);
  });
  test("rejects a blank or non-string agentId", () => {
    expect(validateAgentSlots([{ key: "a", agentId: "" }]).ok).toBe(false);
  });
  test("rejects duplicate keys — a button could not bind unambiguously", () => {
    const r = validateAgentSlots([
      { key: "analyse", agentId: "a1" },
      { key: "analyse", agentId: "a2" },
    ]);
    expect(r.ok).toBe(false);
  });
  test("ignores unknown properties rather than storing them", () => {
    const r = validateAgentSlots([{ key: "a", agentId: "a1", extra: 1 }]);
    expect(r).toEqual({ ok: true, slots: [{ key: "a", agentId: "a1" }] });
  });
});

describe("validateUpdateInput with agent_slots", () => {
  const row = { name: "x", auth_mode: "regular", password_hash: null, rights_mode: "private", created_by: 1 };
  test("rejects a malformed agent_slots payload", () => {
    expect(validateUpdateInput({ agent_slots: "nope" } as any, row, new Date()).ok).toBe(false);
  });
});

describe("planShareUpdate with agent_slots", () => {
  const row = { name: "x", auth_mode: "regular", password_hash: null, rights_mode: "private", created_by: 1 };
  test("writes normalised slots when given", () => {
    const patch = planShareUpdate({ agent_slots: [{ key: "a", agentId: "a1", extra: 1 }] } as any, row, null, new Date());
    expect(patch.agent_slots).toEqual([{ key: "a", agentId: "a1" }]);
  });
  test("omits the column when not given", () => {
    expect("agent_slots" in planShareUpdate({}, row, null, new Date())).toBe(false);
  });
});
```

In `core-schema.test.ts`, inside the existing `shared_artifacts schema` describe:

```ts
test("carries the agent_slots json field", () => {
  const field = schema.fields.find((f) => f.name === "agent_slots");
  expect(field).toMatchObject({ name: "agent_slots", type: "json" });
  expect(field?.required).not.toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/exulu/shared-artifacts.test.ts src/postgres/core-schema.test.ts`
Expected: FAIL — `validateAgentSlots is not a function`, and the schema field is undefined.

- [ ] **Step 3: Add the field and the validator**

Add `{ name: "agent_slots", type: "json" }` to `sharedArtifactsSchema.fields`.

Implement `validateAgentSlots` in `shared-artifacts.ts`. It returns the **normalised** slots (only `key` and `agentId`, keys trimmed) so the caller never stores whatever the client sent — the same reason `planShareUpdate` already slugifies `name`.

- [ ] **Step 4: Wire the routes**

Add `agent_slots?: unknown` to `UpdateShareInput`. In `validateUpdateInput`, when `input.agent_slots !== undefined`, return the validator's failure message. In `planShareUpdate`, set `patch.agent_slots` to the normalised slots only when the input carried the key.

In the settings route response (`routes.ts:5287`), add `agent_slots: row.agent_slots ?? []`. In the PATCH response, add the same.

- [ ] **Step 5: Add the viewer read route**

`GET /shared-artifacts/:name/panel`: authenticate; 404 on a missing row; 404 when `row.auth_mode !== "regular"` (the same shape the identity route uses, so a public share reveals nothing about whether slots exist); run the access check the `/access` route runs; then respond `{ agent_slots: row.agent_slots ?? [] }`.

Add a test asserting a non-`regular` row answers 404 rather than an empty list.

- [ ] **Step 6: Run the tests and the gates**

Run: `npx jest src/exulu/shared-artifacts.test.ts src/postgres/core-schema.test.ts`
Expected: PASS
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → exactly `8`
Run: `npm run lint`

- [ ] **Step 7: Commit**

```bash
git add src/postgres/core-schema.ts src/exulu/shared-artifacts.ts src/exulu/shared-artifacts.test.ts src/postgres/core-schema.test.ts src/exulu/routes.ts
git commit -m "feat(artifacts): agent_slots on shared_artifacts"
```

---

### Task 2: Assignment UI in the artifact sharing form

**Files:**
- Modify: `frontend/lib/api/shared-artifacts.ts` (`ShareSettings`, `UpdateShareInput`, `AgentSlot`)
- Create: `frontend/app/(application)/artifacts/components/agent-slots-field.tsx`
- Create: `frontend/app/(application)/artifacts/components/agent-slots-field.test.tsx`
- Modify: `frontend/app/(application)/artifacts/components/sharing-form.tsx` (`SharingValue`, `sharingPayload`, render the field)
- Modify: `frontend/app/(application)/artifacts/components/sharing-dialog.tsx` (load/seed the slots)

**Interfaces:**
- Consumes: Task 1's `agent_slots` on `GET /shared-artifacts/:name/settings` and `PATCH /shared-artifacts/:name`.
- Produces: `export interface AgentSlot { key: string; agentId: string }` in `lib/api/shared-artifacts.ts`;
  `AgentSlotsField` with props `{ value: AgentSlot[]; onChange: (slots: AgentSlot[]) => void; disabled?: boolean; isApp: boolean }`;
  `SharingValue` gains `agentSlots: AgentSlot[]`, and `sharingPayload` emits `agent_slots` only when `authMode === "regular"`.

- [ ] **Step 1: Write the failing test**

`agent-slots-field.test.tsx` (follow the `// @vitest-environment jsdom` + explicit `afterEach(cleanup)` header style of `frontend/app/artifacts/[artifact_name]/artifact-frame.test.tsx`; mock the `GET_AGENTS` query at the Apollo hook the way `agent-grid.test.tsx` does):

```tsx
test("renders nothing for a non-app artifact", () => {
  const { container } = render(<AgentSlotsField value={[]} onChange={() => {}} isApp={false} />);
  expect(container.textContent).toBe("");
});

test("adding a slot reports a key and the chosen agent", async () => { /* onChange called with [{ key: "analyse", agentId: "a1" }] */ });

test("a duplicate key is rejected in the UI before save", async () => { /* the add control stays disabled and an error is shown */ });

test("removing a slot reports the remaining list", async () => { /* onChange called with [] */ });
```

Add to `sharing-form.test.tsx` (create it if absent):

```tsx
test("sharingPayload omits agent_slots outside regular mode", () => {
  const value = { authMode: "public", expiry: "never", rightsMode: "public", rbac: EMPTY_RBAC, agentSlots: [{ key: "a", agentId: "a1" }] } as any;
  expect("agent_slots" in sharingPayload(value)).toBe(false);
});
test("sharingPayload includes agent_slots in regular mode", () => {
  const value = { authMode: "regular", expiry: "never", rightsMode: "private", rbac: EMPTY_RBAC, agentSlots: [{ key: "a", agentId: "a1" }] } as any;
  expect(sharingPayload(value).agent_slots).toEqual([{ key: "a", agentId: "a1" }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run "app/(application)/artifacts/components/agent-slots-field.test.tsx" "app/(application)/artifacts/components/sharing-form.test.tsx"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `AgentSlotsField`**

A list of `{ key, agentId }` rows plus an add control: a free-text key input and an agent `Select` populated from the shared `GET_AGENTS` in `frontend/queries/queries.ts:154` — not the chat feature's own copy at `app/(application)/chat/queries.ts:145`, which would couple the artifacts feature to chat internals. Returns `null` when `isApp` is false — the spec hides assignment for non-app artifacts entirely.

The key is explained in its own helper text: it is what the artifact's code names, so it must not change casually. New strings go in the existing `artifacts` namespace of `frontend/messages/en.json` and `de.json` — both files, or the German UI falls back to English mid-form.

- [ ] **Step 4: Thread it through the form and dialog**

Add `agentSlots: AgentSlot[]` to `SharingValue`, render `AgentSlotsField` inside the existing `value.authMode === "regular"` branch (`sharing-form.tsx:100`), and emit `agent_slots` from `sharingPayload` in that branch only. Seed from `getSettings().agent_slots` in the dialog; default `[]`.

`isApp` comes from `artifactType(displayFilename(filename)).kind === "app"` using `frontend/lib/artifacts/artifact-type.ts`.

- [ ] **Step 5: Run the tests and the gates**

Run: `npx vitest run "app/(application)/artifacts/components"`
Expected: PASS
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → exactly `8`
Run: `npm run lint`

- [ ] **Step 6: Commit**

```bash
git add lib/api/shared-artifacts.ts "app/(application)/artifacts/components" messages/en.json messages/de.json
git commit -m "feat(artifacts): assign agent slots in the sharing form"
```

---

### Task 3: Adopt endpoint — copy the caller's own uploads into a session

**Files:**
- Create: `backend/src/exulu/session-file-adopt.ts`
- Create: `backend/src/exulu/session-file-adopt.test.ts`
- Modify: `backend/src/exulu/routes.ts` (new route beside the other session-files routes, after `:4841`)

**Interfaces:**
- Consumes: `ownsObjectKey` and `normalizeS3Key` from `src/exulu/shared-artifacts.ts`; `loadSessionFilesAuth` and `sanitizeFilename` already in `routes.ts`; `sessionFilePrefix` from `src/exulu/session-files.ts`.
- Produces: `POST /sessions/:sessionId/files/adopt`, body `{ keys: string[] }`, response `{ adopted: Array<{ key: string; name: string }>; rejected: Array<{ key: string; reason: string }> }`.
  `export const planAdoptKeys = (keys: unknown, user: {...}, s3prefix: string | null | undefined, bucket: string) => { accepted: Array<{ source: string; filename: string }>; rejected: Array<{ key: string; reason: string }> }`.

**Why a pure planner:** every rejection rule in the Review Focus is a string-shape decision, and these are the rules that fail silently when wrong. They are tested without S3.

- [ ] **Step 1: Write the failing test**

```ts
const user = { id: 42, super_admin: false, type: "user" };

describe("planAdoptKeys", () => {
  test("accepts a key under the caller's own prefix", () => {
    const r = planAdoptKeys(["user_42/abc-_EXULU_brief.pdf"], user, null, "bucket");
    expect(r.accepted).toEqual([{ source: "user_42/abc-_EXULU_brief.pdf", filename: "brief.pdf" }]);
    expect(r.rejected).toEqual([]);
  });
  test("strips a leading bucket segment before judging ownership", () => {
    const r = planAdoptKeys(["bucket/user_42/abc-_EXULU_brief.pdf"], user, null, "bucket");
    expect(r.accepted).toHaveLength(1);
  });
  test("honours the instance general prefix", () => {
    const r = planAdoptKeys(["pre/user_42/abc-_EXULU_b.pdf"], user, "pre", "bucket");
    expect(r.accepted).toHaveLength(1);
  });
  test("rejects another user's prefix", () => {
    expect(planAdoptKeys(["user_43/x.pdf"], user, null, "bucket").accepted).toEqual([]);
  });
  test("rejects a global/ key — allowlist, not denylist", () => {
    expect(planAdoptKeys(["global/x.pdf"], user, null, "bucket").accepted).toEqual([]);
  });
  test("rejects an unprefixed key", () => {
    expect(planAdoptKeys(["x.pdf"], user, null, "bucket").accepted).toEqual([]);
  });
  test("rejects a traversal", () => {
    expect(planAdoptKeys(["user_42/../user_43/x.pdf"], user, null, "bucket").accepted).toEqual([]);
  });
  test("an api-type caller is NOT a wildcard", () => {
    const api = { id: 9, super_admin: false, type: "api" };
    expect(planAdoptKeys(["user_42/x.pdf"], api, null, "bucket").accepted).toEqual([]);
  });
  test("rejects a non-array body and a non-string entry", () => {
    expect(planAdoptKeys("user_42/x.pdf", user, null, "bucket").accepted).toEqual([]);
    expect(planAdoptKeys([7], user, null, "bucket").rejected).toHaveLength(1);
  });
  test("every rejection carries a reason", () => {
    const r = planAdoptKeys(["global/x.pdf", "user_43/y.pdf"], user, null, "bucket");
    expect(r.rejected.every((x) => typeof x.reason === "string" && x.reason.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/exulu/session-file-adopt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `planAdoptKeys`**

Normalise with `normalizeS3Key`, reject anything containing `..`, then judge with `ownsObjectKey`. `filename` is the stored basename with the `<uuid>-_EXULU_` prefix stripped — `deriveFilename` in `shared-artifacts.ts` already does exactly this; reuse it, then pass the result through `sanitizeFilename`.

**Do not** reproduce the delete route's `user.type !== "api" && …` shape (`src/uppy/index.ts:498`): here an api-type caller owns `user_api/` and nothing else, which is what `ownsObjectKey` already implements.

- [ ] **Step 4: Implement the route**

`POST /sessions/:sessionId/files/adopt`, guarded by `loadSessionFilesAuth(req, res, sessionId, "write")` so the session's RBAC decides, and writing to `fullSessionPrefix` — built from the session **owner**, as every other session-files route does.

For each accepted key: `CopyObjectCommand` into `<fullSessionPrefix><filename>`, then the same `syncToSandbox` work the existing route does, so the agent sees the file on its next turn.

Server-side size cap: `HeadObjectCommand` on the source and refuse over the limit `frontend/app/(application)/chat/components/session-files/utils.ts` enforces client-side (`MAX_UPLOAD_BYTES`), since an adopt path routes around that check. Do **not** add a page-count check — `EXULU_ATTACHMENT_MAX_PAGES` is enforced at read time by `extractDocument` and is inherited for free.

**All-or-nothing.** If `planAdoptKeys` rejects *any* key, for any reason, copy nothing and answer 403 with the `rejected` list in the body for diagnostics. A partial copy would leave the user looking at a files panel that is missing a document they watched themselves attach, with nothing to say so. The success response therefore always has an empty `rejected`; add a test asserting that.

- [ ] **Step 5: Run the tests and the gates**

Run: `npx jest src/exulu/session-file-adopt.test.ts`
Expected: PASS
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → exactly `8`
Run: `npm run lint`

- [ ] **Step 6: Commit**

```bash
git add src/exulu/session-file-adopt.ts src/exulu/session-file-adopt.test.ts src/exulu/routes.ts
git commit -m "feat(sessions): adopt the caller's own uploads as session files"
```

---

### Task 4: The channel protocol module

**Files:**
- Create: `frontend/lib/artifacts/agent-panel-protocol.ts`
- Create: `frontend/lib/artifacts/agent-panel-protocol.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `agent-panel-protocol.ts`:

```ts
export const CHANNEL_V = 2;
export interface PanelSlot { key: string; label: string }
export interface HostInfo { type: "exulu:host:info"; v: number; panel: boolean; slots: PanelSlot[] }
export interface PanelViewport { type: "exulu:panel:viewport"; v: number; width: number; open: boolean }
export interface TurnProgress { type: "exulu:session:progress"; v: number; reason: "tool" | "turn" }
export interface OpenPanelRequest {
  type: "exulu:panel:open"; v: number; slot: string;
  prompt?: string; items?: string[]; files?: string[];
}
export interface OpenPanelAck { type: "exulu:panel:open:ack"; v: number; slot: string; accepted: boolean; reason?: string }
export const parseOpenPanelRequest: (data: unknown) => OpenPanelRequest | null;
export const hostInfo: (panel: boolean, slots: PanelSlot[]) => HostInfo;
export const panelViewport: (width: number, open: boolean) => PanelViewport;
export const turnProgress: (reason: "tool" | "turn") => TurnProgress;
export const openPanelAck: (slot: string, accepted: boolean, reason?: string) => OpenPanelAck;
```

`PanelSlot.label` is the agent's display name, for a picker; the artifact binds on `key`. Agent ids never cross the channel.

- [ ] **Step 1: Write the failing test**

```ts
test("parseOpenPanelRequest accepts a minimal request", () => {
  expect(parseOpenPanelRequest({ type: "exulu:panel:open", v: 2, slot: "analyse" }))
    .toEqual({ type: "exulu:panel:open", v: 2, slot: "analyse" });
});
test("carries prompt, items and files through", () => { /* all three preserved */ });
test("rejects a wrong version", () => {
  expect(parseOpenPanelRequest({ type: "exulu:panel:open", v: 1, slot: "a" })).toBeNull();
});
test("rejects a wrong type, a missing slot, and a non-string slot", () => { /* three nulls */ });
test("rejects non-string entries inside items/files rather than passing them on", () => {
  expect(parseOpenPanelRequest({ type: "exulu:panel:open", v: 2, slot: "a", files: ["ok", 7] })).toBeNull();
});
test("drops unknown properties", () => {
  const r = parseOpenPanelRequest({ type: "exulu:panel:open", v: 2, slot: "a", evil: 1 } as any);
  expect(r && "evil" in r).toBe(false);
});
test("the builders stamp CHANNEL_V", () => {
  expect(hostInfo(true, []).v).toBe(CHANNEL_V);
  expect(panelViewport(640, true).v).toBe(CHANNEL_V);
  expect(turnProgress("turn").v).toBe(CHANNEL_V);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/artifacts/agent-panel-protocol.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

A pure module: no React, no DOM, no network. `parseOpenPanelRequest` validates and **re-constructs** the object field by field rather than returning the input, so unknown properties cannot reach a consumer.

- [ ] **Step 4: Run the test and the gates**

Run: `npx vitest run lib/artifacts/agent-panel-protocol.test.ts`
Expected: PASS
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → exactly `8`

- [ ] **Step 5: Commit**

```bash
git add lib/artifacts/agent-panel-protocol.ts lib/artifacts/agent-panel-protocol.test.ts
git commit -m "feat(artifacts): agent panel channel protocol v2"
```

---

### Task 5: `ArtifactFrame` carries the channel

**Files:**
- Modify: `frontend/app/artifacts/[artifact_name]/artifact-frame.tsx`
- Modify: `frontend/app/artifacts/[artifact_name]/artifact-frame.test.tsx`

**Interfaces:**
- Consumes: Task 4's protocol module.
- Produces: `ArtifactFrame` gains props

```ts
panel?: {
  slots: PanelSlot[];
  onOpenRequest: (req: OpenPanelRequest) => void;
  viewport?: { width: number; open: boolean };
  progressNonce?: number;
  progressReason?: "tool" | "turn";
};
```

Absent `panel` means this host has none — the frame then announces `panel: false` with no slots. The share route passes nothing; Task 8's viewer passes the object.

**Read the comment block at the top of `artifact-frame.tsx` before editing.** The port-first handshake exists because a sandboxed frame can navigate itself between a request and an awaited reply; nothing here may post a credential at a window, and sender checks stay synchronous with the `postMessage` that follows them.

- [ ] **Step 1: Write the failing tests**

Extend `artifact-frame.test.tsx`, reusing its existing `stubFetch` / `spyPost` helpers and its `MessageChannel` plumbing:

```tsx
test("announces host info with panel:false and no slots when no panel prop is given", async () => { /* hostInfo on port1, panel false, slots [] */ });

test("announces the assigned slots when a panel is present", async () => { /* slots: [{ key: "analyse", label: "Pitch-Agent" }] */ });

test("an open request for an assigned slot reaches onOpenRequest and is acked accepted", async () => { /* ack.accepted true */ });

// Review Focus 1
test("an open request for an unassigned slot is NOT forwarded and is acked rejected", async () => {
  // onOpenRequest not called; ack.accepted === false with a reason
});

// Review Focus 5
test("an open request that arrives before the panel prop exists is acked rejected, never left pending", async () => {
  // the artifact's button can re-enable on the ack
});

test("a malformed open request is ignored entirely — no ack, no call", async () => { /* v:1, wrong type, non-string slot */ });

test("open requests arriving over the window instead of the port are ignored", async () => {
  // only exulu:identity:request is answered at the window
});

test("a viewport change posts panelViewport over the port", async () => { /* width + open */ });

test("a progressNonce bump posts turnProgress once per bump", async () => { /* one message per change, not per render */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run "app/artifacts/[artifact_name]/artifact-frame.test.tsx"`
Expected: FAIL — the new props do not exist; no host-info message is posted.

- [ ] **Step 3: Extend the frame**

Post `hostInfo(...)` over `port1` immediately after the channel handoff, in the same place the grant is sent. Add a `port1.onmessage` branch for `parseOpenPanelRequest` — note the existing handler only recognises `exulu:identity:refresh`, so this is a second branch on the **same** handler, not a reassignment.

Validate the requested `slot` against `panel.slots` here, inside the frame, and ack either way. Forward only accepted requests to `onOpenRequest`.

Post `panelViewport` when `panel.viewport` changes and `turnProgress` when `panel.progressNonce` changes — both in effects keyed on those values, so a re-render alone sends nothing.

Keep the identity flow untouched: still one grant per frame load, still reset by the iframe's `load` event.

- [ ] **Step 4: Run the tests and the gates**

Run: `npx vitest run "app/artifacts/[artifact_name]/artifact-frame.test.tsx"`
Expected: PASS
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → exactly `8`
Run: `npm run lint`

- [ ] **Step 5: Commit**

```bash
git add "app/artifacts/[artifact_name]/artifact-frame.tsx" "app/artifacts/[artifact_name]/artifact-frame.test.tsx"
git commit -m "feat(artifacts): host info, viewport and progress on the artifact channel"
```

---

### Task 6: Parameterise the session destination in `useChatSession`

**Files:**
- Modify: `frontend/app/(application)/chat/hooks.ts` (`UseChatSessionArgs:110`, the `replaceState` at `:727`)
- Modify: `frontend/app/(application)/chat/components/session-screen.tsx` (pass the new arg through)
- Create: `frontend/app/(application)/chat/hooks-session-path.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `UseChatSessionArgs` gains `sessionPath?: (sessionId: string) => string`, defaulting to `` (id) => `/chat/${agent.id}/${id}` `` — byte-identical to today's literal. `SessionScreenProps` gains the same optional prop and forwards it.

**Why:** mounted in the panel as written, the first send rewrites the *artifact page's* URL to `/chat/...`, so a reload leaves the artifact, `useSearchParams()` changes under the composer, and `isChatSessionRoute(pathname)` flips the shell's height class.

- [ ] **Step 1: Write the failing test**

Follow the mock header of the existing `hooks-session-catchup.test.tsx` (it already mocks `next/navigation`, including `useSearchParams`).

```tsx
test("defaults to the /chat literal", async () => {
  // drive a lazy create; expect replaceState called with `/chat/agent-1/session-9`
});
test("uses sessionPath when supplied", async () => {
  // sessionPath: (id) => `/artifacts/open/pitch?session=${id}`
  // expect replaceState called with exactly that
});
test("the destination is read at call time, not captured at mount", async () => {
  // re-render with a different sessionPath before the create resolves; the new one wins
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run "app/(application)/chat/hooks-session-path.test.tsx"`
Expected: FAIL — `sessionPath` is not an accepted argument; the literal is always used.

- [ ] **Step 3: Implement**

Add the optional arg and replace the hardcoded template at `hooks.ts:727`. Hold it in a ref updated by effect, as `disabledToolsRef` and `modelOverrideRef` already do in this file, so an in-flight create reads the current value rather than a stale closure.

Leave the `flowIsCurrent()` guard, the `currentSessionRef` sync and the `replaceState`-not-`router.replace` choice exactly as they are — the comment there explains that a real navigation would swap in `loading.tsx` and kill the in-flight stream.

- [ ] **Step 4: Run the tests and the gates**

Run: `npx vitest run "app/(application)/chat"`
Expected: PASS — the whole chat suite, since this touches shared transport.
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → exactly `8`
Run: `npm run lint`

- [ ] **Step 5: Commit**

```bash
git add "app/(application)/chat/hooks.ts" "app/(application)/chat/components/session-screen.tsx" "app/(application)/chat/hooks-session-path.test.tsx"
git commit -m "refactor(chat): parameterise the session URL destination"
```

---

### Task 7: The panel host

**Files:**
- Create: `frontend/app/(application)/artifacts/open/[name]/agent-panel.tsx`
- Create: `frontend/app/(application)/artifacts/open/[name]/agent-panel.test.tsx`
- Create: `frontend/app/(application)/artifacts/open/[name]/use-transient-nav-collapse.ts`
- Create: `frontend/app/(application)/artifacts/open/[name]/use-transient-nav-collapse.test.ts`

**Interfaces:**
- Consumes: `ChatShellContext` + `ChatShellContextValue` from `chat/components/chat-shell.tsx`; `HistoryRail` + `HistoryRailPaths`; `SessionScreen`; Task 6's `sessionPath`.
- Produces: `AgentPanel` with props `{ agent: Agent; initialSession: AgentSession | null; initialMessages: UIMessage[]; artifactName: string; open: boolean; onClose: () => void; onWidthChange: (width: number) => void; onProgress: (reason: "tool" | "turn") => void }`.

`onProgress` is declared here but not yet called — Task 10 owns the hook that fires it. It belongs on this component because the chat controller only exists inside the panel; the viewer cannot reach it. Declare the prop, accept it, and leave it unused this task (one line in the test asserting it is optional-safe is enough).

**Pattern to copy:** `frontend/app/public/agents/[id]/components/public-chat-shell.tsx` already supplies `ChatShellContext` itself and passes `HistoryRailPaths` with `?session=<sid>`. That is this task, with a different base path. Do **not** reimplement the controller the way `use-public-chat-session.ts` did.

- [ ] **Step 1: Write the failing tests**

`use-transient-nav-collapse.test.ts`:

```ts
test("collapses the nav while active", () => { /* setOpen(false) equivalent applied */ });
test("restores the previous state on deactivate", () => { /* back to its prior value */ });
test("never writes the sidebar_state cookie", () => {
  // document.cookie is unchanged across activate + deactivate
});
```

`agent-panel.test.tsx`:

```tsx
test("renders nothing when closed", () => {});
test("supplies ChatShellContext so HistoryRail mounts without throwing", () => {});
test("rail session links point at the artifact URL, not /chat", () => {
  // href contains /artifacts/open/pitch?session=
});
test("reports its width on mount and on resize", () => { /* onWidthChange called */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run "app/(application)/artifacts/open"`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `useTransientNavCollapse`**

`SidebarProvider.setOpen` writes the `sidebar_state` cookie (`frontend/components/ui/sidebar.tsx:92`), so calling it would overwrite the user's global preference for every page in the IMP. Collapse by the means that does not persist — read `components/ui/sidebar.tsx` and use the non-persisting path, or capture the prior value and restore it on deactivate. The test is the contract: `document.cookie` must not change.

- [ ] **Step 4: Implement `AgentPanel`**

Host `SessionScreen` inside `SidePanel` (`frontend/components/primitives/side-panel.tsx`) with a `storageKey` so the dragged width persists, supplying `ChatShellContext` and a `HistoryRailPaths` of
`` { session: (sid) => `/artifacts/open/${name}?session=${sid}`, newChat: `/artifacts/open/${name}`, search: null } ``.

Pass `sessionPath` into `SessionScreen` so a lazy create lands on the artifact URL.

The panel collapses to a thin edge as well as closing, per the spec — collapsed keeps the session mounted.

- [ ] **Step 5: Run the tests and the gates**

Run: `npx vitest run "app/(application)/artifacts/open"`
Expected: PASS
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → exactly `8`
Run: `npm run lint`

- [ ] **Step 6: Commit**

```bash
git add "app/(application)/artifacts/open/[name]"
git commit -m "feat(artifacts): agent panel host beside the artifact"
```

---

### Task 8: CTA and URL wiring on the artifact viewer

**Files:**
- Modify: `frontend/app/(application)/artifacts/open/[name]/page.tsx`
- Modify: `frontend/app/(application)/artifacts/open/[name]/viewer-client.tsx`
- Create: `frontend/app/(application)/artifacts/open/[name]/viewer-client.test.tsx`

**Interfaces:**
- Consumes: Task 1's `GET /shared-artifacts/:name/panel`, Task 5's `panel` prop, Task 7's `AgentPanel`.
- Produces: `ArtifactViewerProps` gains `slots: ResolvedSlot[]`, `initialSession: AgentSession | null`, `initialMessages: UIMessage[]`, where
  `type ResolvedSlot = { key: string; label: string; agent: Agent }`. The page accepts `?agent=<slotKey>` and `?session=<id>` search params.

**`ResolvedSlot` carries the whole `Agent`, not just its id**, because `AgentPanel` (Task 7) needs the `Agent` object that `SessionScreen` and `HistoryRail` both take. Resolving it again client-side would be a second fetch of data the page already holds.

**Three slot types, deliberately.** `AgentSlot { key, agentId }` is the stored shape and what crosses the wire to the server. `PanelSlot { key, label }` from Task 4 is what crosses the channel into the artifact — **agent ids never reach the frame**. `ResolvedSlot { key, label, agent }` is the viewer's internal join; map it down to `PanelSlot` when passing `panel.slots` to `ArtifactFrame`.

**Out of scope here:** `?q=` on the artifact page. The spec lists it as optional, and Task 9 gives the panel a seed channel that does not need it.

- [ ] **Step 1: Write the failing tests**

```tsx
test("no CTA when the artifact has no slots", () => {});
test("one slot renders a single button labelled with the agent name", () => {});
test("several slots render one trigger that opens a picker", () => {});
test("a slot whose agent the user cannot reach is not offered", () => {
  // agents list lacks that id → the slot is dropped
});
test("no CTA for a non-app artifact even if slots exist", () => {});
test("choosing an agent opens the panel and collapses the nav", () => {});

// Review Focus 4
test("?session= naming a session of another agent falls back to a new chat", () => {
  // the panel mounts with initialSession null, no foreign messages rendered
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run "app/(application)/artifacts/open/[name]/viewer-client.test.tsx"`
Expected: FAIL — no CTA is rendered.

- [ ] **Step 3: Server-side data in `page.tsx`**

Keep the existing meta → credential → content sequence exactly as it is; the file's header comment explains why each step is in that order. Then, only for `auth_mode === "regular"` **and** `meta.is_html`:

- read the slots from `GET /shared-artifacts/:name/panel` with the viewer's JWT (the same credential the page already mints for `regular` mode);
- fetch the reachable agents (`GET_AGENTS` from `frontend/queries/queries.ts` via `fetchGraphQLServerSide`) and build a `ResolvedSlot` per slot whose `agentId` is present, dropping the rest — this is where "only agents the user may reach are offered" is enforced;
- when `?session=` is given, load it the way `chat/[agent]/[session]/page.tsx` does (`GET_AGENT_SESSION_BY_ID` then `GET_AGENT_MESSAGES`) and **discard it unless its `agent` matches the slot's agent**, which is Review Focus 4.

- [ ] **Step 4: CTA in `viewer-client.tsx`**

Add the trigger to the existing header row, beside the favourite/open/download buttons — one `Button` for a single slot, one `DropdownMenu` for several. Render `AgentPanel` as a sibling of the content region, and pass `panel={{ slots, onOpenRequest, viewport, progressNonce }}` into `ArtifactFrame`.

New i18n keys go in the existing `artifacts` namespace in `frontend/messages/en.json` and `de.json`.

- [ ] **Step 5: Run the tests and the gates**

Run: `npx vitest run "app/(application)/artifacts"`
Expected: PASS
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → exactly `8`
Run: `npm run lint`

- [ ] **Step 6: Commit**

```bash
git add "app/(application)/artifacts/open/[name]" messages/en.json messages/de.json
git commit -m "feat(artifacts): open an assigned agent beside the artifact"
```

---

### Task 9: Prefill and attachments from an open request

**Files:**
- Modify: `frontend/app/(application)/chat/hooks.ts` (add `seedInput` / `pendingInput`, add `addSessionFiles`)
- Modify: `frontend/app/(application)/chat/components/composer.tsx` (consume the seed)
- Modify: `frontend/lib/api/session-files.ts` (adopt client)
- Create: `frontend/app/(application)/artifacts/open/[name]/apply-open-request.ts`
- Create: `frontend/app/(application)/artifacts/open/[name]/apply-open-request.test.ts`
- Create: `frontend/app/(application)/chat/hooks-seed-input.test.tsx`
- Modify: `frontend/app/(application)/artifacts/open/[name]/viewer-client.tsx` (apply a request)

**Interfaces:**
- Consumes: Task 4's `OpenPanelRequest`, Task 3's adopt endpoint, the existing `controller.addSessionItems` (`hooks.ts:976`) and `controller.setFilesPanelOpen`.
- Produces on `ChatSessionController`:
  - `pendingInput: { text: string; nonce: number } | null`
  - `seedInput: (text: string) => void`
  - `consumePendingInput: () => void`
  - `addSessionFiles: (keys: string[]) => Promise<void>`
- Produces `export const applyOpenRequest = (req: OpenPanelRequest, deps: { seedInput: (t: string) => void; addSessionItems: (gids: string[]) => Promise<void>; addSessionFiles: (keys: string[]) => Promise<void>; setFilesPanelOpen: (open: boolean) => Promise<void> }) => Promise<void>`.

**Why a controller seed channel exists at all:** the composer owns its own input — `const [input, setInput] = useState("")` at `composer.tsx:114`. There is no `controller.setInput`, so nothing outside the composer can prefill it. The existing `?q=` deep link works only because the composer reads `useSearchParams()` itself, and it seeds **once per mount** behind `deepLinkSeededRef` — deliberately, so a stale `q` closure cannot win a race against the user's first keystroke (read the comment at `composer.tsx:316`). A second button click in a mounted panel would therefore be ignored by that path.

So the seed is a **nonce-carrying, consume-once signal** on the controller, not a value the composer re-reads. The composer applies it when the nonce changes and immediately calls `consumePendingInput()`. The URL `?q=` path stays exactly as it is.

- [ ] **Step 1: Write the failing tests**

`hooks-seed-input.test.tsx`:

```tsx
test("seedInput exposes the text with a fresh nonce", () => {});
test("seeding twice with the same text still bumps the nonce", () => {
  // two clicks of the same button must both reach the composer
});
test("consumePendingInput clears it", () => {});
```

Add to the composer's test file (create `composer-seed.test.tsx` if the existing suite has no mount harness):

```tsx
test("a pending seed lands in the textarea and is consumed", () => {});
test("a second seed replaces the textarea content", () => {});
test("a seed never submits — no send mutation fires", () => {});
test("a null pendingInput leaves a user draft untouched", () => {});
```

`apply-open-request.test.ts`:

```ts
test("prompt text goes through seedInput, and no submit dep is even available", async () => {});
test("items go through addSessionItems", async () => {});
test("files go through addSessionFiles", async () => {});
test("the files panel is opened so the user sees what was attached before sending", async () => {});
test("a request with no prompt does not call seedInput", async () => {
  // must not blank a draft the user already typed
});
test("an adopt failure still leaves the seeded prompt in place", async () => {
  // addSessionFiles rejects; seedInput was already called and is not reverted
});
test("items and files are both applied when both are present", async () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run "app/(application)/artifacts/open/[name]/apply-open-request.test.ts" "app/(application)/chat/hooks-seed-input.test.tsx"`
Expected: FAIL — modules and controller fields do not exist.

- [ ] **Step 3: Add the seed channel to the controller and the composer**

`seedInput(text)` sets `{ text, nonce: n + 1 }`. The composer applies it in an effect keyed on the nonce, then calls `consumePendingInput()`. Leave `deepLinkSeededRef` and the `?q=` effect untouched — they guard a different race.

- [ ] **Step 4: Implement `addSessionFiles` and `applyOpenRequest`**

`addSessionFiles` mirrors `addSessionItems` exactly: `await ensureSession()`, toast `errors.sessionCreateFailed` on failure, then the adopt call, then refresh the files count through the existing `refreshFilesCount` path. Attachments must **not** ride on the session-create mutation — session creation is lazy, and coupling them means handling that race.

`applyOpenRequest` is a pure orchestrator over injected deps, so it is testable without a chat controller. It seeds the prompt first, so an attachment failure cannot cost the user the prompt.

- [ ] **Step 5: Wire it into the viewer's `onOpenRequest`**

Open the panel for the slot, then apply the request against the mounted controller.

- [ ] **Step 6: Run the tests and the gates**

Run: `npx vitest run "app/(application)/artifacts" "app/(application)/chat"`
Expected: PASS
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → exactly `8`
Run: `npm run lint`

- [ ] **Step 7: Commit**

```bash
git add "app/(application)/chat" lib/api/session-files.ts "app/(application)/artifacts/open/[name]"
git commit -m "feat(artifacts): prefill and attach from an artifact open request"
```

---

### Task 10: Progress emission

**Files:**
- Create: `frontend/app/(application)/artifacts/open/[name]/use-turn-progress.ts`
- Create: `frontend/app/(application)/artifacts/open/[name]/use-turn-progress.test.ts`
- Modify: `frontend/app/(application)/artifacts/open/[name]/agent-panel.tsx` (call the hook, fire `onProgress`)
- Modify: `frontend/app/(application)/artifacts/open/[name]/viewer-client.tsx` (count `onProgress` into `progressNonce` for the frame)

**Interfaces:**
- Consumes: `controller.messages` and `controller.status` from `ChatSessionController`.
- Produces: `export const useTurnProgress = (controller: Pick<ChatSessionController, "messages" | "status">) => { nonce: number; reason: "tool" | "turn" }`.

**Which signal:** `onToolCall` (`hooks.ts:484`) fires when a tool is *called*, not when it completes — do not use it. Derive from tool parts in `controller.messages` reaching a terminal state: `output-available` or `output-error` (the state names used in `chat/components/tool-call-group-data.ts:78-81`). Turn completion is the `streaming → ready` transition the file already watches at `hooks.ts:1135`.

- [ ] **Step 1: Write the failing test**

```ts
test("bumps once when a tool part reaches output-available", () => {});
test("bumps for output-error too — the artifact should refetch either way", () => {});
test("does not bump again for the same toolCallId", () => {
  // re-render with the same parts → nonce unchanged
});
test("bumps on the streaming → ready transition with reason 'turn'", () => {});
test("does not bump on an unrelated re-render", () => {});
test("does not bump for a tool part still input-available", () => {});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run "app/(application)/artifacts/open/[name]/use-turn-progress.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

Track seen `toolCallId`s in a ref so each terminal transition bumps exactly once, and watch the status transition with a `prevStatusRef`, as `hooks.ts:1130` already does.

**Where it is called:** inside `AgentPanel` (Task 7), which is the only place the controller exists — `SessionScreen` instantiates it and the viewer never sees it. The panel calls `onProgress(reason)` on each bump; the viewer counts those into the `progressNonce` it hands `ArtifactFrame`.

- [ ] **Step 4: Review Focus 3 — a turn that finishes after the panel closed**

The frame posts over a port that may already be closed (the frame unmounted, or reloaded and dropped `port2`). Add to `artifact-frame.test.tsx`:

```tsx
test("a progress bump after the port is closed does not throw and is not retried", async () => {});
```

Make the emission in `ArtifactFrame` safe: a closed `MessagePort` must not surface an error, and nothing re-queues.

- [ ] **Step 5: Run the tests and the gates**

Run: `npx vitest run "app/(application)/artifacts/open" "app/artifacts/[artifact_name]/artifact-frame.test.tsx"`
Expected: PASS
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → exactly `8`
Run: `npm run lint`

- [ ] **Step 6: Commit**

```bash
git add "app/(application)/artifacts/open/[name]" "app/artifacts/[artifact_name]/artifact-frame.test.tsx"
git commit -m "feat(artifacts): emit turn and tool progress to the artifact"
```

---

### Task 11: The artifact-side client, with a real dispatcher

**Files:**
- Create: `backend/src/skills/bundled/imp-artifact-apps/templates/imp-channel.ts`
- Create: `backend/src/skills/bundled/imp-artifact-apps/templates/imp-channel.test.ts`
- Modify: `backend/src/skills/bundled/imp-artifact-apps/references/identity-handshake.md`
- Modify: `backend/src/skills/bundled/imp-artifact-apps/SKILL.md`

**Interfaces:**
- Consumes: the wire shapes from Task 4 (this is the other end of them; the module is standalone so an artifact in any repo can copy it).
- Produces:

```ts
export interface ImpChannel {
  grant: Grant;
  refresh(): Promise<IdentityResult>;
  host: { panel: boolean; slots: PanelSlot[] };
  onViewport(cb: (v: { width: number; open: boolean }) => void): () => void;
  onProgress(cb: (reason: "tool" | "turn") => void): () => void;
  openPanel(slot: string, opts?: { prompt?: string; items?: string[]; files?: string[] }): Promise<boolean>;
}
export function connectImp(win: HandshakeWindow, timeoutMs?: number): Promise<ImpChannel>;
```

**Why this task exists:** the current artifact-side client reassigns `port.onmessage` on every `refresh()` call (`mevakipi/artifact-pitch/src/lib/identity.ts`). Any unsolicited parent event landing during a token refresh is handed to the refresh handler, which ignores non-grant messages and drops it. The symptom is "sometimes the artifact doesn't update", which is expensive to chase. This replaces that with one dispatcher, and lives in the skill bundle so new artifacts are scaffolded with it instead of copy-pasting.

- [ ] **Step 1: Write the failing test**

Jest, with the injectable `HandshakeWindow` the existing client already uses for testability — no browser needed.

```ts
test("resolves with the grant, as the v1 client did", async () => {});
test("a progress event delivered DURING an in-flight refresh is not swallowed", async () => {
  // the regression this task exists for: start refresh(), deliver progress
  // before the grant, assert the onProgress callback fired AND refresh resolved
});
test("host info populates host.panel and host.slots", async () => {});
test("onViewport and onProgress return working unsubscribes", async () => {});
test("openPanel resolves true on an accepted ack and false on a rejected one", async () => {});
test("openPanel resolves false rather than hanging when no ack arrives", async () => {
  // Review Focus 5 from the artifact's side — the button must re-enable
});
test("messages with the wrong version are ignored", async () => {});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/skills/bundled/imp-artifact-apps/templates/imp-channel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `connectImp`**

One `port.onmessage`, set once, dispatching by `data.type` to registered handlers. Keep the v1 behaviours that are load-bearing and already carry comments explaining them: the listener is registered *before* the first request is posted, and the request repeats on an interval until answered because the parent's listener does not exist until its bundle hydrates.

`openPanel` resolves on the matching ack, or `false` after a timeout.

- [ ] **Step 4: Document the channel**

Rewrite `references/identity-handshake.md` to cover the whole v2 channel — the message table, the fact that an artifact names a **slot** and never an agent id, that prefill never submits, and that `host.panel` is false on the share route so a button must hide itself there. Note in `SKILL.md` that artifacts should copy `imp-channel.ts` rather than writing a handshake.

- [ ] **Step 5: Run the tests and the gates**

Run: `npx jest src/skills/bundled/imp-artifact-apps`
Expected: PASS
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → exactly `8`
Run: `npm run lint`

- [ ] **Step 6: Commit**

```bash
git add src/skills/bundled/imp-artifact-apps
git commit -m "feat(skills): artifact channel client with a single dispatcher"
```

---

## After the last task

- `npm run utils:initdb` adds the `agent_slots` column. **On Newlift, `exulu-test` IS production and initdb applies every pending local schema change** — treat any run there as a production action.
- Manual end-to-end on a `regular` HTML artifact is owed and is Daniel's: assign a slot, open from the CTA, open from an in-artifact button with prefill and files, watch fields fill mid-turn, confirm the nav restores and `sidebar_state` is unchanged, confirm the share route hides the button.
