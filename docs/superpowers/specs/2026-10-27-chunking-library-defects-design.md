# Chunking library defects — Design

**Date:** 2026-10-27
**Status:** defects 2 and 3 FIXED 2026-10-27; defect 1 still open
**Repos:** `exulu/backend`
**Found by:** the transcripts chunker work (`src/exulu/transcription/transcript-chunker.ts`)

## 1. Intent

Two defects in `src/chunking/` surfaced while giving the `transcriptions` context a real
chunker. Neither is transcript-specific and neither was fixed there, because both change
behaviour for *every* context and for client code that consumes the exported
`ExuluChunkers` — a chunk-boundary change is a re-embed event for whoever is running it,
so it should land deliberately rather than riding along inside a bug fix.

Recorded here so they get fixed on purpose.

| # | Defect | Status |
|---|--------|--------|
| 1 | Custom delimiters split only at their first occurrence | **open** — deliberately not fixed, it moves chunk boundaries for client code that works today |
| 2 | The embed path downloaded 1.6MB per item | **fixed** — `ee/tokenizer.ts`, process-wide ranks cache |
| 3 | A second `chunk()` on one instance crashed WASM | **fixed** — `ee/tokenizer.ts` + both chunkers |

## 2. Defect 1 — custom delimiters split only at their first occurrence

`RecursiveChunker._splitText` (`src/chunking/recursive.ts:355`, and the same mistake at
`361` and `367`):

```ts
t = t.replace(delimiter, delimiter + this.sep);
```

`String.prototype.replace` with a **string** pattern substitutes only the first match.
`delimiter` is always a string here (the loop iterates the delimiter array), so each
configured delimiter marks exactly **one** split point in the entire document.

### 2.1 What it does in practice

Measured on a 10-turn transcript render (one `Speaker: text` turn per line, 809 chars),
`chunkSize: 48`, levels `[{delimiters:["\n"]}, {delimiters:[". ","! ","? "]}, {whitespace:true}, {}]`:

| chunk | level | tokens | text |
|-------|-------|--------|------|
| 0 | 0 | 19 | `Daniel: This is turn number 0, …` |
| 1 | 2 | 47 | `Alex: This is turn number 1, …` |
| 2 | 2 | 46 | `" long enough to matter but still a single sentence.\nAlex: …"` |
| 3 | 2 | 46 | `" a single sentence.\nDaniel: This is turn number 4, …"` |
| … | 2 | … | … |

Only chunk 0 comes from the configured newline level. The first newline is consumed as the
single split point; the remaining 171 tokens exceed the budget, fall to level 1 (whose
`". "` never matches, because a turn ends `".\n"`, not `". "`), and land at level 2 —
whitespace — which merges words to exactly the budget and cuts mid-sentence, stranding
text from its speaker label.

This also degrades the **default** `RecursiveRules`: level 0 is
`["\n\n", "\r\n", "\n", "\r"]`, so a 50-paragraph document yields at most ~4 paragraph
splits regardless of length, and the rest is chunked at word level.

### 2.2 Fix

Replace every occurrence at all three sites:

```ts
t = t.replaceAll(delimiter, delimiter + this.sep);
```

`SentenceChunker._splitText` is already correct — it uses `split(c).join(c + sep)` — which
is why the transcripts fix uses `ExuluChunkers.sentence` instead.

### 2.3 Blast radius

Nothing inside this repo constructs a `RecursiveChunker`; it is reachable only through the
exported `ExuluChunkers.recursive`. So in-repo risk is nil, and the risk is entirely to
client deployments whose contexts supply a recursive chunker: their chunk boundaries move,
and existing embeddings stay as they are until re-embedded. Worth a release note.

## 3. Defect 2 (FIXED) — the embed path fetched 1.6MB from the network per item

`ExuluTokenizer.create` (`ee/tokenizer.ts:19`) calls tiktoken's `load()`, and that function
has **no cache at all** (`node_modules/tiktoken/load.cjs:145` — it is a bare
`fetch(url).then(r => r.text())`). `this.encoder` memoizes only within a single
`ExuluTokenizer` instance, and both chunkers call `tokenizer.free()` at the end of every
`chunk()` (`sentence.ts:409`, `recursive.ts:667`), so an instance is single-use anyway.

Every chunker construction therefore pulls the BPE ranks for `gpt-3.5-turbo`
(`cl100k_base`, ~1.6MB) from `openaipublic.blob.core.windows.net`. Since
`createAndUpsertEmbeddings` builds a chunker per item, that is **one 1.6MB third-party
download per embedded item**.

### 3.1 Consequences

- A bulk re-embed of N items makes N downloads. The `embeddings.generate.all` inline
  ceiling is 2000 items (`src/exulu/embedder-change.ts:51`) — ~3GB of egress for one
  context, and the wall-clock is dominated by the fetches, not the embedding calls.
- The embed path has an undeclared hard dependency on a Microsoft-hosted endpoint. In a
  deployment that cannot reach it — air-gapped, or egress-filtered — chunking throws and
  **no embeddings can be produced at all**. This is not hypothetical: it is how the defect
  was found (`ConnectTimeoutError … openaipublic.blob.core.windows.net:443`).
- It is a per-item latency floor of one cold TLS round-trip plus 1.6MB.

### 3.2 Fix as implemented

`ee/tokenizer.ts` now holds a module-level `Map<string, Promise<TiktokenBPE>>`, keyed by
**encoding** rather than model — every current gpt-3.5/gpt-4 name maps to `cl100k_base`, so
keying by model would re-download the same bytes. The *promise* is cached, so concurrent
callers share one in-flight download; a rejection deletes its entry, so one transient
timeout cannot poison the process for its lifetime.

`create()` still builds a `Tiktoken` **per instance** from the shared ranks. That is
deliberate: both chunkers `free()` after every `chunk()`, and a shared encoder would be
freed out from under every other caller. Construction from cached ranks is the cheap half.

Measured on `src/exulu/transcription/transcript-chunker.test.ts`, which builds 10 chunkers:
**10 downloads → 1**, suite ~80s and failing 1-in-5 → ~4s and stable over 6 runs.

### 3.3 Still open: offline operation

One download per process is not zero. A deployment with no egress to
`openaipublic.blob.core.windows.net` still cannot embed, it just fails once per process
instead of once per item. Fixing that properly means vendoring the ranks into the package or
accepting an operator-supplied path — a packaging decision, not done here.

## 4. Defect 3 (FIXED) — a reused chunker instance crashed WASM

`chunk()` ends with `await this.tokenizer.free()` in both chunkers (`sentence.ts`,
`recursive.ts`). `ExuluTokenizer.free()` freed the `Tiktoken` but left `this.encoder`
pointing at it, so the **second** `chunk()` on an instance dereferenced freed memory:

```
await chunker("one")            // works
await chunker("two")            // Error: null pointer passed to rust
await chunker(["a", "b"])       // Error: null pointer passed to rust
```

The batch form is the one advertised in both chunkers' own JSDoc example blocks, and
`chunkBatch` reaches it by calling `chunk()` once per text on a single instance. It could
not have worked since `free()` was introduced. Nothing in this repo hit it only because
`defaultChunker` and the transcript chunker each build a fresh chunker per item.

### 4.1 Fix as implemented

- `free()` sets `this.encoder = null` after freeing, so a dangling pointer is unreachable
  and a double `free()` is a no-op rather than a WASM crash.
- `ExuluTokenizer` remembers its model name and exposes `ensure()`, which rebuilds a freed
  encoder from the **cached** ranks — no network. This fix is only cheap because defect 2
  was fixed first.
- Both chunkers `await this.tokenizer.ensure()` at the top of `chunk()`.

Regression tests: `src/chunking/instance-reuse.test.ts` (both chunkers: second call, batch
call, four sequential calls) and the lifecycle cases in `ee/tokenizer.test.ts`. Reverting
the one-line `this.encoder = null` turns 9 of them red.
