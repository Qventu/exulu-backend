# Advanced Mode — Approval Loop for Exulu MCP Tools (parked)

**Date:** 2026-06-05
**Status:** Parked / design only — not implemented
**Parent specs:** `2026-06-03-hermes-agent-mode-design.md`,
`2026-06-04-advanced-mode-workspace-files-design.md`

## Why this is possible (and what it can/can't do)

Hermes' **native** tools (`bash`/`terminal`/filesystem/`execute_code`) are run by
Hermes itself, and we confirmed the OpenAI-compatible API server **never gates
them** through approvals (tried `approvals.mode: smart` and `manual` — zero
approval events; the runs API's `session_id` is only a correlation label). So we
cannot add an approval loop to native tools from our side.

But the **Exulu MCP tools** (context search, web search, custom tools,
`write_shared_file`, …) execute **in our backend** when Hermes calls
`/mcp/:agentId`. Because we own that execution, we *can* pause it and require
user approval before running.

- **Scope:** gates ONLY our MCP tools. Native bash/filesystem stay ungated — the
  **Docker terminal backend remains their security boundary**. This feature is
  governance/UX over Exulu capabilities (e.g. a tool that sends email, mutates
  data, hits a paid API, or a destructive `write_shared_file`), not a security
  control over the dangerous native tools.

## Mechanism

ExuluTools already carry a `needsApproval` flag. In the MCP server tool handler
(`src/exulu/hermes/mcp-server.ts`):

1. **Pause instead of execute.** For a tool whose `needsApproval` is true (and
   not already approved), register a pending entry
   `{ approvalId, agentId, toolName, args, resolve, reject, createdAt }` in an
   in-memory registry, and `await` a promise. The MCP `tools/call` request is
   simply held open — Hermes' run blocks on the tool result, which is exactly the
   pause we want.
2. **Surface it to the user.** The run-stream adapter
   (`src/exulu/hermes/run-stream.ts`) is already streaming the run and receives
   Hermes' `tool.started` event for `mcp_exulu_<tool>`. Emit a
   `tool-approval-request` UIMessage chunk (the chunk type already exists, and the
   frontend `ToolCallApproval` component — built for the abandoned native-approval
   attempt — already renders it).
3. **Resolve.** User approves/denies → frontend POSTs the decision to a new route
   (e.g. `POST /agents/:agentId/mcp-approval` with `{ approvalId, approved }`) →
   look up the pending entry and `resolve(approved)`.
4. **Continue.** The MCP handler then runs the tool (approved) and returns its
   result, or returns a denial message → Hermes resumes the run.

## The hard parts (resolve these when picking this up)

1. **Correlation — route the approval to the right user's chat stream.**
   The MCP call from Hermes may not carry the run/session id, so for concurrent
   runs of the same agent we need a way to match a pending MCP approval to the
   active run stream. Options:
   - **Verify what Hermes forwards:** dump the MCP request headers / metadata when
     a tool is called (log `req.headers` + the MCP request context in
     `handleMcpPost`) — Hermes may pass a session/run id we can key on. This is the
     first thing to do; it may make correlation trivial.
   - **Drive off the run stream:** the adapter already sees `tool.started` for the
     MCP tool. Key the registry by `agentId` (or `hermesSessionId` if available);
     clean when there is one active run per agent/user (private scope mostly
     guarantees this), racy under concurrency.
2. **Holding the request + timeouts.** The MCP `tools/call` is held open while
   awaiting the user. Add an **auto-deny after N minutes** so a walked-away user
   doesn't hang the run, and ensure no reverse proxy kills the long-lived request
   (keep-alive / timeouts on `/mcp/:agentId`).
3. **Abort/cleanup.** If the run is aborted (client disconnects → the run-stream
   `AbortController` fires) or the gateway is evicted, reject pending approvals for
   that run so the MCP handler returns promptly.

## Pieces to build

- **Registry:** `src/exulu/hermes/mcp-approvals.ts` — `createPendingApproval()`,
  `resolveApproval(approvalId, approved)`, `rejectRunApprovals(key)`, with the
  promise + timeout logic.
- **MCP handler:** in `mcp-server.ts`, gate `needsApproval` tools through the
  registry before `tool.execute()`.
- **Run-stream:** emit `tool-approval-request` when a held approval exists for the
  current run (correlate via the chosen key). The adapter already maps an
  `approval` normalized event → a `tool-approval-request` chunk; reuse that path.
- **Route:** `POST /agents/:agentId/mcp-approval` (RBAC-gated, like the other
  advanced-mode routes) → `resolveApproval`.
- **Frontend:** the `ToolCallApproval` component already exists; just ensure the
  decision posts to the new route (the `addToolApprovalResponse` wiring may need a
  branch for advanced-mode/MCP approvals).

## First step when resuming

Log the MCP request context in `handleMcpPost` (headers + any MCP metadata) during
a tool call, to learn whether Hermes forwards a session/run id. That single
finding determines whether correlation is trivial (key on the forwarded id) or
needs the run-stream/agent-keyed fallback.
