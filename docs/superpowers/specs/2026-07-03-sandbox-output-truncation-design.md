# Sandbox Tool Output Truncation

**Date:** 2026-07-03  
**Status:** Approved  
**Files affected:** `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`

---

## Problem

The main agent's sandbox tools (`readFile`, `bash`) can return output that is too large
for the agent's context window. For example, `cat`-ing a 60-page PDF or running a script
that emits megabytes of logs causes context overflow and downstream errors. The agent has
no way to recover gracefully because the oversized content is returned verbatim.

---

## Goal

When a sandbox tool returns a string field that exceeds 25% of the agent's context window,
truncate it and replace the omitted middle with a clear marker that tells the agent what
happened and how to retrieve specific sections using granular shell commands.

---

## Scope

- **In scope:** `readFile.content`, `bash.stdout`, `bash.stderr` in the `sandboxTools`
  block of `convert-exulu-tools-to-ai-sdk-tools.ts`.
- **Out of scope:** `writeFile` (returns structured metadata, never large text),
  `create-sandbox.ts` internals (truncation is a tool-exposure concern, not a sandbox
  concern), other ExuluTools (handled separately by their own execute wrappers).

---

## Helper: `truncateToolOutput`

```ts
truncateToolOutput(
  output: string,
  maxContextLength: number | undefined,
  toolName: string,
  tailFraction: number = 0.1,
): string
```

### Algorithm

1. Compute `effectiveCtx = maxContextLength ?? 128_000`; if `effectiveCtx <= 0`, use `128_000`.
   Then `charLimit = floor(effectiveCtx * 0.25 * 4)`.
   - Rationale: 1 token ≈ 4 characters; cap single tool output at 25% of context.
   - Example: 128 000-token window → charLimit = 128 000 characters.
2. Clamp `tailFraction` to `[0, 1]`.
3. If `output.length <= charLimit`, return `output` unchanged.
4. `headChars = floor(charLimit * (1 - tailFraction))`.
5. `tailChars = charLimit - headChars`.
6. Safety guard: if `headChars + tailChars >= output.length` for any reason (e.g. rounding),
   return `output` unchanged rather than producing a nonsensical split.
7. Return:
   ```
   output.slice(0, headChars)
   + MARKER
   + output.slice(-tailChars)
   ```

### Marker format

```
\n\n[<TOOLNAME> OUTPUT TRUNCATED: output was <N> characters; showing first <headChars>
and last <tailChars> characters (limit: <charLimit> = 25% of <ctxLen>-token context).
<omittedChars> characters omitted. To read specific sections use:
  grep -n "pattern" <file>        # find specific text
  sed -n '1,50p' <file>           # lines 1–50
  head -n 100 <file>              # first 100 lines
  tail -n 100 <file>              # last 100 lines
  awk 'NR>=10 && NR<=50' <file>   # lines 10–50]
```

---

## Call sites

All three are in the `sandboxTools` block in `convert-exulu-tools-to-ai-sdk-tools.ts`,
wrapping the execute functions returned by `sharedSessionSandbox.tools`.

| Field | `tailFraction` | Rationale |
|---|---|---|
| `readFile.content` | `0.05` | Files read top-to-bottom; head is most valuable |
| `bash.stdout` | `0.10` | Results often near the end; middle can also matter |
| `bash.stderr` | `0.40` | Error messages almost always appear at the tail |

---

## Edge Cases

| Scenario | Behaviour |
|---|---|
| `maxContextLength` is `undefined` | Default to 128 000 tokens |
| `maxContextLength` is `0` or negative | Clamp to 128 000 tokens default |
| `tailFraction` outside `[0, 1]` | Clamp to `[0, 1]` |
| Head + tail overlap (barely over limit) | Return full output unchanged |
| `bash.stderr` is absent or empty string | Pass through unchanged (length check: 0 ≤ limit) |
| Non-string result fields | Existing `typeof === 'string'` guard passes through unchanged |

---

## What is NOT changed

- `create-sandbox.ts` — sandbox internals are unchanged.
- `writeFile` — result is `{ success, path, url, key }`, never large text.
- The `[exulu-artifacts]` block appended to `bash.stdout` in `create-sandbox.ts` — this
  is appended by the inner execute; our wrapper sees the combined string and truncates it
  if the whole thing exceeds the limit. The artifacts block is short enough that in
  practice it is never the cause of overflow.

---

## Testing

- Unit test `truncateToolOutput` directly:
  - Output under limit → returned unchanged.
  - Output over limit → head + marker + tail structure.
  - `tailFraction = 0` → no tail, only head + marker.
  - `tailFraction = 1` → no head, only marker + tail.
  - `maxContextLength = undefined` → uses 128k default.
  - `maxContextLength = 0` → uses 128k default (clamp guard).
  - Head + tail overlap → returned unchanged.
- Integration smoke test: call `readFile` with a file larger than the limit; assert the
  returned `content` contains the marker string.
