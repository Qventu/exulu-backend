# Typed JSON fields and key-level merge — design

**Date:** 2026-11-09
**Status:** proposed

## Intent

A context field of type `json` is, to an agent, an opaque blob. The write tool
describes it as *"a valid JSON string"* (`src/templates/tools/context-write-tools.ts:112`)
and nothing more. The model has to guess the shape, and when it guesses wrong
nothing stops it.

That single line is why purpose-built tools exist in IMP apps. A hand-written
tool like M&V's `mv_pitch_entwurf` declares a proper Zod schema for what a
field proposal looks like, so the model gets it right — and the app pays for
that precision with a tool it has to maintain forever.

Two changes remove that cost:

1. A `json` field may declare its shape. The generic write tools then expose
   that shape instead of "a JSON string".
2. A write may merge into a `json` field by key instead of replacing it.

Together they make a generic `update_item` call as precise as a purpose tool,
and let one call carry what today needs sixty-eight.

## Why now

M&V's pitch matrix stores 68 fields as 68 rows, each with 13 structural
columns copied verbatim from a constant. Moving it to one row with a `json`
column is obviously right and currently impossible: the agent would be writing
into a blob it cannot see the shape of, and every single-field edit would
rewrite the whole matrix, losing a concurrent editor's work.

The same shape recurs in every IMP app with a structured domain. This is a
platform gap, not an M&V one.

## Goals

1. A `json` field can declare a schema, in code, next to the field.
2. The generated create/update tools expose that schema to the model.
3. Writes that violate the schema are rejected, with a message the model can
   act on.
4. A write can merge keys into a `json` field without replacing the whole
   value.
5. Both write paths behave identically.

## Non-goals

- JSONPath filter operators (`@?`, predicates, numeric comparison inside
  json). The existing `contains` → `@>` already covers exact containment,
  which is the common case. Revisit when something needs it. Note this is
  about new *operators*; validating the paths of the operators that already
  exist is Part C and is in scope.
- A GIN index for `json` columns. Containment is a sequential scan today; at
  the row counts these contexts carry that is not measurable. One migration
  line when it is.
- Generating a real GraphQL object type from the schema. The scalar `JSON`
  stays. Worth doing later; not needed for any of the goals above.
- Schemas for contexts defined anywhere but code.

## Anti-goals

- **Silently dropping undeclared keys.** The agent wizard already does this to
  json tool-config blobs — it re-serializes through Zod and deletes what the
  schema does not name, which killed `tuning.engine: "v2"` in NEWLIFT
  production. Repeating that mistake at data level would be worse: it would
  delete customer data on an unrelated write. Validation here never strips.
- **A second write path with its own rules.** There are already two, and they
  diverge; this must not make it three.
- **Making the schema mandatory.** Every existing `json` field keeps working
  untouched, with no schema and no validation.

## Part A — Declaring the shape

`ExuluContextFieldDefinition` (`src/exulu/context.ts:58-76`) gains one
optional property:

```ts
export type ExuluContextFieldDefinition = {
  name: string;
  type: ExuluFieldTypes;
  // …existing properties…
  /**
   * For `type: "json"` only. Declares the shape of the value so the generated
   * write tools can expose it to a model and so writes can be validated.
   * Omitted: the field behaves exactly as today, an opaque blob.
   */
  schema?: z.ZodTypeAny;
};
```

Contexts are instantiated in code (`new ExuluContext({...})`), so a Zod object
can be referenced directly — no JSON Schema round trip, no serialization
problem. If DB-defined contexts ever need this, they will need JSON Schema and
a converter; that is a later question and this property does not foreclose it.

### Where it is consumed

`src/templates/tools/context-write-tools.ts:112`, today:

```ts
schema = z.string().describe(`The ${field.name} of the item, as a valid JSON string.`);
```

becomes the declared schema when one exists, and the current line when it does
not. That is the whole of Part A's effect on the model-facing surface, and it
is the reason the rest is worth building.

### Validation

Validation belongs at the write chokepoints (Part B), not in the tool layer —
a GraphQL write must be held to the same shape as a tool write.

**Parse, do not strip.** Use the schema to *check*, then write the caller's
original value. A `.passthrough()` object or an explicit validate-only step;
never `schema.parse(value)` with the result substituted for the input. See the
anti-goal above — this is not a style preference, it has cost a customer
production data once already.

On failure: reject the write and return Zod's issue list. A model that gets
`felder.budget_gesamt.konfidenz: expected "low" | "medium" | "high", got "sehr hoch"`
will fix it; one that gets "invalid input" will retry the same thing.

## Part B — Merge by key

### What exists

`update_item` already merges at **column** level: *"Provide the item's id plus
only the fields to change; omitted fields keep their values"*
(`context-write-tools.ts:310`). Supplying `felder` replaces the entire `json`
value.

What is missing is merge **inside** a `json` column.

### The interface

A write may address a `json` field in one of two ways:

- **replace** — today's behaviour, and the default. The value given becomes
  the value stored.
- **merge** — the given object's top-level keys are merged into the stored
  object. Keys not mentioned keep their stored values. An explicit `null`
  deletes a key.

Shallow merge at the top level only. Deep merge invites the question of how to
delete something nested, and every answer to that is a small language nobody
asked for. A caller who needs to change one leaf sends that key's whole object
— which is exactly what the 68-field case does anyway.

How the caller expresses this (a sibling `_merge` list, a wrapper object, a
per-field convention) is left to the builder, with one requirement: it must be
expressible in both the Zod tool input and the GraphQL `Input` type, because
of the next section.

### Both write paths

This is the part that will go wrong if it is not stated.

| Path | Writes via | Used by |
|---|---|---|
| Tool | `context.updateItem` | `update_item`, import |
| GraphQL | direct knex `.update()` in `src/graphql/mutations/index.ts:830` | artifacts, the IMP UI, any API client |

They are independent implementations. The GraphQL resolver does not call
`context.updateItem`.

Merge semantics and schema validation must land in **both**, and the only
honest way to do that is a shared helper both call — not two implementations
that agree today.

The M&V case makes this concrete: the pitch artifact writes fields over
GraphQL with a 600 ms debounce per field. If merge exists only on the tool
path, two analysts editing different fields of the same matrix will overwrite
each other, and the feature will look like it works right up until it loses
someone's afternoon.

**What is NOT different between the paths** (recorded because it was asserted
wrongly during design): both run context processors. `src/graphql/mutations/index.ts:221-229`
calls `contextItemsProcessorHandler` when the trigger is `onUpdate` or
`always`. The paths differ in write mechanics, not in processor behaviour.

While in this code, one related sharp edge is worth a comment at minimum: the
embedding block returns early on success, so a context with both an embedder
trigger and a processor trigger runs **only the embedder** — the processor
silently never runs (`:182-184`). Not this spec's job to fix, but a reader of
the merged code will ask.

## Part C — Query errors an agent can act on

A write that fails tells the caller what to fix. A *query* that fails mostly
does not, and for an agent that is the more expensive half: it does not know
it asked wrongly, so it does not retry — it reports the empty answer as fact.

### The failure that is not an error

`contains` compiles to `whereRaw('?? @> ?::jsonb', [field, JSON.stringify(value)])`.
`JSON.stringify` always produces valid JSON, so the cast never throws. An agent
that filters on a path the data does not have gets **zero rows and no error**:

```
filters: [{ felder: { contains: { konfidenz: "low" } } }]
```

The real shape is `felder.<feld_key>.konfidenz`, so this matches nothing. The
model sees an empty result and concludes there are no low-confidence fields.
It is wrong, it has no way to know, and nothing in the system disagrees with
it. Silence that looks like an answer is the worst failure mode available
here, and it is the current one.

**With a declared schema this becomes detectable.** Before issuing the query,
check the filter value's paths against the field's schema. A path the schema
does not define is a mistake, not a query, and must be refused with a message
rather than answered with zero rows.

Without a schema, nothing changes: the filter runs as today. This is the read-
side payoff of Part A, and on its own it justifies declaring a schema.

### What a refusal has to contain

Four things, and the fourth is the one that matters:

1. What was rejected — the field and the offending path or operator.
2. Why — unknown path, wrong type, unknown operator.
3. What was expected.
4. **What is available instead.**

An error that says `invalid filter` teaches nothing and the model will retry
the same thing. One that says

```
Unknown path "konfidenz" in filter on field "felder".
Valid paths: <feld_key>.wert, <feld_key>.konfidenz, <feld_key>.geprueft,
<feld_key>.belege. Did you mean "<feld_key>.konfidenz"?
```

gets corrected on the next call. The schema already holds this list; not
printing it is leaving the whole benefit on the table.

### Refuse as a result, not as a throw

A rejected query must come back as a **normal tool result** carrying the
message — the shape `update_item` already uses (`{ result: "Provide the id or
external_id of the item to update." }`). Not a thrown error.

The reason is mechanical. The tool wrapper records the failure for audit and
rethrows (`convert-exulu-tools-to-ai-sdk-tools.ts:700-703`); from there the
SDK decides what the model sees, and a stream-level error ends the turn
(`stream-error.ts`). A bad filter is not a turn-ending condition — it is a
typo the model can fix in the next call. Returning it as a result keeps that
possible and keeps the audit trail clean of things that were never faults of
the system.

### Never pass a database error through

If a query does reach Postgres and fails, the model must not receive the
Postgres message. `invalid input syntax for type json` names nothing the model
controls, and the raw text leaks column and type names from contexts the
caller may not be allowed to see. Catch it, map it to the four-part message
above, and log the original.

### The cost

Each self-correction costs a step, and the step budget is already the binding
constraint on these agents (`DEFAULT_MAX_STEPS = 10`). That is an argument for
making the first error good enough to fix in one retry — point 4 again — not
for suppressing errors.

### Scope

This applies wherever a model supplies a filter: the generated
`<table>Pagination` filter inputs, agentic retrieval's `itemFilters`, and
session-items retrieval. Unknown *field* names are already caught by GraphQL's
own input validation with a usable message; it is the json paths inside an
accepted field that are silent today.

## What this does to purpose tools

With A and B, a generic call can do what `mv_pitch_entwurf` does:

```
update_pitch_item(id, felder: { budget_gesamt: {…}, zielgruppe: {…}, … }, merge: ["felder"])
```

— one turn, typed, validated, concurrent-safe. The app keeps purpose tools
only where it needs an external system (SharePoint, HubSpot), a platform
pipeline (OCR), or a guarantee a model cannot make.

That is the actual deliverable here: not a json feature, but the removal of
the reason apps write their own CRUD tools.

## Left to the builder

- How merge is expressed on the wire, subject to the both-paths requirement.
- Whether the shared write helper is new or an extraction of one of the two
  existing paths.
- Whether validation runs on create as well as update (it should; say so
  either way).
- Tests. The both-paths requirement needs a test per path, and the
  concurrency claim needs a test that interleaves two merges on different keys
  and asserts both survive.

## Open

1. Should a declared schema also constrain `contains` filter input? It would
   catch typo'd paths at query time. Cheap, but it couples the filter
   generator to the field definition in a way nothing else does.
2. Is there an appetite for generating a real GraphQL object type from the
   schema later? If yes, the property should be JSON Schema from the start
   rather than Zod, and the ergonomics get worse for the common case.
