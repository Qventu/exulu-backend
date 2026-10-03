import { generateText, Output } from "ai";
import { z } from "zod";
import type { User } from "@EXULU_TYPES/models/user";
import { resolveModel } from "@SRC/exulu/resolve-model";

export type Verdict = "same" | "contradict" | "compatible";
export type Judgement = { verdict: Verdict; reason: string };
export type Judge = (a: string, b: string) => Promise<Judgement>;

const schema = z.object({
  verdict: z.enum(["same", "contradict", "compatible"]),
  reason: z.string().max(160),
});

const SYSTEM = `You compare two short memories an assistant saved from conversations.
Answer with JSON: verdict = "same" when both state the same fact or instruction (wording may differ),
"contradict" when they cannot both be true or give opposite instructions for the same situation,
"compatible" otherwise (different facts, or one is a special case of the other). reason: one sentence, ≤ 160 characters, in the memories' language.`;

/** The model of the first agent using the base, resolved like the entity extractor does. */
export async function makeModelJudge({ modelId, user }: { modelId: string; user?: User }): Promise<Judge> {
  const { languageModel } = await resolveModel({ modelId, user, rbacBypass: true });
  return async (a, b) => {
    const { output } = await generateText({
      temperature: 0,
      model: languageModel,
      system: SYSTEM,
      prompt: `Memory A:\n${a}\n\nMemory B:\n${b}`,
      maxRetries: 1,
      output: Output.object({ schema }),
    });
    return { verdict: output.verdict, reason: output.reason };
  };
}

/** Suggested wording for a merge (spec §4); same model, one call. */
export async function makeMergeSuggester({ modelId, user }: { modelId: string; user?: User }) {
  const { languageModel } = await resolveModel({ modelId, user, rbacBypass: true });
  return async (members: { information: string; type?: string | null }[]): Promise<{ information: string; type: string | null }> => {
    const { output } = await generateText({
      temperature: 0,
      model: languageModel,
      system: "You merge near-duplicate memories into one. Keep every fact, drop repetition, keep the memories' language and tone, ≤ 400 characters. Answer with JSON { information }.",
      prompt: members.map((m, i) => `Memory ${i + 1}:\n${m.information}`).join("\n\n"),
      maxRetries: 1,
      output: Output.object({ schema: z.object({ information: z.string().min(1).max(600) }) }),
    });
    const types = members.map((m) => m.type).filter((t): t is string => !!t);
    const type = types.length ? [...types].sort((x, y) => types.filter((t) => t === y).length - types.filter((t) => t === x).length)[0] ?? null : null;
    return { information: output.information.trim(), type };
  };
}
