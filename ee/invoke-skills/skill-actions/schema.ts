import { parse } from "yaml";
import { z } from "zod";

export type ActionInput =
  | { type: "item"; context: string; fields?: string[]; description?: string }
  | {
      type: "items";
      context: string;
      fields?: string[];
      where?: Record<string, unknown>;
      description?: string;
    }
  | { type: "text"; required: boolean; description?: string };

export type SkillAction = {
  description: string;
  run: string;
  timeoutSeconds: number;
  inputs: Record<string, ActionInput>;
};

export const ACTIONS_FILE = "actions.yaml";
export const ACTIONS_MAX_BYTES = 64 * 1024;
export const ACTION_INPUT_TYPES = ["item", "items", "text"] as const;

export const MAX_ACTIONS = 20;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const nameMessage = "must match ^[a-z][a-z0-9_]{0,39}$";

const inputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("item"),
    context: z.string().min(1),
    fields: z.array(z.string()).optional(),
    description: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("items"),
    context: z.string().min(1),
    fields: z.array(z.string()).optional(),
    where: z.record(z.string(), z.unknown()).optional(),
    description: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("text"),
    required: z.boolean().default(true),
    description: z.string().optional(),
  }),
]);

const actionSchema = z
  .strictObject({
    description: z.string().min(1),
    run: z.string().min(1),
    timeout_seconds: z.number().int().min(1).max(300).default(60),
    inputs: z.record(z.string().regex(NAME, nameMessage), inputSchema).default({}),
  })
  .transform(({ timeout_seconds, ...rest }): SkillAction => ({
    description: rest.description,
    run: rest.run,
    timeoutSeconds: timeout_seconds,
    inputs: rest.inputs as Record<string, ActionInput>,
  }));

const fileSchema = z.strictObject({
  version: z.literal(1),
  actions: z
    .record(z.string().regex(NAME, nameMessage), actionSchema)
    .refine((a) => Object.keys(a).length <= MAX_ACTIONS, {
      message: `at most ${MAX_ACTIONS} actions per skill`,
    }),
});

export const parseActionsYaml = (
  text: string,
): { ok: true; actions: Record<string, SkillAction> } | { ok: false; error: string } => {
  try {
    if (Buffer.byteLength(text, "utf8") > ACTIONS_MAX_BYTES) {
      return { ok: false, error: `${ACTIONS_FILE} exceeds ${ACTIONS_MAX_BYTES} bytes` };
    }
    let raw: unknown;
    try {
      raw = parse(text);
    } catch (e: any) {
      return { ok: false, error: `invalid YAML: ${e?.message ?? String(e)}` };
    }
    const result = fileSchema.safeParse(raw);
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue?.path.length ? issue.path.join(".") : "(root)";
      return { ok: false, error: `${path}: ${issue?.message ?? "invalid"}` };
    }
    return { ok: true, actions: result.data.actions };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
};
