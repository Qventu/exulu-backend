import type { ExuluContext } from "@SRC/exulu/context";
import type { User } from "@EXULU_TYPES/models/user";

/**
 * Finds embed('text') or embed('text', 'contextId') calls in a SQL string,
 * generates the embedding vectors using the appropriate context's embedder,
 * and substitutes them with ARRAY[...]::vector literals so db.raw() can execute it.
 *
 * Examples:
 *   embed('machine learning')         → uses first context that has an embedder
 *   embed('machine learning', 'ctx1') → uses the embedder from context 'ctx1'
 */
export async function preprocessEmbedCalls(
  sql: string,
  contexts: ExuluContext[],
  user?: User,
  role?: string,
): Promise<string> {
  // Match embed('...') or embed('...', 'contextId')
  // We use a global regex but process matches manually so we can await async calls
  const EMBED_RE = /embed\('((?:[^'\\]|\\.)*)'\s*(?:,\s*'((?:[^'\\]|\\.)*)')?\)/gi;

  const matches: { fullMatch: string; text: string; contextId?: string; index: number }[] = [];

  let m: RegExpExecArray | null;
  while ((m = EMBED_RE.exec(sql)) !== null) {
    matches.push({
      fullMatch: m[0],
      text: m[1],
      contextId: m[2] || undefined,
      index: m.index,
    });
  }

  if (matches.length === 0) return sql;

  // Generate all embeddings in parallel
  const substitutions = await Promise.all(
    matches.map(async ({ text, contextId }) => {
      const context = contextId
        ? contexts.find((c) => c.id === contextId)
        : contexts.find((c) => c.embedder != null);

      if (!context?.embedder) {
        throw new Error(
          `No embedder available${contextId ? ` for context "${contextId}"` : ""}. ` +
            `Available contexts with embedders: [${contexts.filter((c) => c.embedder).map((c) => c.id).join(", ")}]`,
        );
      }

      const result = await context.embedder.generateFromQuery(
        context.id,
        text,
        undefined,
        (user as any)?.id,
        role,
      );

      const vector = result?.chunks?.[0]?.vector;
      if (!vector?.length) {
        throw new Error(`Embedder returned no vector for text: "${text}"`);
      }

      return `ARRAY[${vector.join(",")}]::vector`;
    }),
  );

  // Replace in reverse order so indices stay valid
  let result = sql;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, index } = matches[i];
    result = result.slice(0, index) + substitutions[i] + result.slice(index + fullMatch.length);
  }

  return result;
}
