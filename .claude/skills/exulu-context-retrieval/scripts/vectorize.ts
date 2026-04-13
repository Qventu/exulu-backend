#!/usr/bin/env tsx
/**
 * Vectorize Query Script
 *
 * Converts a user query into a vector expression that can be used in PostgreSQL queries
 * for semantic search using pgvector.
 *
 * Usage:
 *   tsx vectorize.ts --query "your search query" --context "context_id"
 *
 * Output:
 *   ARRAY[0.123,0.456,0.789,...]::vector
 */

import { contexts } from "@EXULU_CONTEXTS";

const vectorizeQuery = async (user_query: string, context_id: string) => {
    const context = contexts[context_id];

    if (!context) {
        const availableContexts = Object.keys(contexts).join(", ");
        throw new Error(
            `Context '${context_id}' not found.\nAvailable contexts: ${availableContexts}`
        );
    }

    const embedder = context.embedder;
    if (!embedder) {
        throw new Error(
            `No embedder found for context '${context.id}'.\n` +
            `This context does not support vector/semantic search.`
        );
    }

    const result = await embedder.generateFromQuery(
        context.id,
        user_query,
        {
            label: context.name,
            trigger: "tool",
        }
    );

    if (!result?.chunks?.[0]?.vector) {
        throw new Error("No vector generated for query.");
    }

    const vector = result.chunks[0].vector;
    const vectorStr = `ARRAY[${vector.join(",")}]`;
    const vectorExpr = `${vectorStr}::vector`;

    return vectorExpr;
};

// Parse command-line arguments
const args = process.argv.slice(2);
const queryIndex = args.indexOf('--query');
const contextIndex = args.indexOf('--context');
const outputIndex = args.indexOf('--output');

if (queryIndex === -1 || contextIndex === -1) {
    console.error(`
Usage: tsx vectorize.ts --query "your search query" --context "context_id" [--output file]

Arguments:
  --query     The search query to vectorize (required)
  --context   The context ID (required)
  --output    Output file path (optional, defaults to stdout)

Example:
  tsx vectorize.ts --query "What is the capital of France?" --context "vorschriften"
  tsx vectorize.ts --query "test" --context "techDoc" --output /tmp/vector.txt

Available contexts:
  ${Object.keys(contexts).join('\n  ')}
`);
    process.exit(1);
}

const query = args[queryIndex + 1];
const contextId = args[contextIndex + 1];
const outputFile = outputIndex !== -1 ? args[outputIndex + 1] : null;

if (!query || !contextId) {
    console.error('Error: Both --query and --context must have values');
    process.exit(1);
}

// Execute vectorization
(async () => {
    try {
        const vectorExpr = await vectorizeQuery(query, contextId);

        if (outputFile) {
            // Write to file
            const fs = await import('fs/promises');
            await fs.writeFile(outputFile, vectorExpr, 'utf-8');
            console.error(`Vector expression written to: ${outputFile}`);
        } else {
            // Output to stdout (for piping/capturing)
            console.log(vectorExpr);
        }
    } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
    }
})();
