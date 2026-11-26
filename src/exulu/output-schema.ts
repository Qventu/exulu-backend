/**
 * Output schema for synchronous agent runs (design:
 * docs/superpowers/specs/2026-11-26-agent-output-schema-design.md).
 *
 * A caller passes a JSON Schema with the run; the agent answers as usual and
 * one further model call shapes that answer through a forced tool call whose
 * input schema IS the caller's schema.
 *
 * The schema is deliberately never converted to Zod. The March 2026 version
 * did (zod-from-json-schema), and the AI SDK converted the Zod schema back to
 * JSON Schema for the model: that round trip throws on anyOf / oneOf / $ref
 * and silently drops formats and map value types. Here the model gets the
 * schema unchanged (`jsonSchema()`), and Ajv validates against what the
 * caller actually wrote.
 */
import { generateText, jsonSchema, tool, type LanguageModel } from "ai";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

export const OUTPUT_SCHEMA_MAX_BYTES = 32 * 1024;
const SUBMIT_TOOL = "submit_output";
const MAX_ISSUES = 20;

export type OutputSchemaIssue = { path: string; message: string };
export type OutputSchemaUsage = { inputTokens: number; outputTokens: number };
export type ParsedOutputSchema = {
  /** The caller's schema, untouched. */
  jsonSchema: Record<string, unknown>;
  /** Empty when the value conforms. */
  validate: (value: unknown) => OutputSchemaIssue[];
};

/** The request's outputSchema cannot be used. HTTP 400. */
export class OutputSchemaInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputSchemaInvalidError";
  }
}

/** The model's output did not validate, also after the repair attempt. HTTP 422. */
export class OutputSchemaMismatchError extends Error {
  constructor(
    public issues: OutputSchemaIssue[],
    /** The agent's plain answer, so the caller is not left with nothing. */
    public text: string,
    public usage: OutputSchemaUsage,
  ) {
    super("The agent's output did not match the output schema.");
    this.name = "OutputSchemaMismatchError";
  }
}

const toIssues = (errors: ErrorObject[] | null | undefined): OutputSchemaIssue[] =>
  (errors ?? []).slice(0, MAX_ISSUES).map((e) => ({
    path: e.instancePath || "/",
    message: e.message ?? e.keyword,
  }));

export const parseOutputSchema = (raw: unknown): ParsedOutputSchema => {
  let schema = raw;
  if (typeof schema === "string") {
    try {
      schema = JSON.parse(schema);
    } catch {
      throw new OutputSchemaInvalidError("outputSchema is not valid JSON.");
    }
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new OutputSchemaInvalidError("outputSchema must be a JSON Schema object.");
  }
  const jsonSchemaObject = schema as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(jsonSchemaObject), "utf8") > OUTPUT_SCHEMA_MAX_BYTES) {
    throw new OutputSchemaInvalidError(`outputSchema is too large (limit ${OUTPUT_SCHEMA_MAX_BYTES / 1024} KB).`);
  }
  // The schema becomes a tool's input schema, and a tool input is an object.
  if (jsonSchemaObject.type !== "object") {
    throw new OutputSchemaInvalidError('outputSchema must have "type": "object" at its root.');
  }

  const draft07 = typeof jsonSchemaObject.$schema === "string" && jsonSchemaObject.$schema.includes("draft-07");
  const ajv = new (draft07 ? Ajv : Ajv2020)({ allErrors: true, strict: false });
  addFormats(ajv);
  let compiled: ValidateFunction;
  try {
    compiled = ajv.compile(jsonSchemaObject);
  } catch (e) {
    throw new OutputSchemaInvalidError(
      `outputSchema is not a usable JSON Schema: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
    );
  }
  return {
    jsonSchema: jsonSchemaObject,
    validate: (value) => (compiled(value) ? [] : toIssues(compiled.errors)),
  };
};

/**
 * Appended to the agent's instructions for a run with an output schema, so
 * the agent gathers and states what every field needs. Without it the answer
 * is written blind and the shaping call has nothing to fill some fields from.
 */
export const outputSchemaInstructions = (schema: ParsedOutputSchema): string =>
  `## Required content of your answer
After you answer, your answer is transferred into a JSON object with the structure below. Write your answer as usual, but make sure it states the information for every field of that structure. If you could not establish something, say so explicitly instead of guessing.

${JSON.stringify(schema.jsonSchema)}`;

const SHAPING_SYSTEM = `You transfer an answer that has already been given into a fixed structure by calling the ${SUBMIT_TOOL} tool.
- Use only what the answer and the question state. Do not add, estimate or correct anything.
- Where the answer has no information for something: leave an optional field or map entry out, or use null or an empty value if the structure allows it. Never fill a gap with an invented value such as 0 or "unknown" just to satisfy the structure.
- Keep the language of the answer for free-text fields.`;

/**
 * The second model call of a run with an output schema: one forced call of
 * `submit_output`, validated, with a single repair attempt.
 */
export const shapeOutput = async ({
  model,
  system,
  question,
  answer,
  schema,
}: {
  model: LanguageModel;
  /** The agent's instructions, so wording rules (glossary, language) also apply here. */
  system?: string;
  question?: string;
  answer: string;
  schema: ParsedOutputSchema;
}): Promise<{ output: unknown; usage: OutputSchemaUsage }> => {
  const usage: OutputSchemaUsage = { inputTokens: 0, outputTokens: 0 };
  const basePrompt = `${question ? `Question:\n${question}\n\n` : ""}Answer to transfer:\n${answer}`;

  const attempt = async (prompt: string): Promise<{ input: unknown; issues: OutputSchemaIssue[] }> => {
    const { toolCalls, totalUsage } = await generateText({
      temperature: 0,
      model,
      system: system ? `${system}\n\n---\n\n${SHAPING_SYSTEM}` : SHAPING_SYSTEM,
      prompt,
      tools: {
        [SUBMIT_TOOL]: tool({
          description: "Submit the answer in the required structure.",
          inputSchema: jsonSchema(schema.jsonSchema),
        }),
      },
      toolChoice: { type: "tool", toolName: SUBMIT_TOOL },
      maxRetries: 2,
    });
    usage.inputTokens += totalUsage?.inputTokens ?? 0;
    usage.outputTokens += totalUsage?.outputTokens ?? 0;
    const call = toolCalls.find((c) => c.toolName === SUBMIT_TOOL);
    if (!call || (call as { invalid?: boolean }).invalid) {
      return { input: undefined, issues: [{ path: "/", message: `the model did not make a usable ${SUBMIT_TOOL} call` }] };
    }
    return { input: call.input, issues: schema.validate(call.input) };
  };

  const first = await attempt(basePrompt);
  if (first.issues.length === 0) return { output: first.input, usage };

  const second = await attempt(
    `${basePrompt}\n\nYour previous submission was rejected because it does not match the structure:\n${first.issues
      .map((i) => `- ${i.path}: ${i.message}`)
      .join("\n")}\n\nPrevious submission:\n${JSON.stringify(first.input ?? null).slice(0, 8000)}\n\nSubmit again with these problems fixed. If a rejected value had no information behind it, leave that field or entry out instead of replacing it with a made-up value.`,
  );
  if (second.issues.length === 0) return { output: second.input, usage };

  throw new OutputSchemaMismatchError(second.issues, answer, usage);
};

/** The request's schema, an error body for HTTP 400, or neither when the request has no schema. */
export const readOutputSchema = (
  raw: unknown,
  stream: boolean,
): { schema?: ParsedOutputSchema; error?: { error: string; message: string } } => {
  if (raw === undefined || raw === null || raw === "") return {};
  if (stream) {
    return {
      error: {
        error: "output_schema_not_streamable",
        message: "outputSchema cannot be combined with streaming. Send the header stream: false.",
      },
    };
  }
  try {
    return { schema: parseOutputSchema(raw) };
  } catch (e) {
    if (e instanceof OutputSchemaInvalidError) return { error: { error: "output_schema_invalid", message: e.message } };
    throw e;
  }
};

/** Text of a request message, whether it is a UI message with parts or carries plain content. */
export const messageText = (message: unknown): string => {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const m = message as { parts?: unknown; content?: unknown };
  if (Array.isArray(m.parts)) {
    return m.parts
      .filter((p: { type?: unknown; text?: unknown } | null): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return typeof m.content === "string" ? m.content : "";
};

/**
 * Shapes the agent's answer and turns the outcome into the HTTP response of
 * the run route: 200 with the bare object, or 422 with the issues and the
 * plain answer. `onUsage` is called in both cases - the tokens were spent.
 */
export const respondWithOutputSchema = async ({
  onUsage,
  ...args
}: Parameters<typeof shapeOutput>[0] & {
  onUsage?: (usage: OutputSchemaUsage) => Promise<void>;
}): Promise<{ status: 200 | 422; body: unknown }> => {
  try {
    const { output, usage } = await shapeOutput(args);
    await onUsage?.(usage);
    return { status: 200, body: output };
  } catch (e) {
    if (!(e instanceof OutputSchemaMismatchError)) throw e;
    await onUsage?.(e.usage);
    return { status: 422, body: { error: "output_schema_mismatch", message: e.message, issues: e.issues, text: e.text } };
  }
};
