# Output schema for agent API calls — design

Date: 2026-11-26
Status: approved by Daniel 2026-11-26 ("Yes sounds good") with the four open questions decided as drafted; implemented on `feature/agent-output-schema`. Section "As built" records where the code differs from the draft.
Repos: `backend` (develop); docs in `backend/mintlify-docs`. No frontend change.
First consumer: cardioscan (their dashboard calls an agent and processes the answer in code).

## Intent and why

A system that calls an agent over the API needs the answer in a shape its code
can rely on. Today the synchronous run endpoint returns free text. A caller can
describe JSON in `customInstructions`, but nothing checks the result, so every
consumer has to build parsing, validation and retries themselves.

The platform had this once: `outputSchema` in the POST body, added on
2026-03-25 (`20791b6`, v1.51.0) and removed on 2026-05-24 (`5e956c8`, v1.59.0)
as "now-unused" when follow-up suggestions, its only internal user, moved to
their own route. External callers were not considered. This design brings it
back as a supported API feature rather than an internal convenience.

## Goals

- A caller passes a JSON Schema with a synchronous run and gets back JSON that
  validates against it, or a clear error. Never unvalidated JSON.
- Works with every model the platform can route to, not only those with
  OpenAI-style `response_format`.
- The agent still works as configured: its instructions, tools, knowledge
  search, skills and memory all apply before the answer is shaped.
- Calls without `outputSchema` behave exactly as today.

## Non-goals

- Streaming with a schema. Refused, as in the March version.
- Schemas stored on the agent (a default output format per agent). Possible
  later; this design is per request only.
- Structured output for agent-as-tool, channels (WhatsApp, e-mail) or the chat
  UI. Only the HTTP run route reads the parameter.

## Anti-goals

- Returning something that looks like the schema but was not validated.
- A schema that changes what the agent is allowed to do (tools, data access).

## Request and response

`POST <agent slug>/:agentId`, header `stream: false`, body:

```json
{
  "message": { "role": "user", "parts": [{ "type": "text", "text": "…" }] },
  "outputSchema": {
    "type": "object",
    "properties": {
      "summary": { "type": "string" },
      "recommendations": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": { "key": { "type": "string" }, "priority": { "type": "integer" } },
          "required": ["key", "priority"]
        }
      }
    },
    "required": ["summary", "recommendations"]
  }
}
```

`outputSchema` is a JSON Schema object, or the same as a JSON string (the
March version accepted both).

| Case | Status | Body |
|---|---|---|
| Output validates | 200 | the object itself, e.g. `{"summary": "…", "recommendations": […]}` |
| No `outputSchema` | 200 | the answer text, as today |
| `outputSchema` with `stream: true` | 400 | `{ "error": "output_schema_not_streamable", "message": … }` |
| Schema unusable (not valid JSON, root not `type: object`, over 32 KB, not a schema Ajv can compile) | 400 | `{ "error": "output_schema_invalid", "message": … }` |
| Model output does not validate after one repair attempt | 422 | `{ "error": "output_schema_mismatch", "issues": [...], "text": "<agent's answer>" }` |

The 422 carries the agent's plain answer so the caller is not left with
nothing, and the validation issues so they can see which field failed.

## Approaches

**A. Shape the answer in a second, forced tool call (recommended).** The agent
run happens exactly as today and produces its answer text. Then one more model
call gets the conversation of this turn and a single tool, `submit_output`,
whose input schema is the caller's schema, with `toolChoice` forcing that tool.
The tool input is validated; on failure the validation errors go back to the
model once.
- Works on every provider: tool calling is the universal way to get
  schema-shaped JSON, and for Anthropic it is the structured-output API.
  `suggestions.ts` already uses this technique for exactly that reason.
- The agent loop, its step budget and its guards (`contextGuard`,
  `retrievalGuard`, `finalAnswerGuard`) are untouched.
- Costs one extra model call per request (small: no tools to run, short
  output).

**B. `Output.object({ schema })` on the agent's own `generateText` call.**
This is what the March version did. One call, no extra cost. But it sends
`response_format: json_schema` through LiteLLM, which Anthropic models do not
support, and it sets the format on every step of a tool loop, where provider
behaviour differs. It also competes with `finalAnswerGuard`, which rewrites the
last step's instructions to ask for prose.

**C. Give the agent `submit_output` as one more tool and stop when it is
called.** One call, cross-provider. But nothing guarantees the model calls it;
when it answers in prose instead, a fallback like A is needed anyway.

A is chosen: it is the only one that is reliable across models without
changing how the agent itself runs. B's saving is one small call.

## Design

### Route (`src/exulu/routes.ts`, run handler)

1. Read `req.body.outputSchema`. If present and the `stream` header is set,
   answer 400 before any model work.
2. Parse and check it (`parseOutputSchema`, below). On failure answer 400.
3. Pass the parsed schema to `generateSync` as `outputSchema`.
4. `generateSync` returns either the text (no schema) or
   `{ output }` / throws `OutputSchemaMismatchError`. The route maps these to
   200 and 422. `describeRequestError` learns the new error class.

### `src/exulu/output-schema.ts` (new)

- `parseOutputSchema(raw: unknown): { jsonSchema: object; validate: (value: unknown) => Issue[] }`
  — accepts object or JSON string; requires root `type: "object"` (a tool
  input must be an object); refuses more than 32 KB serialised; compiles the
  schema with Ajv (draft 2020-12, or draft-07 when `$schema` says so; formats
  via `ajv-formats`; `strict: false`) and turns compile errors into
  `OutputSchemaInvalidError`. **The schema is never converted to Zod** - see
  "Why no Zod conversion" below.
- `shapeOutput({ model, system, turnMessages, schema }): Promise<{ output; usage }>`
  — the second call. System text: the agent's instructions plus a fixed
  paragraph: fill the tool from the answer already given, add nothing that is
  not in the conversation, use `null` or empty values where the answer has no
  information if the schema allows it. One `generateText` with
  `tools: { submit_output }`, `toolChoice: { type: "tool", toolName: "submit_output" }`,
  `temperature: 0`, no other tools. The tool's `inputSchema` is the AI SDK's
  `jsonSchema(callerSchema)`, which hands the caller's schema to the model
  unchanged. Validates the tool input with the compiled Ajv validator; on failure repeats once with the issues appended; then throws
  `OutputSchemaMismatchError` carrying issues and the answer text.

### `generateSync` (`src/exulu/generate-stream.ts`)

New optional parameter `outputSchema`. After the existing `generateText` of
either branch (prompt or messages) and before returning: if a schema is set,
call `shapeOutput` with that call's `response.messages`, add its token usage to
the totals reported through `statistics` and `onTokenUsage`, and return the
object. Statistics count one agent run, not two.

`agent-as-tool.ts` and `channels/agent-turn.ts` do not pass the parameter and
are unchanged.

### What stays as it is

- Tool approval, disabled tools and skills, model override, rate limits, RBAC:
  all decided before and during the agent run, none by the schema.
- Memory usage recording and claim check refer to the agent's answer text, not
  to the shaped object.
- What a session stores for a synchronous run: unchanged. The shaping call is
  not written to the session. (To confirm while planning: where exactly the
  sync path persists messages today.)

### Security and limits

- The schema is caller-supplied text that reaches the model as a tool
  definition. A caller can already append arbitrary `customInstructions`, so
  this grants nothing new. Property names and descriptions are not trusted for
  anything but shaping.
- 32 KB cap and the object-root rule bound prompt size and converter work.
- The shaping call has no tools except `submit_output`, so it cannot read data
  or act.

## Why no Zod conversion (spike, 2026-11-26)

The March version converted the caller's JSON Schema to Zod
(`zod-from-json-schema`), and the AI SDK then converted that Zod schema back to
JSON Schema for the model. Daniel remembered trouble with exactly this. A spike
with eleven schemas against `ai` 6.0.330, `zod` 4.3.6 and
`zod-from-json-schema` 0.5.2 reproduced it:

| Schema feature | Zod round trip |
|---|---|
| `anyOf`, `oneOf`, `$ref` with `$defs`, draft-07 `definitions` | **throws** "Custom types cannot be represented in JSON Schema" |
| `format: date / email` | format silently dropped |
| `additionalProperties: { type: number }` (a map) | value type silently dropped |
| `type: ["number", "null"]` | rewritten to `anyOf` (harmless) |
| any object without `additionalProperties` | `additionalProperties: {}` added (harmless) |

So the conversion fails for ordinary schemas and weakens others without
saying so. Passing the schema through `jsonSchema()` avoids the round trip
entirely, and Ajv validates against the schema the caller actually wrote.

The same ten object-rooted schemas were then run live through dev's LiteLLM
passthrough (the production path: `createOpenAICompatible` to LiteLLM to Azure
OpenAI) with the forced `submit_output` tool:

| Model | Valid on first attempt |
|---|---|
| `azure/gpt-4o` | 10 of 10 |
| `azure/gpt-4.1-mini` | 10 of 10 |
| `azure/gpt-5.5` | 10 of 10 |
| `azure/gpt-5.4-mini` | 9 of 10 (put a string into a number map) |

No request was rejected by the gateway or the provider for its schema. The one
invalid result is the case the validate-and-repair step exists for; the repair
attempt itself was not part of the spike.

**Not verified:** Anthropic and Gemini models. Dev has neither deployed. The
forced-tool approach is the one `suggestions.ts` already uses in production
with those providers, but only with a trivial schema.

New dependencies: `ajv` and `ajv-formats` (both already in `node_modules`
transitively; they become direct dependencies). `zod-from-json-schema` stays
for its other users.

## As built (2026-11-26)

Three things differ from the sections above:

1. **The shaping call runs in the route, not inside `generateSync`.**
   `generateSync` is unchanged; the run handler calls
   `respondWithOutputSchema` on the text it returns. That keeps agent-as-tool
   and the channels untouched by construction. The shaping call's tokens are
   added to the agent-run statistics from the route (`onUsage`), also when the
   result is a 422.
2. **The agent is told about the structure.** `outputSchemaInstructions`
   appends the schema to the agent's instructions for that run and asks it to
   state the information for every field. Without this the agent answers
   blind and the shaping call has nothing to fill some fields from.
3. **The shaping call gets the question and the answer text, not the turn's
   full message list.** Tool results can be large and are already digested in
   the answer; with point 2 the answer carries what the fields need.

One finding from the live run changed the prompts: with a number map and an
answer that says "no value for blood pressure", `gpt-5.4-mini` first put a
string into the map and, when told to repair it, once replaced it with `0` -
an invented value that validates. The shaping prompt and the repair message
now say to leave such a field or entry out rather than invent a value; after
that the same case repaired correctly six times out of six. A schema that
makes every field required and non-nullable still leaves the model no honest
way to express a gap, which is why the API documentation tells callers to make
fields nullable where a value can be missing.

Live results with the built code through dev's gateway: a realistic nested
German schema validated on the first attempt on `gpt-4o` and `gpt-5.4-mini`;
an unsatisfiable schema produced the 422 after exactly two model calls.

Still not verified: Anthropic and Gemini models, and the feature end to end
through a deployed backend (agent run with tools, then shaping).

## Tests

- `output-schema.test.ts`: object and string input; non-object root, oversize,
  invalid JSON and an uncompilable schema each give `OutputSchemaInvalidError`;
  the spike's ten schemas compile, and a known-bad value for each is reported
  as an issue (`anyOf`, `$ref`, formats and maps included).
- `shapeOutput` with a mock model: valid tool input returns the object; invalid
  then valid returns the object after one repair and sums usage; invalid twice
  throws with issues and text; the call forces the tool and offers no other.
- Route: 400 for stream + schema without calling the model; 400 for a bad
  schema; 200 with the bare object; 422 shape; unchanged text response without
  the parameter.
- One live check per provider family on a dev install (Azure OpenAI, Anthropic,
  Gemini) with a nested schema.

## Documentation

`mintlify-docs`: the agent API page gets an "Output schema" section with the
request above, the status table, and the note that one request costs one
additional model call.

## Open questions for Daniel

1. **Response body:** the bare object (as in v1.51–v1.58, simplest for
   callers) or an envelope such as `{ "output": {...}, "usage": {...} }`, which
   leaves room for metadata but differs from the old contract? The draft
   assumes the bare object.
2. **422 or 200 with an error field** when validation fails? The draft assumes
   422.
3. **Guests on the public surface:** allow `outputSchema` there, or only for
   signed-in users and API keys? The draft allows it wherever a synchronous run
   is allowed.
4. **Per-agent default schema** in the agent settings: wanted soon, or leave
   out as drafted?
