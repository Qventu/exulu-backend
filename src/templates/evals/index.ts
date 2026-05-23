import { queues as ExuluQueues } from "@EE/queues/queues";
import { ExuluEval } from "@SRC/exulu/evals";
import { resolveModel } from "@SRC/exulu/resolve-model";
import { exuluApp } from "@SRC/exulu/app/singleton";
import { z } from "zod";

const llmAsJudgeEval = () => {
  if (process.env.REDIS_HOST?.length && process.env.REDIS_PORT?.length) {
    return new ExuluEval({
      id: "llm_as_judge",
      name: "LLM as Judge",
      description: "Evaluate the output of the LLM as a judge.",
      execute: async ({ agent, provider, messages, testCase, config }) => {
        console.log("[EXULU] running llm as judge eval", {
          agent,
          provider,
          messages,
          testCase,
          config,
        });
        let prompt = config?.prompt;

        if (!prompt) {
          console.error("[EXULU] prompt is required for llm as judge eval but none is provided.");
          throw new Error("Prompt is required for llm as judge eval but none is provided.");
        }

        console.log("[EXULU] messages", messages);

        const lastTypes = messages[messages.length - 1]?.parts?.map((part) => ({
          type: part.type,
          text: part.type === "text" ? part.text?.slice(0, 100) : undefined,
        }));

        const lastMessage = messages[messages.length - 1]?.parts
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");

        console.log("[EXULU] last message", lastMessage);
        console.log("[EXULU] last types", lastTypes);

        if (!lastMessage) {
          return 0;
        }

        // replace {output} with the last message content
        prompt = prompt.replace("{actual_output}", lastMessage);

        // replace {expected} with the expected output
        prompt = prompt.replace("{expected_output}", testCase.expected_output);

        if (!agent.model) {
          throw new Error(
            `Agent ${agent.name} has no model configured (required for llm-as-judge eval).`,
          );
        }

        const resolved = await resolveModel({
          modelId: agent.model,
          providers: exuluApp.get().providers,
          agent: { id: agent.id },
          rbacBypass: true,
        });
        const providerapikey = resolved.apiKey;

        console.log("[EXULU] prompt", prompt);

        const response = await provider.generateSync({
          agent: agent,
          contexts: [],
          rerankers: [],
          prompt,
          outputSchema: z.object({
            score: z.number().min(0).max(100).describe("The score between 0 and 100."),
          }),
          languageModel: resolved.languageModel,
          providerapikey,
        });

        console.log("[EXULU] response", response);

        const score = parseFloat(response.score);

        if (isNaN(score)) {
          throw new Error(
            `Generated score from llm as a judge eval is not a number: ${response.score}`,
          );
        }

        return score;
      },
      config: [
        {
          name: "prompt",
          description:
            "The prompt to send to the LLM as a judge, make sure to instruct the LLM to output a numerical score between 0 and 100. Add {actual_output} to the prompt to replace with the last message content, and {expected_output} to replace with the expected output.",
        },
      ],
      queue: ExuluQueues.register(
        "llm_as_judge",
        {
          worker: 1,
          queue: 1,
        },
        1,
      ).use(),
      llm: true,
    });
  }
  return undefined;
};

export const getDefaultEvals = () => {
  if (process.env.REDIS_HOST?.length && process.env.REDIS_PORT?.length) {
    return [llmAsJudgeEval() ?? undefined].filter((x) => x !== undefined);
  }
  console.error(
    "[EXULU] no redis server configured, skipping default evals as they require redis queues.",
  );
  return [];
};
