# Feature plan — Trajectory feedback & organic reuse

## Sources of truth

- No spec file — feature reconstructed from code + commit messages
  (frontend `44692d3`, `0bbe4f5`, `b4c687b`, `54c2a15`, `3fbc33e`, `b5836db`,
  `608d1f8`, `25b8d4e`, `22fbcc3`, 06-28/29). The trajectory store itself lives
  outside the backend repo (harness), per `releases/BACKLOG.md` #5.
- Code:
  - `frontend/lib/api/trajectory-feedback.ts` — POSTs to the harness route
    `POST /retrieval/trajectories/:ref/feedback`; 👍 sends bare
    `{ positive: true }` (fast-path, marks the trajectory replay-eligible, no
    LLM call); 👎 sends `{ positive: false, message }` (routed to the
    feedback-agent to prune/rewrite the strategy).
  - `frontend/app/(application)/chat/components/trajectory-ref.ts` —
    closest-trajectory finder: walks backward from the rated message through
    history; the reused (proven) trajectory wins over the run's own.
  - `frontend/app/(application)/chat/components/feedback-dialog.tsx` — forwards
    trajectory feedback best-effort after the GraphQL feedback, never blocks it.
  - `frontend/components/trajectory-reuse-indicator.tsx` — the organic badge
    (deliberately never says "trajectory").
  - `frontend/components/message-renderer.tsx:1176-1178` (badge placement),
    `:996-998` (benchmark line), `:1296-1302` (token split);
    `frontend/components/message-renderer-tool-data.ts` + `frontend/lib/retrieval-metrics.ts`
    (benchmark line format).
- On-screen copy: `frontend/messages/en.json` → `chat.feedbackDialog.*`
  (verbatim below); badge/tooltip text is hardcoded in
  `trajectory-reuse-indicator.tsx`.

## What shipped

The thumbs on assistant messages now close a learning loop. A 👍/👎 is forwarded
to the retrieval trajectory store — targeted at the *right* trajectory: the
finder walks back through the conversation, and if the answer replayed a proven
approach, the feedback retargets that original trajectory. Answers that reused a
proven approach show an organic indicator badge: "Answered like a similar
earlier request". Every knowledge-search result now carries a benchmark line
("↳ retrieval · 2,412 in / 486 out tokens · 3.2 s") and the message footer
splits totals into input/output tokens (see the companion prose section
`token-transparency.md`).

## Hook

**A 👍 teaches your agent — proven approaches get reused, instantly.**

## Surface area

UI feature (chat message column) fronting a harness capability. Recipe A:
reconstruct the assistant answer with its new adornments; the single action is
the thumbs-up click.

## Reconstruction cues (verbatim from the shipped code)

- **Answer column** (max-w ~768px, light bg #FDFDFD). Stack top→bottom:
  1. **Collapsed context-search card:** `my-3 border rounded-lg bg-card`, header
     row `p-4`: icon box `p-2 rounded-md bg-primary/10` with Search icon
     `h-4 w-4 text-primary`; title `font-medium text-sm`
     `Context search results support docs`; meta row
     `text-xs text-muted-foreground mt-1` with Database icon `1 context` ·
     FileText icon `4 items` · LayoutList icon `12 chunks`; ChevronRight
     `h-5 w-5 text-muted-foreground` at right.
  2. **Benchmark line** directly under the card: `mt-1 text-xs text-muted-foreground`,
     exact format from `formatRetrievalMetrics`:
     `↳ retrieval · 2,412 in / 486 out tokens · 3.2 s`.
  3. **Answer text:** 2–3 lines of body copy (Inter, text-sm/base, foreground #000).
  4. **Reuse badge** (above the actions row): shadcn Badge `variant="secondary"`
     with `gap-1 font-normal text-muted-foreground`, History icon `size-3`,
     text **`Answered like a similar earlier request`**. Tooltip (don't show in
     the short, cite in prose): "Handled the same way as an earlier question
     that worked well. If it's not right, give it a 👎 below."
  5. **Actions row** (`mt-2`, small ghost icon buttons, `size-3` icons):
     RefreshCcw (Retry), Copy, Volume2 (Read aloud), Download, ThumbsUp
     ("Good response"), ThumbsDown ("Bad response"), then footer text
     `<small class="text-muted-foreground">` —
     `1,412 tokens · 1,120 in / 292 out`.
- **Feedback dialog** (opens on 👍): centered Dialog over dimmed backdrop,
  title **`What did you like?`**, description
  **`Let us know what worked well in this response.`**, Textarea
  (min-h-[100px]) placeholder **`Enter your feedback here...`**, footer:
  outline **`Cancel`** + primary purple **`Submit feedback`**.
  (👎 variant — prose only: "What could be improved?" + referenced-sources list.)
- Toast on submit (not in the short): `Feedback submitted` /
  `Thank you for your feedback!`

## Short C — `trajectory-reuse-feedback` (1920×1080, 9.5s)

One slice: a replayed answer wearing the reuse badge + benchmark line; the one
user action is the 👍 click; the payoff is the dialog opening.

| t (s) | What's on screen | Why |
|---|---|---|
| 0.0–0.4 | Hook enters: **"Good answers get remembered"** | Entrance |
| 0.4–1.9 | Hook holds still (1.5s) | ≥1.4s floor (4 words) |
| 1.9–2.3 | Hook exits; the answer column crossfades in: search card + benchmark line + answer + reuse badge + actions row with token split | Pivot |
| 2.3–3.0 | UI sits still | Establish (0.7s) |
| 3.0–4.6 | Single soft emphasis on the reuse badge (one 1.0→1.03 scale pulse + brief `bg-primary/10` ring fade); nothing else moves — viewer reads "Answered like a similar earlier request" | The tell; ~1.6s read window on the badge |
| 4.6–5.4 | Cursor glides to the ThumbsUp icon | Approach |
| 5.4–5.7 | Click → backdrop dims, feedback dialog scales in (0.98→1, fade): "What did you like?" | The action |
| 5.7–6.4 | Dialog holds completely still (0.7s) | Breath after action |
| 6.4–6.8 | Payoff enters (upper area, above the dialog): **"Your 👍 marks the approach proven — and reusable."** | Entrance |
| 6.8–8.9 | Payoff holds still (2.1s) | ≥1.8s floor (full sentence) |
| 8.9–9.5 | Resting frame — fully still (0.6s) | Clean loop |

Motion: power2.out, measured; the badge pulse is the only pre-action motion.
Numbers in the benchmark line and footer must use `Intl.NumberFormat('en-US')`
style (comma thousands separators).

## Prose for the page section (beyond the video)

- Feedback lands on the right target even late in a conversation: the finder
  walks back through history, and on replayed answers it retargets the original
  proven trajectory.
- 👍 is a safe fast-path — it can never delete or rewrite a strategy; 👎 with a
  comment goes to the feedback agent to prune or rewrite.
- The badge is deliberately jargon-free; the tooltip nudges: "If it's not
  right, give it a 👎 below."
- Benchmark line + token split → covered by the companion section
  (`token-transparency.md`).

## Code snippet decision

**No snippet.** The feedback route (`POST /retrieval/trajectories/:ref/feedback`)
is a harness route that lives outside this backend repo — verified absent from
`backend/src/exulu/routes.ts` and `backend/src/index.ts`, and there is no
GraphQL operation for it in `frontend/queries/queries.ts`. Per the don't-invent
rule, no snippet.
