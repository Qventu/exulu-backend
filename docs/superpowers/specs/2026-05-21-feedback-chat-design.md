# Feedback chat: opt-in feature/bug feedback via external Exulu agent

**Date:** 2026-05-21
**Status:** Approved (design)
**Scope:** Frontend only (`/Users/daniel.claessen/Desktop/Projects/exulu/frontend`)

## Problem

Users have no in-app way to submit feature ideas or bug reports. Feedback collection lives outside the product, making it slow and easy to skip. We want a friction-free, opt-in path: one click in the sidebar, a quick choice between "feature" and "bug", then a guided chat with an agent that triages and dedupes against the existing backlog.

## Goal

Add an opt-in feedback button to the main sidebar that opens a modal where users choose "Feature request" or "Bug report" and then chat with one of two external Exulu agents at `https://backend.exulu.com`. The agents (managed externally) ask follow-up questions, check the backlog for duplicates, and for bugs check recent releases for regressions.

External agent IDs:
- Bugs: `5d8ef50c-15dc-490a-8b35-4c4a57961dc5`
- Features: `e64b11be-0b0a-464e-a8e1-4532b5ed8413`

## Non-goals

- No changes to `chat.tsx` or `message-renderer.tsx`. We use them as black boxes.
- No backend changes in `exulu/backend`. The external agents are configured on a separate Exulu instance.
- No persistence of feedback conversations (no DB, no localStorage, no GraphQL).
- No file uploads, tool-approval UI, token-usage display, RBAC, prompts, items, or projects inside the feedback chat.
- No analytics beyond what the external agent records.
- No server-side proxy route — the browser calls `backend.exulu.com` directly with a bearer token delivered via `/api/config`.
- No refactor of `chat.tsx` into a shared `ChatCore` (considered and rejected: too risky and likely to over-abstract).

## Decisions

| Topic | Decision |
|---|---|
| Auth to external backend | Shared bearer token, configured server-side, delivered to the browser via `/api/config`. |
| Request origin | Direct browser → `https://backend.exulu.com`. No proxy. |
| Sidebar placement | Above the user dropdown in `SidebarFooter` of `main-nav.tsx`. |
| UI surface | Modal `Dialog`, two-view state machine (`choice` → `chat`). |
| Reuse strategy | Standalone new components. Reuse `MessageRenderer` for assistant rendering. Use `useChat` + `DefaultChatTransport` directly. |
| Close behavior | On close: reset to choice view; in-flight conversation discarded. |
| User context auto-attached | Yes. Hidden `feedbackContext` field on each request body (`userEmail`, `pageUrl`, `appVersion`, `kind`). |
| Session model | New `crypto.randomUUID()` per chat-view entry. |
| Env naming | `FEEDBACK_*` prefix (no `NEXT_PUBLIC_`), exposed via `/api/config`. |

## Architecture

### File map

**New files (all under `frontend/components/feedback/`):**
- `feedback-button.tsx` — sidebar entry point. Returns `null` when feature is disabled.
- `feedback-dialog.tsx` — dialog shell + view state machine.
- `feedback-choice.tsx` — two-card selector (Feature request / Bug report).
- `feedback-chat.tsx` — chat surface; owns `useChat` + transport + renders `MessageRenderer` + textarea.

**Modified files:**
- `frontend/app/api/config/route.ts` — emit `feedback` field when fully configured.
- `frontend/util/api.ts` — extend `ConfigContextType` with optional `feedback` shape (or extend `BackendConfigType`; final location chosen at implementation time).
- `frontend/components/custom/main-nav.tsx` — mount `<FeedbackButton />` in `SidebarFooter` above the user dropdown.
- `frontend/messages/en.json` and `frontend/messages/de.json` — add i18n keys.

### Data flow

```
.env → /api/config (route.ts) → ConfigContext → FeedbackButton (visibility gate)
                                              → FeedbackDialog
                                              → FeedbackChat (reads backend, token, agent IDs)
                                              → useChat + DefaultChatTransport
                                              → POST https://backend.exulu.com{agentSlug}/{agentId}
                                              → stream UIMessage parts back
                                              → MessageRenderer renders assistant output
```

## Config & env vars

Consumed in `frontend/app/api/config/route.ts`, evaluated per request (no rebuild needed to toggle):

| Var | Required when | Default | Purpose |
|---|---|---|---|
| `FEEDBACK_ENABLED` | always (default off) | unset | `"true"` to enable. Anything else → hidden. |
| `FEEDBACK_BACKEND` | when enabled | — | Base URL of external Exulu, e.g. `https://backend.exulu.com`. No trailing slash. |
| `FEEDBACK_TOKEN` | when enabled | — | Bearer token for the external agent. |
| `FEEDBACK_AGENT_SLUG` | optional | `/agent` | Provider slug on external instance. |
| `FEEDBACK_AGENT_BUG_ID` | optional | `5d8ef50c-15dc-490a-8b35-4c4a57961dc5` | Bug agent ID override. |
| `FEEDBACK_AGENT_FEATURE_ID` | optional | `e64b11be-0b0a-464e-a8e1-4532b5ed8413` | Feature agent ID override. |

The feature is gated on `FEEDBACK_ENABLED === "true" && FEEDBACK_BACKEND && FEEDBACK_TOKEN`. If any of those three are missing, `/api/config` returns no `feedback` field and `FeedbackButton` renders `null`.

### `/api/config/route.ts` (additive change)

```ts
return NextResponse.json({
  backend: process.env.BACKEND,
  google_client_id: process.env.GOOGLE_CLIENT_ID,
  auth_mode: process.env.AUTH_MODE,
  langfuse: process.env.LANGFUSE_URI,
  feedback:
    process.env.FEEDBACK_ENABLED === "true" &&
    process.env.FEEDBACK_BACKEND &&
    process.env.FEEDBACK_TOKEN
      ? {
          enabled: true,
          backend: process.env.FEEDBACK_BACKEND,
          token: process.env.FEEDBACK_TOKEN,
          agentSlug: process.env.FEEDBACK_AGENT_SLUG ?? "/agent",
          bugAgentId:
            process.env.FEEDBACK_AGENT_BUG_ID ??
            "5d8ef50c-15dc-490a-8b35-4c4a57961dc5",
          featureAgentId:
            process.env.FEEDBACK_AGENT_FEATURE_ID ??
            "e64b11be-0b0a-464e-a8e1-4532b5ed8413",
        }
      : undefined,
}, { status: 200, ... });
```

### ConfigContext shape extension

```ts
type FeedbackConfig = {
  enabled: true;
  backend: string;
  token: string;
  agentSlug: string;
  bugAgentId: string;
  featureAgentId: string;
};

type ConfigContextType = {
  backend: string;
  google_client_id: string;
  auth_mode: string;
  feedback?: FeedbackConfig; // undefined when feature is off
} & BackendConfigType;
```

### Security trade-off (explicit)

`FEEDBACK_TOKEN` is delivered to every authenticated user's browser via `/api/config`. This is the trade-off implied by the "direct from browser" choice. Mitigations (out of scope here; for the external Exulu instance owner):
- Scope the token to only the two feedback agent IDs.
- Apply per-IP / per-session rate limits.
- Make the token rotatable without redeploying every consumer.

## Components

### `FeedbackButton`

```tsx
"use client";
import { useContext, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { ConfigContext } from "@/components/config-context";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { FeedbackDialog } from "./feedback-dialog";

export function FeedbackButton() {
  const config = useContext(ConfigContext);
  const [open, setOpen] = useState(false);
  const t = useTranslations();
  if (!config?.feedback?.enabled) return null;
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => setOpen(true)}
          tooltip={t("feedback.label")}
          aria-label={t("feedback.openButton")}
        >
          <MessageSquarePlus className="h-4 w-4" strokeWidth={1.5} />
          <span className="group-data-[collapsible=icon]:hidden">
            {t("feedback.label")}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <FeedbackDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
```

Mounted in `main-nav.tsx` `SidebarFooter`, immediately above the existing user-dropdown `SidebarMenuItem`. Hidden entirely when `feedback?.enabled` is falsy.

### `FeedbackDialog`

State: `view: "choice" | "chat"`, `kind: "bug" | "feature" | null`, `sessionId: string`.

```tsx
export function FeedbackDialog({
  open,
  onOpenChange,
}: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [view, setView] = useState<"choice" | "chat">("choice");
  const [kind, setKind] = useState<"bug" | "feature" | null>(null);
  const [sessionId, setSessionId] = useState<string>("");
  const t = useTranslations();

  useEffect(() => {
    if (!open) {
      setView("choice");
      setKind(null);
      setSessionId("");
    }
  }, [open]);

  const handleChoice = (k: "bug" | "feature") => {
    setKind(k);
    setSessionId(crypto.randomUUID());
    setView("chat");
  };

  const title =
    view === "choice"
      ? t("feedback.title")
      : kind === "bug"
        ? t("feedback.bugTitle")
        : t("feedback.featureTitle");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl h-[80vh] p-0 flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {view === "choice" ? (
          <FeedbackChoice onSelect={handleChoice} />
        ) : (
          <FeedbackChat
            kind={kind!}
            sessionId={sessionId}
            onBack={() => setView("choice")}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
```

Dialog sizing `max-w-2xl h-[80vh]`. `p-0` so the chat surface manages its own padding. `flex flex-col` so the input pins to the bottom.

### `FeedbackChoice`

Two cards side-by-side (stacked on mobile, `grid-cols-1 md:grid-cols-2`), each large and clickable with hover state (`hover:border-primary hover:bg-accent/50`).

| Card | Icon | Title | Description |
|---|---|---|---|
| Feature | `Lightbulb` | Feature request (i18n) | Suggest a new feature or improvement (i18n) |
| Bug | `Bug` | Bug report (i18n) | Report something that's not working (i18n) |

Clicking either card invokes `onSelect(kind)`.

### `FeedbackChat`

Self-contained chat surface using `useChat` directly. Renders assistant messages via `MessageRenderer` with most optional features disabled.

```tsx
type Props = {
  kind: "bug" | "feature";
  sessionId: string;
  onBack: () => void;
};

export function FeedbackChat({ kind, sessionId, onBack }: Props) {
  const config = useContext(ConfigContext);
  const { user } = useContext(UserContext);
  const t = useTranslations();
  const fb = config!.feedback!;
  const agentId = kind === "bug" ? fb.bugAgentId : fb.featureAgentId;
  const api = `${fb.backend}${fb.agentSlug}/${agentId}`;
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState("");

  const feedbackContext = useMemo(
    () => ({
      userEmail: user?.email ?? null,
      pageUrl: typeof window !== "undefined" ? window.location.href : null,
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
      kind,
    }),
    [user?.email, kind],
  );

  const { messages, sendMessage, status, stop } = useChat({
    experimental_throttle: 50,
    onError: (e) => {
      // Match chat.tsx behavior: errors arrive as JSON-stringified payloads;
      // try to parse, fall back to the raw message.
      try {
        setError(JSON.parse(e?.message)?.message ?? e?.message);
      } catch {
        setError(e?.message ?? "An unexpected error occurred. Please try again.");
      }
    },
    transport: new DefaultChatTransport({
      api,
      prepareSendMessagesRequest: async ({ messages, body }) => ({
        body: {
          ...body,
          message: messages[messages.length - 1],
          id: sessionId,
          session: sessionId,
          feedbackContext,
        },
        headers: {
          Authorization: `Bearer ${fb.token}`,
          User: user?.id ?? "anonymous",
          Session: sessionId,
          Stream: "true",
        },
      }),
    }),
  });

  // ... render JSX as described below
}
```

Render structure inside the dialog:

1. **Top bar** (`px-6 py-2 border-b flex items-center`): "← Back" ghost button (`onClick={onBack}`).
2. **Conversation area** (`flex-1 overflow-y-auto px-6`): wraps `<MessageRenderer messages={messages} status={status} showActions={false} showTokens={false} showEdit={false} showRemove={false} />`. Empty state when `messages.length === 0`.
3. **Error Alert** (`<Alert variant="destructive">`) only when `error` is set, above the input.
4. **Input footer** (`border-t px-6 py-4` sticky at dialog bottom): `TextareaAutosize` + send/stop button (`ArrowUp` / `StopIcon`). Enter submits, Shift+Enter newline. Calls `sendMessage({ text: value })` then `setValue("")`.

#### `MessageRenderer` integration notes

Verified via `frontend/components/message-renderer.tsx`:
- `messages` and `status` are the only required-ish props.
- `agent`, `addToolApprovalResponse`, `onUpdate`, `onRegenerate`, `addToContext`, `handleFeedback`, `onQuestionAnswer`, etc. are all optional.
- `status` accepts `"streaming" | "idle" | "error" | "submitted" | "ready"`. `useChat` emits `"submitted" | "streaming" | "ready" | "error"` — that subset is fully covered, so the `useChat` status passes through unchanged.

Implementation-time verification: walk every code path in `message-renderer.tsx` that touches `agent` (search for `agent?.`, `agent.`) and confirm undefined is tolerated. If any path null-refs, pass a minimal stub:

```ts
const agentStub = {
  id: agentId,
  name: kind === "bug" ? "Bug Reporter" : "Feature Helper",
  slug: fb.agentSlug,
} as unknown as Agent;
```

This stub is only the escape hatch — preferred behavior is `agent={undefined}`.

#### Error handling

- Network/auth failures → `useChat`'s `onError` → `setError(msg)` → red Alert above input. User can retry by resending.
- Raw error messages surfaced unmodified (matches `chat.tsx` behavior; useful for support).
- No automatic retries.
- Stop button (`status === "submitted" | "streaming"`) calls `stop()`, preserving partial assistant message.

## i18n

Add to `frontend/messages/en.json` and `frontend/messages/de.json`:

```jsonc
{
  "feedback": {
    "label": "Feedback",                          // de: "Feedback"
    "openButton": "Open feedback",                // de: "Feedback öffnen"
    "title": "Send feedback",                     // de: "Feedback senden"
    "bugTitle": "Bug report",                     // de: "Fehlerbericht"
    "featureTitle": "Feature request",            // de: "Feature-Wunsch"
    "choiceFeature": {
      "title": "Feature request",                 // de: "Feature-Wunsch"
      "desc": "Suggest a new feature or improvement"
                                                  // de: "Eine neue Funktion oder Verbesserung vorschlagen"
    },
    "choiceBug": {
      "title": "Bug report",                      // de: "Fehlerbericht"
      "desc": "Report something that's not working"
                                                  // de: "Etwas melden, das nicht funktioniert"
    },
    "back": "Back",                               // de: "Zurück"
    "placeholderBug": "Describe the bug…",        // de: "Beschreiben Sie den Fehler…"
    "placeholderFeature": "Describe the feature…",// de: "Beschreiben Sie die Funktion…"
    "emptyStateBug": "Tell me about the bug you'd like to report.",
                                                  // de: "Erzählen Sie mir von dem Fehler, den Sie melden möchten."
    "emptyStateFeature": "Tell me about the feature you'd like to suggest."
                                                  // de: "Erzählen Sie mir von der Funktion, die Sie vorschlagen möchten."
  }
}
```

## Testing

Manual + integration. No new unit tests — components are composition of existing primitives; value is in observed behavior.

### Manual test checklist

1. **Feature off (defaults).** With no `FEEDBACK_*` env vars: sidebar shows no feedback button, no extra network requests, no console errors.
2. **Partial config.** Only `FEEDBACK_ENABLED=true` without `FEEDBACK_BACKEND` and `FEEDBACK_TOKEN`: button stays hidden (gate requires all three).
3. **Feature on, bug happy path.** All three vars set, pointed at a real `backend.exulu.com` agent. Click button → choice screen → "Bug report" → chat opens → send "test message" → assistant streams reply → close dialog → reopen → choice screen shown (state reset).
4. **Feature on, feature happy path.** Same flow with the feature agent.
5. **Back button mid-chat.** Open chat, send one message, click "← Back" → choice screen → pick the other kind → new session ID, new agent ID in network tab, blank conversation.
6. **Error display.** Point `FEEDBACK_BACKEND` at an invalid URL: red Alert appears in dialog, dialog stays open; retries work after fixing the URL.
7. **Auth headers.** In browser devtools, confirm POST to backend.exulu.com includes `Authorization: Bearer <token>`, `User: <user-id>`, `Session: <uuid>`, `Stream: true`.
8. **Request body.** Confirm body includes `feedbackContext: { userEmail, pageUrl, appVersion, kind }`.
9. **Token leak surface.** Confirm `FEEDBACK_TOKEN` appears only in `/api/config` response and outbound POST headers — not in console logs, DOM, or any other route response. This is the expected exposure, just verify scope.
10. **i18n.** Toggle locale en↔de via the existing user dropdown: all labels switch.
11. **Sidebar collapsed.** Collapse the sidebar: feedback button shows only the icon with tooltip on hover (consistent with other nav items).
12. **Dark/light mode.** Toggle theme: dialog, cards, alert, input all read correctly in both themes.
13. **Stop streaming.** Send a message that yields a long reply, press stop mid-stream: stream halts, partial message preserved.
14. **MessageRenderer with `agent` undefined.** Walk every `agent?.`/`agent.` site in `message-renderer.tsx`. If anything null-refs in a feedback-relevant code path, switch to the minimal stub.

### Edge cases & assumptions

- **Multiple users opening simultaneously.** Each gets their own UUID-based session client-side, so no collisions on the external backend.
- **User without email.** `userContext.userEmail` becomes `null`. External agent must handle that gracefully — out of our control.
- **MessageRenderer filter quirks.** Renderer filters duplicate `tool-todo_write` messages and other tool-specific behavior. Feedback agents return plain text; those paths shouldn't trigger. If they do trigger oddly, fix on the renderer side is out of scope.
- **CORS.** `backend.exulu.com` must permit requests from this app's origin. Out of scope here; configured on the external Exulu instance.
- **`crypto.randomUUID()`.** Available in all modern browsers and Node 14+. Safe to use directly.
- **Tooltip on collapsed sidebar.** Uses the existing `SidebarMenuButton` `tooltip` prop pattern other nav items already follow.

## Rollout

- Single PR adds all new components and modifies four files.
- Default `FEEDBACK_ENABLED` unset → zero behavior change in any existing deployment.
- Enable per-deployment by setting the three required env vars; toggle without code change.
- No migration, no backend changes, no DB.

## Open items (for implementation)

- Final location for the `feedback` field type — extend `BackendConfigType` in `util/api.ts` or add a new exported `FeedbackConfig` type alongside it. Either is fine; pick at implementation time.
- Verify `MessageRenderer` with `agent={undefined}` works across all internal branches; if not, swap to minimal `Agent` stub.
- Confirm the external Exulu instance's CORS allowlist includes the deployment's origin before enabling in production.
