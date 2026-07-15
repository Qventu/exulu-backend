# Feature plan — Sandbox output truncation: overflow-proof tool results (PROSE + snippet)

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-03-sandbox-output-truncation-design.md`
- Code: `src/utils/truncate-tool-output.ts` (verified — marker text below is
  verbatim), call sites in `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`
- Commit: `b5656f0`

## What shipped

Sandbox tool output (`readFile.content`, `bash.stdout`, `bash.stderr`) is now
capped at **25% of the agent's context window** (default window: 128k tokens →
128,000-character cap, using the 1 token ≈ 4 chars rule). Oversized output gets
a **head + tail split** — the omitted middle is replaced by a marker that tells
the agent exactly what happened and how to fetch specific sections with
granular shell commands (`grep -n`, `sed -n`, `head`, `tail`, `awk`).

Per-field tail fractions match where the signal lives: `readFile` keeps 95%
head (files read top-to-bottom), `bash.stdout` 90/10, `bash.stderr` keeps a
40% tail (errors live at the end). Agents `cat`-ing a 60-page PDF or running a
log-spewing script now degrade gracefully instead of blowing the context.

## Hook

**"cat a 60-page PDF without killing the context."** Oversized tool output
self-describes and hands the agent the recovery commands.

## Surface area

Backend/agent-runtime feature, prose-only. Audience: anyone running file/skill
agents; the interesting artifact is the marker the agent sees.

## Page prose plan (2 paragraphs)

1. The failure mode: one oversized `readFile` or `bash` result used to overflow
   the context and take the whole turn down with it — unrecoverable, because
   the content came back verbatim.
2. The fix: head+tail with a self-describing marker; the agent keeps both ends
   plus a menu of surgical reads. Numbers: 25% of context per tool call, 128k
   default, stderr biased toward the tail.

## Code snippet — EARNED (payload-style: what the agent sees)

Marker format verbatim from `src/utils/truncate-tool-output.ts` (values
illustrative):

```text
[READFILE OUTPUT TRUNCATED: output was 412,830 characters; showing first
121,600 and last 6,400 characters (limit: 128000 = 25% of 128000-token
context). 284,830 characters omitted. To read specific sections use:
  grep -n "pattern" <file>        # find specific text
  sed -n '1,50p' <file>           # lines 1–50
  head -n 100 <file>              # first 100 lines
  tail -n 100 <file>              # last 100 lines
  awk 'NR>=10 && NR<=50' <file>   # lines 10–50]
```

Label on page: "What the agent sees instead of a context overflow".
