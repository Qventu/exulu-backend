import { preprocessQuery } from "src/templates/tools/agentic-retrieval/query-preprocessing";
import { applySorting } from "./apply-sorting";
import type { SearchFilters } from "../types";
import { applyAccessControl } from "../utilities/access-control";
import { applyFilters } from "./apply-filters";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics";
import {
  ExuluContext,
  getChunksTableName,
  getTableName,
  updateStatistic,
  type STATISTICS_LABELS,
} from "src/exulu/classes";
import { VectorMethodEnum, type VectorMethod } from "@EXULU_TYPES/models/vector-methods";
import { Knex as KnexType } from "knex";
import { convertContextToTableDefinition } from "../utilities/convert-context-to-table-definition";
import type { User } from "@EXULU_TYPES/models/user";

export type VectorSearchChunkResult = {
  chunk_content: string;
  chunk_index: number;
  chunk_id: string;
  chunk_source: string;
  chunk_metadata: Record<string, string>;
  chunk_created_at: string;
  chunk_updated_at: string;
  item_id: string;
  item_external_id: string;
  item_name: string;
  item_updated_at: string;
  item_created_at: string;
  chunk_cosine_distance?: number;
  chunk_fts_rank?: number;
  chunk_hybrid_score?: number;
  context?: {
    name: string;
    id: string;
  };
};

export const vectorSearch = async ({
  limit,
  page,
  itemFilters,
  chunkFilters,
  sort,
  context,
  db,
  query,
  keywords,
  method,
  user,
  role,
  trigger,
  cutoffs,
  expand,
}: {
  limit: number;
  page: number;
  itemFilters: SearchFilters;
  chunkFilters: SearchFilters;
  sort: any;
  context: ExuluContext;
  db: KnexType;
  query?: string;
  keywords?: string[];
  method: VectorMethod;
  user?: User;
  role?: string;
  trigger: STATISTICS_LABELS;
  expand?: {
    before?: number;
    after?: number;
  };
  cutoffs?: {
    cosineDistance?: number;
    tsvector?: number;
    hybrid?: number;
  };
}): Promise<{
  itemFilters: SearchFilters;
  chunkFilters: SearchFilters;
  query?: string;
  keywords?: string[];
  method: VectorMethod;
  context: {
    name: string;
    id: string;
    embedder: string;
  };
  chunks: VectorSearchChunkResult[];
}> => {
  const table = convertContextToTableDefinition(context);

  console.log("[EXULU] Called vector search.", {
    limit,
    page,
    itemFilters,
    chunkFilters,
    sort,
    context: context.id,
    query,
    method,
    user,
    role,
    cutoffs,
    expand,
  });

  if (limit > 250) {
    throw new Error("Limit cannot be greater than 1000.");
  }

  if (!query && !keywords) {
    throw new Error("Query is required.");
  }

  if (!method) {
    throw new Error("Method is required.");
  }

  if (!Object.values(VectorMethodEnum).includes(method)) {
    throw new Error(
      "Invalid method, must be one of: " + Object.values(VectorMethodEnum).join(", "),
    );
  }

  const { id, queryRewriter, embedder, configuration, resultReranker } = context;

  if (!embedder) {
    throw new Error("Embedder is not set for this context.");
  }

  const mainTable = getTableName(id);
  const chunksTable = getChunksTableName(id);

  cutoffs = {
    cosineDistance: cutoffs?.cosineDistance || context.configuration?.cutoffs?.cosineDistance || 0,
    tsvector: cutoffs?.tsvector || context.configuration?.cutoffs?.tsvector || 0,
    hybrid: cutoffs?.hybrid
      ? (cutoffs?.hybrid ?? 0) / 100
      : context.configuration?.cutoffs
        ? (context.configuration?.cutoffs?.hybrid ?? 0) / 100
        : 0,
  };

  expand = {
    before: expand?.before || context.configuration?.expand?.before || 0,
    after: expand?.after || context.configuration?.expand?.after || 0,
  };

  // Create separate data query
  // const columns = await db(chunksTable).columnInfo();

  let chunksQuery = db(chunksTable + " as chunks").select([
    "chunks.id as chunk_id",
    "chunks.source",
    "chunks.content",
    "chunks.chunk_index",
    db.raw('chunks."createdAt" as chunk_created_at'),
    db.raw('chunks."updatedAt" as chunk_updated_at'),
    "chunks.metadata",
    "items.id as item_id",
    "items.name as item_name",
    "items.external_id as item_external_id",
    db.raw('items."updatedAt" as item_updated_at'),
    db.raw('items."createdAt" as item_created_at'),
  ]);

  chunksQuery.leftJoin(mainTable + " as items", function () {
    this.on("chunks.source", "=", "items.id");
  });

  // Important: apply access control on and filters
  // on the main items table as the required
  // fields such as rights_mode, name, description, etc. are
  // on the main table.
  chunksQuery = applyFilters(chunksQuery, itemFilters, table, "items");
  chunksQuery = applyFilters(chunksQuery, chunkFilters, table, "chunks");
  chunksQuery = applyAccessControl(table, chunksQuery, user, "items");
  chunksQuery = applySorting(chunksQuery, sort, "items");

  if (queryRewriter && query) {
    query = await queryRewriter(query);
  }

  let vector: number[] = [];
  let vectorStr: string = "";
  let vectorExpr: string = "";

  if (query) {
    // Preprocess query with language detection and stemming
    const { processed: stemmedQuery } = preprocessQuery(query, {
      enableStemming: true,
      detectLanguage: true,
    });

    console.log("[EXULU] Stemmed query:", stemmedQuery);

    if (stemmedQuery) {
      query = stemmedQuery;
    }

    const result = await embedder.generateFromQuery(
      context.id,
      query,
      {
        label: table.name.singular,
        trigger,
      },
      user?.id,
      role,
    );

    if (!result?.chunks?.[0]?.vector) {
      throw new Error("No vector generated for query.");
    }
    vector = result.chunks[0].vector;
    vectorStr = `ARRAY[${vector.join(",")}]`;
    vectorExpr = `${vectorStr}::vector`; // => ARRAY[0.1,0.2,0.3]::vector
  }

  let keywordsQuery: string[] = [];

  if (keywords) {
    console.log("[EXULU] Using keywords:", keywords);
    let tokens = keywords?.map((keyword) => keyword.trim()).filter((token) => token.length > 0);

    // Take each token, and create a version with, and without special characters
    const sanitized = tokens
      ?.map((token) => {
        return token.replace(/[^a-zA-Z0-9]/g, "");
      })
      .filter((token) => token.length > 0);

    keywordsQuery = [...new Set([...sanitized!, ...tokens!])];
  } else if (query) {
    console.log("[EXULU] Extracting keywords from query:", query);
    // Use the query and extract the keywords using good
    // old fashioned code.
    // Split query into tokens and create OR query for partial matching
    // This handles technical terms like "CBM-2", "0x02", "ABC-Fehler" better
    // by matching ANY term instead of requiring ALL terms
    const tokens = query
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    console.log("[EXULU] Query tokens:", tokens);

    // Sanitize tokens: extract alphanumeric words from each token
    keywordsQuery = Array.from(
      new Set(
        tokens.flatMap((t) => {
          // Split on non-alphanumeric, but keep the parts
          return t.split(/[^\w]+/).filter((part) => part.length > 0);
        }),
      ),
    );
  }

  const language = configuration.language || "english";

  console.log("[EXULU] Vector search params:", { method, query, cutoffs });

  let resultChunks: any[] = [];

  switch (method) {
    case "tsvector":
      // For semantic search we increase the scope, so we
      // can rerank the results.
      chunksQuery.limit(limit * 2);

      const orQuery = keywordsQuery.join(" | ");

      console.log("[EXULU] FTS query transformation:", {
        original: query,
        keywordsQuery,
        orQuery,
        cutoff: cutoffs?.tsvector,
      });

      // rank + filter + sort (DESC)
      // Use to_tsquery with OR logic for more lenient matching
      // Remove the cutoff threshold check since OR queries typically have lower ranks
      chunksQuery
        .select(db.raw(`ts_rank(chunks.fts, to_tsquery(?, ?)) as fts_rank`, [language, orQuery]))
        .whereRaw(
          `(chunks.fts @@ to_tsquery(?, ?)) AND (items.archived IS FALSE OR items.archived IS NULL)`,
          [language, orQuery],
        )
        .orderByRaw(`fts_rank DESC`);

      console.log("[EXULU] FTS query SQL:", chunksQuery.toQuery());

      resultChunks = await chunksQuery;
      break;

    case "cosineDistance":
      // For semantic search we increase the scope, so we
      // can rerank the results.
      chunksQuery.limit(limit * 2);
      // Ensure we don't rank rows without embeddings
      chunksQuery
        .whereNotNull(`chunks.embedding`)
        .whereRaw(`(items.archived IS FALSE OR items.archived IS NULL)`);

      console.log("[EXULU] Chunks query:", chunksQuery.toQuery());

      // Select cosine *similarity* for display/stats:
      // similarity = 1 - cosine_distance  (cosine_distance in [0,2])
      // If you prefer pure distance in your stats, change the alias below accordingly.
      chunksQuery.select(db.raw(`1 - (chunks.embedding <=> ${vectorExpr}) AS cosine_distance`));

      // Very important: ORDER BY the raw distance expression so pgvector can use the index
      chunksQuery.orderByRaw(`chunks.embedding <=> ${vectorExpr} ASC NULLS LAST`);

      chunksQuery.whereRaw(`(1 - (chunks.embedding <=> ${vectorExpr}) >= ?)`, [
        cutoffs?.cosineDistance || 0,
      ]);

      resultChunks = await chunksQuery;
      break;
    case "hybridSearch":
      // Tunables
      const matchCount = Math.min(limit * 2);
      const fullTextWeight = 2.0;
      const semanticWeight = 1.0;
      const rrfK = 50;

      // Build the full_text CTE subquery
      let fullTextQuery = db(chunksTable + " as chunks")
        .select([
          "chunks.id",
          "chunks.source",
          db.raw(
            `row_number() OVER (ORDER BY ts_rank(chunks.fts, plainto_tsquery(?, ?)) DESC) AS rank_ix`,
            [language, query],
          ),
        ])
        .leftJoin(mainTable + " as items", "items.id", "chunks.source")
        .whereRaw(`chunks.fts @@ plainto_tsquery(?, ?)`, [language, query])
        .whereRaw(`ts_rank(chunks.fts, plainto_tsquery(?, ?)) > ?`, [
          language,
          query,
          cutoffs?.tsvector || 0,
        ])
        .whereRaw(`(items.archived IS FALSE OR items.archived IS NULL)`)
        .limit(Math.min(matchCount * 2, 500));

      // Apply filters and access control to full_text CTE
      fullTextQuery = applyFilters(fullTextQuery, itemFilters, table, "items");
      fullTextQuery = applyFilters(fullTextQuery, chunkFilters, table, "chunks");
      fullTextQuery = applyAccessControl(table, fullTextQuery, user, "items");

      // Build the semantic CTE subquery
      let semanticQuery = db(chunksTable + " as chunks")
        .select([
          "chunks.id",
          "chunks.source",
          db.raw(`row_number() OVER (ORDER BY chunks.embedding <=> ${vectorExpr} ASC) AS rank_ix`),
        ])
        .leftJoin(mainTable + " as items", "items.id", "chunks.source")
        .whereNotNull("chunks.embedding")
        .whereRaw(`(1 - (chunks.embedding <=> ${vectorExpr})) >= ?`, [cutoffs?.cosineDistance || 0])
        .whereRaw(`(items.archived IS FALSE OR items.archived IS NULL)`)
        .limit(Math.min(matchCount * 2, 500));

      // Apply filters and access control to semantic CTE
      semanticQuery = applyFilters(semanticQuery, itemFilters, table, "items");
      semanticQuery = applyFilters(semanticQuery, chunkFilters, table, "chunks");
      semanticQuery = applyAccessControl(table, semanticQuery, user, "items");

      // Build the main query with CTEs
      let hybridQuery = db
        .with("full_text", fullTextQuery)
        .with("semantic", semanticQuery)
        .select([
          "items.id as item_id",
          "items.name as item_name",
          "items.external_id as item_external_id",
          "chunks.id as chunk_id",
          "chunks.source",
          "chunks.content",
          "chunks.chunk_index",
          "chunks.metadata",
          db.raw('chunks."createdAt" as chunk_created_at'),
          db.raw('chunks."updatedAt" as chunk_updated_at'),
          db.raw('items."updatedAt" as item_updated_at'),
          db.raw('items."createdAt" as item_created_at'),
          db.raw(`ts_rank(chunks.fts, plainto_tsquery(?, ?)) AS fts_rank`, [language, query]),
          db.raw(`(1 - (chunks.embedding <=> ${vectorExpr})) AS cosine_distance`),
          db.raw(
            `
                          (
                              COALESCE(1.0 / (? + ft.rank_ix), 0.0) * ?
                              +
                              COALESCE(1.0 / (? + se.rank_ix), 0.0) * ?
                          )::float AS hybrid_score
                      `,
            [rrfK, fullTextWeight, rrfK, semanticWeight],
          ),
        ])
        .from("full_text as ft")
        .fullOuterJoin("semantic as se", "ft.id", "se.id")
        .join(chunksTable + " as chunks", function () {
          // @ts-ignore - Knex doesn't properly type raw expressions in join conditions
          this.on(db.raw("COALESCE(ft.id, se.id)"), "=", "chunks.id");
        })
        .join(mainTable + " as items", "items.id", "chunks.source")
        .whereRaw(
          `
                      (
                          COALESCE(1.0 / (? + ft.rank_ix), 0.0) * ?
                          +
                          COALESCE(1.0 / (? + se.rank_ix), 0.0) * ?
                      ) >= ?
                  `,
          [rrfK, fullTextWeight, rrfK, semanticWeight, cutoffs?.hybrid || 0],
        )
        .whereRaw(`(chunks.fts IS NULL OR ts_rank(chunks.fts, plainto_tsquery(?, ?)) > ?)`, [
          language,
          query,
          cutoffs?.tsvector || 0,
        ])
        .whereRaw(`(chunks.embedding IS NULL OR (1 - (chunks.embedding <=> ${vectorExpr})) >= ?)`, [
          cutoffs?.cosineDistance || 0,
        ])
        .orderByRaw("hybrid_score DESC")
        .limit(Math.min(matchCount, 250));

      // Note: Hybrid search uses its own relevance-based ordering (hybrid_score)
      // We don't apply additional sorting here as it would override the relevance ranking
      // and the "items" table reference is not available in the outer query context with CTEs

      resultChunks = await hybridQuery;
  }

  // Filter out duplicate sources, keeping only the first occurrence
  // because the vector search returns multiple chunks for the same
  // source.
  console.log("[EXULU] Vector search chunk results:", resultChunks?.length);

  let results: VectorSearchChunkResult[] = resultChunks.map((chunk) => ({
    chunk_content: chunk.content,
    chunk_index: chunk.chunk_index,
    chunk_id: chunk.chunk_id,
    chunk_source: chunk.source,
    chunk_metadata: chunk.metadata,
    chunk_created_at: chunk.chunk_created_at,
    chunk_updated_at: chunk.chunk_updated_at,
    item_updated_at: chunk.item_updated_at,
    item_created_at: chunk.item_created_at,
    item_id: chunk.item_id,
    item_external_id: chunk.item_external_id,
    item_name: chunk.item_name,
    context: {
      name: table.name.singular,
      id: table.id || "",
    },
    ...((method === "cosineDistance" || method === "hybridSearch") && {
      chunk_cosine_distance: chunk.cosine_distance,
    }),
    ...((method === "tsvector" || method === "hybridSearch") && {
      chunk_fts_rank: chunk.fts_rank,
    }),
    ...(method === "hybridSearch" && {
      chunk_hybrid_score: (chunk.hybrid_score * 10000) / 100,
    }),
  }));

  // Apply adaptive threshold filtering to remove irrelevant results
  if (results.length > 0 && (method === "cosineDistance" || method === "hybridSearch")) {
    const scoreKey = method === "cosineDistance" ? "chunk_cosine_distance" : "chunk_hybrid_score";
    const topScore = results[0]?.[scoreKey];
    const bottomScore = results[results.length - 1]?.[scoreKey];
    const medianScore = results[Math.floor(results.length / 2)]?.[scoreKey];

    console.log("[EXULU] Score distribution:", {
      method,
      count: results.length,
      topScore: topScore?.toFixed(4),
      bottomScore: bottomScore?.toFixed(4),
      medianScore: medianScore?.toFixed(4),
    });

    // Adaptive threshold: keep results within 60% of the best match
    const adaptiveThreshold = topScore ? topScore * 0.6 : 0;
    const beforeFilterCount = results.length;

    results = results.filter((chunk) => {
      const score = chunk[scoreKey];
      return score !== undefined && score >= adaptiveThreshold;
    });

    const filteredCount = beforeFilterCount - results.length;
    if (filteredCount > 0) {
      console.log(
        `[EXULU] Filtered ${filteredCount} low-quality results (threshold: ${adaptiveThreshold.toFixed(4)})`,
      );
    }
  }

  // todo if query && resultReranker, rerank the results
  if (resultReranker && query) {
    // results = await resultReranker(results);
  }

  results = results.slice(0, limit);

  // Added config option to Exulu retrieval “expand” which allows the result to include X
  // chunks before and after the retrieved relevant chunks to “expand them”, for example
  // if a chunk with index 2 is retrieved, it and expand : { before: 1, after: 1} is set,
  // it fetches the chunks with index 1 and 3, and adds them to the result set

  if (expand?.before || expand?.after) {
    const expandedMap = new Map<string, VectorSearchChunkResult>();

    // First, add all original results to the map
    for (const chunk of results) {
      expandedMap.set(`${chunk.item_id}-${chunk.chunk_index}`, chunk);
    }

    if (expand?.before) {
      for (const chunk of results) {
        // Create an array of indices to fetch: [chunk_index -
        // expand.before, ..., chunk_index - 1]
        const indicesToFetch = Array.from(
          { length: expand.before },
          (_, i) => chunk.chunk_index - expand.before! + i,
        ).filter((index) => index >= 0); // Only fetch non-negative indices

        console.log("[EXULU] Indices to fetch:", indicesToFetch);

        await Promise.all(
          indicesToFetch.map(async (index) => {
            if (expandedMap.has(`${chunk.item_id}-${index}`)) {
              return;
            }
            const expandedChunk = await db(chunksTable)
              .where({
                source: chunk.item_id,
                chunk_index: index,
              })
              .first();
            if (expandedChunk) {
              if (expandedChunk) {
                expandedMap.set(`${chunk.item_id}-${index}`, {
                  chunk_content: expandedChunk.content,
                  chunk_index: expandedChunk.chunk_index,
                  chunk_id: expandedChunk.id,
                  chunk_source: expandedChunk.source,
                  chunk_metadata: expandedChunk.metadata,
                  chunk_created_at: expandedChunk.createdAt,
                  chunk_updated_at: expandedChunk.updatedAt,
                  item_updated_at: chunk.item_updated_at,
                  item_created_at: chunk.item_created_at,
                  item_id: chunk.item_id,
                  item_external_id: chunk.item_external_id,
                  item_name: chunk.item_name,
                  chunk_cosine_distance: 0,
                  chunk_fts_rank: 0,
                  chunk_hybrid_score: 0,
                  context: {
                    name: table.name.singular,
                    id: table.id || "",
                  },
                });
              }
            }
          }),
        );
      }
    }
    if (expand?.after) {
      for (const chunk of results) {
        // Create an array of indices to fetch: [chunk_index + 1,
        // ..., chunk_index + expand.after]
        const indicesToFetch = Array.from(
          { length: expand.after },
          (_, i) => chunk.chunk_index + i + 1,
        );

        console.log("[EXULU] Indices to fetch:", indicesToFetch);

        await Promise.all(
          indicesToFetch.map(async (index) => {
            if (expandedMap.has(`${chunk.item_id}-${index}`)) {
              return;
            }
            const expandedChunk = await db(chunksTable)
              .where({
                source: chunk.item_id,
                chunk_index: index,
              })
              .first();
            if (expandedChunk) {
              expandedMap.set(`${chunk.item_id}-${index}`, {
                chunk_content: expandedChunk.content,
                chunk_index: expandedChunk.chunk_index,
                chunk_id: expandedChunk.id,
                chunk_source: expandedChunk.source,
                chunk_metadata: expandedChunk.metadata,
                chunk_created_at: expandedChunk.createdAt,
                chunk_updated_at: expandedChunk.updatedAt,
                item_updated_at: chunk.item_updated_at,
                item_created_at: chunk.item_created_at,
                item_id: chunk.item_id,
                item_external_id: chunk.item_external_id,
                item_name: chunk.item_name,
                chunk_cosine_distance: 0,
                chunk_fts_rank: 0,
                chunk_hybrid_score: 0,
                context: {
                  name: table.name.singular,
                  id: table.id || "",
                },
              });
            }
          }),
        );
      }
    }

    // Convert map values back to array
    results = Array.from(expandedMap.values());

    // Sort by item_id first, then by chunk_index within each item
    results = results.sort((a, b) => {
      if (a.item_id !== b.item_id) {
        return a.item_id.localeCompare(b.item_id);
      }
      // Ensure chunk_index is treated as a number for proper sorting
      const aIndex = Number(a.chunk_index);
      const bIndex = Number(b.chunk_index);
      return aIndex - bIndex;
    });
  }

  await updateStatistic({
    name: "count",
    label: table.name.singular,
    type: STATISTICS_TYPE_ENUM.CONTEXT_RETRIEVE as STATISTICS_TYPE,
    trigger,
    user: user?.id,
    role: role,
  });

  return {
    itemFilters,
    chunkFilters,
    query,
    keywords,
    method,
    context: {
      name: table.name.singular,
      id: table.id || "",
      embedder: embedder.name,
    },
    chunks: results,
  };
};
