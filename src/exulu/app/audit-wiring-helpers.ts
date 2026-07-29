import type { ExuluTool } from "@SRC/exulu/tool";

export const computeBuiltinToolIds = (builtins: {
  todoTools: ExuluTool[];
  questionTools: ExuluTool[];
  perplexityTools: ExuluTool[];
  emailTool: ExuluTool;
  imageGenerationTools: ExuluTool[];
}): Set<string> =>
  new Set(
    [
      ...builtins.todoTools,
      ...builtins.questionTools,
      ...builtins.perplexityTools,
      builtins.emailTool,
      ...builtins.imageGenerationTools,
    ]
      .filter(Boolean)
      .map((t) => t.id),
  );
