# Claim Check Stage 4 — source coverage (client-assembled) — Design

Amends `2026-10-13-claim-check-design.md`, which stays the authority for everything this
document does not change. Read its §2.4 (scoring semantics), §4 (API contract) and §5 (chat
integration) first.

## 1. Why

Stage 3 made the feature honest by making it silent. A fragment is withheld whenever a turn
could rest on evidence the check will not receive — the session-items tool, the three document
tools, internet search, an attached document, or a recalled memory — because scoring an answer
against part of its evidence reports grounded claims as `unsupported`, and a false "unfounded"
verdict about someone's own answer is the worst output this system has.

The cost of that honesty is larger than it looked: **any agent with memory enabled, and any
session that has ever carried an attachment, produces no claim checks at all.** On NEWLIFT's
traffic that is most of it.

This stage removes most of the silence the cheap way: the evidence those turns used is, for
four of the six paths, **already in the client's hands**. The client sends it, and the check
runs against complete evidence instead of being skipped.

## 2. Goal and non-goals

**Goal.** A turn that used recalled memories, `read_session_file`, `parse_document`,
`internet_search` or session-items retrieval gets a *complete* check rather than no check.

**Non-goals, each a decision rather than an omission:**

- **No server-side resolution of any source.** The endpoint receives content and trusts it; it
  never reads a database to fill in evidence the caller did not send. This keeps the API usable
  by callers who have no IMP knowledge base at all, which is the product decision §1 of the
  parent spec records. It is also why attachments stay uncovered (§5).
- **No browser-side document extraction.** The client could parse an uploaded PDF itself, but
  the server already extracted that text and the model read *that* version. Verifying against a
  second, differently-extracted text would check an answer against something the model never
  saw.
- **No trust tiers on verdicts.** A web page and a knowledge-base document are both "a source
  the caller provided". The panel shows every verdict with its quote and source name, so the
  reader makes the provenance judgment. Introducing supported-by-web as a separate verdict
  would put a second axis into a model whose whole value is that `supported`, `contradicted`
  and `unsupported` mean exactly one thing each.
- Coverage-aware scoring (reporting *partial* coverage rather than suppressing) is **Stage 5**.
  This stage shrinks what needs covering; it does not change what happens to the residue.

## 3. The request contract gets simpler

Today `sources[]` requires an opaque `id` per source, which forces a third-party caller to
invent identifiers before it can use the endpoint. The new shape asks for the one thing only
the caller can supply:

```jsonc
{
  "question": "Womit arbeitet die FST-2XT?",
  "answer": "Die FST-2XT arbeitet mit 230 Volt.",
  "sources": [
    { "name": "handbuch.pdf", "type": "document", "content": "Die FST-2XT arbeitet mit 230 Volt. …" },
    { "name": "Kundenpräferenz Sprache", "type": "memory", "content": "Der Kunde bevorzugt Deutsch." }
  ]
}
```

- **`content` is the only required field** on a source.
- `name` is optional and is what a reader sees. Absent, the panel falls back to the quote alone
  — it already does, and it must never render an id at a reader.
- `type` is optional, informational, and one of `knowledge_base | document | memory | web |
  session_item | other`. The engine treats every type identically (see the trust-tier non-goal);
  it exists so a panel can group and label, and so a request is self-describing in a log.
- `id` stays **optional**. A source without one is assigned `s<position>` (`s1`, `s2`, … in
  array order), so `evidence[].sourceId` always resolves and a caller who supplied no ids can
  map evidence back by position. Our own client keeps sending stable ids (`memory:<id>`,
  `tool:<toolCallId>`) because it needs them for dedup and for the completeness guard in §4.

  Two precise rules, because mixing supplied and generated ids in one array otherwise collides:
  a generated id that would duplicate a **supplied** one gains `_` suffixes until unique, and
  two sources supplying the **same** id are a 400 rather than a silent merge — an evidence
  quote that cannot be traced to one document is worse than a rejected request.

This is a loosening, and it has to stay one: **an unrecognised `type` is ignored, not rejected.**
The field is informational by design (see the trust-tier non-goal) — it cannot change a verdict,
so refusing an entire check because a label is misspelled trades a working check for a 400 on a
value the engine discards. Parsed with a fallback rather than a bare enum, every request that is
valid today stays valid: before this change the schema silently stripped an unknown key, and a
bare `z.enum` would have turned that 200 into a 400.

## 4. What the client assembles, and from where

Every type below is built from data the client already holds in the message it is rendering.

| `type` | Content comes from | id / name |
|---|---|---|
| `knowledge_base` | the retrieval tool result's `chunks[].chunk_content`, pooled from **every** part of the turn carrying a chunk with this `item_id` and deduplicated by `chunk_id` — content unchanged from Stage 3, and no tool display name is involved | `item_id` / `item_name` |
| `memory` | `metadata.recalledMemories[].information` — the same list the memories panel renders — falling back to `title` when the information is blank, because the prompt block the model read carries the title too | `memory:<id>` / `title` |
| `document` | tool result `{ content }` from `read_session_file` **or** `parse_document` — they share the key, so one handler serves both | `tool:<toolCallId>` / the filename from the tool call's input |
| `web` | `internet_search`'s `{ result: <JSON> }`: **always** the prose answer in `content` — the text the assistant paraphrased, with the inline citation JSON normalised back to `[n]` — *plus* one source per cited page, so a verdict can still cite a page | the body: `tool:<toolCallId>` / the search query. A page: `tool:<toolCallId>#<index>` / its title, falling back to its URL |
| `session_item` | session-items retrieval's `{ result: <JSON array> }` of per-context `context.search` responses, one source per item found under `[].chunks[]` | the item's id / its name |

**A `knowledge_base` entry's `toolCallId` is provenance, not a lookup key.** The manifest names one
entry per item, deduplicated by item id, so an item several retrieval calls returned carries only
the call that saw it *first* — while each call serialises only its own chunks. Reading that one
part alone drops every passage the other calls returned for the same item, which is the
score-it-against-part-of-the-evidence failure §2.4 is about, and the endpoint's duplicate-id 400
rules out naming the item twice. Default-on `suppress_duplicate_passages` makes it likelier, not
rarer: it frees result slots for *different* passages of an item already seen. The client therefore
pools by `item_id`, which keeps attribution correct by construction — a chunk carrying this item's
id is a passage of this item, whichever call produced it.

**The web body is not optional.** `content` is the prose answer; a `search_results[i].snippet` is a
sentence or two. Sending only the snippets scores a claim that paraphrases the body but appears in
no snippet `unsupported` — a false "unfounded" on an ordinary search turn. Extra sources cost no
model calls (§7). Perplexity's synthesis counting as evidence follows from §2's no-trust-tiers
decision: the engine checks grounding in the evidence the model was given, not truth.

**The fragment becomes a manifest.** Stage 3's fragment carries parallel `sourceIds` and
`toolCallIds` arrays, and the client locates retrieval parts by matching the tool's *display
name* — the one place where a rename on the backend silently stops the feature, which the
Stage 3 pre-flight scan flagged and a test now pins. Replacing both arrays with

```jsonc
{ "claimCheck": { "enabled": true, "sources": [
    { "type": "knowledge_base", "id": "i1",            "toolCallId": "call_1" },
    { "type": "memory",         "id": "memory:m_7" },
    { "type": "document",       "id": "tool:call_4",   "toolCallId": "call_4" },
    { "type": "web",            "id": "tool:call_9",   "toolCallId": "call_9" }
] } }
```

lets the client find each part **by tool-call id** and pick the handler its `type` names — so the
frontend needs no tool-name knowledge at all, and that duplicated constant is deleted. The
manifest deliberately uses the same `type` vocabulary as the request in §3, so nobody has to
translate between two words for one concept.
Ids only, still: no content travels in metadata, for the reason §5 of the parent spec gives.

**The completeness guard survives, now across types.** `claimCheckRequestFor` refuses to run a
check when it recovers fewer sources than the manifest named. That rule is unchanged and is
still the client half of §2.4: verifying an answer against part of its evidence is what
produces a false `unsupported`.

## 5. What stays uncovered, and why

**Each covered handler has three answers, not two.** Inverting Stage 3's suppression gates into
inclusion gates lost the third one, and losing it is a false-`unsupported` generator:

- **provably nothing** — a cleanly-parsed empty result (a search that matched nothing, a context
  with no embedder, a document tool's own `{ error }` failure message). The tool contributed no
  evidence, so the entry is skipped and the fragment is still emitted: the remaining sources *are*
  the whole of the answer's evidence.
- **readable** — the entry is named. Every arm's readable predicate mirrors the client's own
  recovery, literally rather than approximately; the client is the thing that has to produce the
  source, so its arm is the specification.
- **unreadable** — the tool contributed evidence this fragment cannot represent: an **offloaded**
  output (`{ truncated, notice, preview }`, no `result` key, whose 4,000-character preview the
  model *did* read — `read_session_file`'s 16,000-char slices sit right on the offload floor for a
  ≤40k-window model, and `internet_search` is not offload-exempt either), a payload that does not
  parse (`{ result: "Max retries exceeded …" }` after a rate-limited search), or a shape the tool
  does not emit. **The whole fragment is withheld**, exactly as for `view_document_page` and an
  attachment below. "Nothing here" and "here it is" cannot be the only two answers: an offloaded
  output that reads as "nothing here" has the check score the answer against part of its evidence.

Each of these withholds the fragment exactly as Stage 3 does, and each is Stage 5's problem:

- **An attached document.** Extraction happens server-side in `processFilePartsInMessages`
  during the turn, so the client holds the raw file and never the extracted text. Covering it
  would need either browser-side extraction (verifying against text the model never read) or a
  server-side read (ruled out in §2). The detection stays the inlining wrapper
  `<file file name = "` on a user text part, because that is the only trace that survives
  persistence.
- **`view_document_page`.** Its output is `{ attached: true, filename, page, note }` — the
  evidence is a *rendered image*. A text engine cannot verify against an image, so this path is
  permanently uncoverable, not merely deferred.
- **A memory list the backend withheld.** `recalledMemoriesMetadata` returns nothing when the
  viewer is a guest and the agent's `guests.showRecalled` is false. The client then has no
  memory text, so that turn is uncovered and the fragment must stay absent. **The claim-check
  fragment's memory expectation has to mirror that gate**, or a guest turn will name memory
  sources the client cannot produce and the §4 guard will refuse every check.
- **A truncated source** — see §6.

## 6. Truncation is already reported — it only lacks names

I wrote this section claiming truncation was silent. It is not: Stage 1 already sets
`status: "partial"`, pushes a note saying how many sources were cut and how many characters of
evidence went unsearched, and explains in that note that *a claim supported only there reads as
unsupported*. A Stage 1 review (R35) caught precisely this and made a partly-read check refuse
to report `ok`. The parent spec's §2.4 is intact here and this stage does not need to defend it.

What the note lacks is **which** document was cut. "2 source(s) were truncated" does not let a
reader act; "handbuch.pdf was truncated" does. So Stage 4's only truncation work is adding the
source names to the existing note. The `partial` status, the character count and the warning
sentence stay exactly as they are.

## 7. Cost and privacy

**Cost.** `evidence.ts` selects the top passages per claim, so a verification prompt stays
bounded no matter how many sources arrive — more sources grow only the local lexical index,
which costs no model calls. The per-request caps that produce a 413 are unchanged.

**Privacy.** Nothing new is exposed by construction: every source is content the client already
had and already displays. Memory `rights_mode` is respected upstream by the recall collector,
and the guest gate in §5 is honoured rather than bypassed.

## 8. Testing

- A fixture per kind, built from that tool's real output shape, asserting the source's content,
  name and id.
- The guard: a manifest naming three sources with only two recoverable yields no request.
- The test Stage 3 could not have: a memory turn with retrieval produces a **complete** check —
  a fragment, a request carrying both kinds, and no suppression.
- A guest turn whose memory list was withheld produces no fragment.
- A truncated source produces a note naming it.
- The deleted constant: a test asserting the client locates a retrieval part by tool-call id,
  so a display-name rename cannot affect it.

## 9. Delivery order

1. **Backend** — the fragment manifest (`sources[{kind,id,toolCallId}]`), suppression narrowed
   to attachments, `view_document_page` and a withheld memory list, mirroring the memory gate.
2. **Backend** — the request contract: `content`-only sources, optional `id` with positional
   assignment, the `type` enum, truncation notes.
3. **Frontend** — the four handlers plus manifest consumption, replacing name-matching with
   tool-call-id lookup; the completeness guard across kinds.
4. **Frontend** — panel labels for the new types (a memory and a web page should not read as
   knowledge-base documents).

Stage 1's docs (`mintlify-docs/api-reference/rest/claim-check.mdx`) change with step 2; the
parent spec's §9 and §10 get this stage's entry and lose the lines it closes.

## 10. Out of scope → Stage 5

Coverage-aware scoring: when a claim's evidence set could not include a source the answer used,
report it as `not_checked` with a reason and force the label to `n/a`, rather than withholding
the whole check. That is what finally covers attachments, rendered images, withheld memory
lists and truncated remainders — the residue this stage leaves — and it is an engine change
plus a §2.4 amendment.
