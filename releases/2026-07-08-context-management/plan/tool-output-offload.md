# Short plan — Tool outputs: capped, offloaded, restorable

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-07-context-window-management-design.md` §2
  (tool-boundary cap + offload) incl. the 2026-07-08 amendment (agentic retrieval is exempt)
- Backend: `src/exulu/tool-output-offload.ts` (`guardToolOutput`, `buildNotice`, `c4a1848`),
  `src/templates/tools/session-file-read-tool.ts` (`read_session_file`, `85bfcd1`),
  wiring + `OUTPUT_OFFLOAD_EXEMPT_TOOL_IDS` in
  `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`,
  system-prompt hint in `src/exulu/provider.ts` (~line 1088)
- Brand: `releases/2026-07-08-context-management/hyperframes-design.md`

## What shipped

A single guard now wraps **every** tool's output (built-ins, MCP, agent-as-tool, web
search — everything except `agentic_context_search`, whose pipeline bounds itself). Under
the cap (`min(25K, max(4K, 10% of contextWindow))` tokens) the value passes through
untouched. Over the cap, the **full output** is stored as a session file
(`tool-output-<tool>-<id>.txt` — it appears in the Session files side panel) and the model
receives a small object: `{ truncated: true, notice, sessionFile, preview }` where the
notice names the escape hatch. The new **`read_session_file`** tool pages any session file
by line range (`filename`, 1-based `offset`, `limit`, default 250 lines, hard 16K-char
slice cap so a read can never blow the context again). The system prompt tells the model
to page rather than re-ask the user. Restorable by construction — nothing is lost.

## Hook

**"An 84,000-token tool output? Handled."** — capped in context, saved in full, paged
back on demand.

## Surface area

Agent-loop behavior — no user action at all. Chat-transcript styled: two tool-execution
cards inside the product chat column (light #FDFDFD background, JetBrains Mono payloads).
This is the "watch the agent self-correct" short.

## Reconstruction cues (exact, from shipped code)

Demo model: 200K window → cap = min(25,000, max(4,000, 20,000)) = **20,000 tokens**.

Tool cards: product-style collapsed tool rows — `rounded-md border bg-card px-3 py-2`,
header `text-xs font-medium` with tool name in JetBrains Mono, body `text-xs font-mono
text-muted-foreground whitespace-pre-wrap`. Card 1 = `web_search`, card 2 =
`read_session_file`. Keep both cards narrow (max-w ~720px) in a chat column.

Card 1 result (verbatim `buildNotice` output, from `tool-output-offload.ts`):

> Tool output truncated: ~84,213 tokens (limit 20,000). The FULL output is saved as
> session file "tool-output-web_search-a1b2c3d4.txt" — call read_session_file with
> { filename: "tool-output-web_search-a1b2c3d4.txt", offset, limit } to read specific
> line ranges.

Render above the notice 2–3 greyed preview lines (the head preview is the first ~4,000
chars) with a fade-out mask, so "truncated" reads visually.

Card 2 input (real schema: `filename` string, `offset` int ≥1, `limit` int 1–1000):

```json
{ "filename": "tool-output-web_search-a1b2c3d4.txt", "offset": 1200, "limit": 80 }
```

Card 2 result (real return shape from `session-file-read-tool.ts`):

```json
{ "content": "…80 lines of the stored output…", "totalLines": 5312, "offset": 1200, "linesReturned": 80 }
```

Optional ambient payoff cue: header files chip ticks "2 files" → "3 files"
(`chat.header.filesChip`: "{count} files") when the offload lands — only if it doesn't
crowd the frame; the notice card is the star.

## Demo arc — timed beats (1920×1080, 9.5s, zero user actions)

| t (s) | On screen | Notes |
|---|---|---|
| 0.0–0.4 | Hook enters: "An 84,000-token tool output? Handled." | 5 words → 1.4s floor |
| 0.4–1.9 | Hook holds static (1.5s) | ≥1.4s ✓ |
| 1.9–2.3 | Crossfade to chat column; `web_search` tool card visible, output streaming in fast (blur/ticker feel), a small token counter runs up "…~84,213 tokens" | establish the problem |
| 2.3–2.9 | Output collapses: preview lines + the truncation notice settle into the card; the session-file name is the visual anchor | the guard fires (state change) |
| 2.9–4.5 | Card holds still; marker-sweep underline on `"tool-output-web_search-a1b2c3d4.txt"` at ~3.3s | breath ✓ + the notice needs real read time (1.6s) |
| 4.5–5.0 | `read_session_file` card enters below with the JSON input `{ filename, offset: 1200, limit: 80 }` | the agent self-corrects |
| 5.0–5.6 | Result appears: `totalLines: 5312, linesReturned: 80` + content lines | payoff of the mechanism |
| 5.6–6.4 | Everything holds still (800ms) | breath after change ✓ |
| 6.4–6.8 | Payoff caption enters: "Capped in context. Saved in full. Paged on demand." | 9 words → 1.8s floor |
| 6.8–8.8 | Payoff holds static (2.0s) | ≥1.8s ✓ |
| 8.8–9.5 | Fully still resting frame (700ms) | loop rest ✓ |

## Code snippet decision

**Yes — JSON.** The truncated-output shape is what gateway/SDK consumers actually receive
in tool results (`TruncatedToolOutput`, `src/exulu/tool-output-offload.ts`). Real field
names, real notice text.

Label: "What the model receives instead of 84K tokens"

```json
{
  "truncated": true,
  "notice": "Tool output truncated: ~84,213 tokens (limit 20,000). The FULL output is saved as session file \"tool-output-web_search-a1b2c3d4.txt\" — call read_session_file with { filename: \"tool-output-web_search-a1b2c3d4.txt\", offset, limit } to read specific line ranges.",
  "sessionFile": "tool-output-web_search-a1b2c3d4.txt",
  "preview": "…first ~4,000 characters kept inline…"
}
```
