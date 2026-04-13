# Agentic Retrieval Agent - Functionality Analysis & Improvement Strategy

**Date:** 2026-04-09
**Current File:** `/Users/daniel.claessen/Desktop/Projects/exulu/backend/ee/agentic-retrieval/index.ts`

---

## Executive Summary

The current agentic retrieval agent is **good** but lacks the **flexibility and strategic depth** demonstrated by the ExuluContext retrieval skill. The skill can execute raw SQL queries with full control over search strategy, aggregations, counts, and filtering, while the current agent is constrained to predefined tool patterns.

**Key Gap:** The agent cannot dynamically craft custom SQL queries or COUNT/aggregation queries - it's limited to the fixed `search_content` and `search_items_by_name` tools.

---

## Current Capabilities

### ✅ What the Agent Does Well

1. **Multi-step reasoning** - Plans and executes retrieval in multiple steps
2. **Two-phase pattern** - Can search items first, then search within specific items
3. **includeContent optimization** - Knows when to exclude content for efficiency
4. **Search method selection** - Supports hybrid, keyword, and semantic search via `ctx.search()`
5. **Dynamic tool generation** - Creates `get_more_content` and `get_content` tools on the fly
6. **Multi-context search** - Can search across multiple contexts simultaneously
7. **Filtering capabilities** - Can filter by item_ids, item_names, item_external_ids
8. **Reranking support** - Can rerank results with ExuluReranker

### ❌ What the Agent CANNOT Do

Comparing to the ExuluContext retrieval skill capabilities:

1. **No COUNT/Aggregation queries**
   - Skill: "How many documents mention FST?" → `SELECT COUNT(DISTINCT source)...`
   - Agent: Can only return chunks, cannot provide counts or statistics

2. **No custom SQL flexibility**
   - Skill: Can craft any SQL query (GROUP BY, AVG, SUM, complex JOINs)
   - Agent: Limited to `ctx.search()` method only

3. **No direct table exploration**
   - Skill: Can query item table directly, get column info, sample data
   - Agent: Must use `search_items_by_name` which is name-based only

4. **No chunk expansion with SQL control**
   - Skill: Can get surrounding chunks with precise BETWEEN queries
   - Agent: Has `get_more_content` but less flexible

5. **No field-specific filtering**
   - Skill: Can filter by ANY custom field (tags, metadata, JSONB fields, dates)
   - Agent: Limited to name, id, external_id filtering

6. **No keyword-only FTS queries**
   - Skill: Can use pure `ts_rank()` queries with complex tsquery syntax (AND, OR, NOT)
   - Agent: Uses `ctx.search()` which always involves the full search stack

7. **No RRF score visibility**
   - Skill: Can see and control RRF weights (keyword_weight: 2.0, semantic_weight: 1.0)
   - Agent: Uses `ctx.search()` with fixed RRF implementation

8. **No multi-language FTS control**
   - Skill: Can use `GREATEST(ts_rank(...'german'...), ts_rank(...'english'...))`
   - Agent: Relies on context configuration

9. **No learning/strategy persistence**
   - Skill: Has STRATEGY.md that learns from searches
   - Agent: No memory of what works/doesn't work

10. **No exact field queries**
    - Skill: Can query `WHERE tags LIKE '%important%'` or `WHERE "createdAt" > NOW() - INTERVAL '7 days'`
    - Agent: Cannot filter by tags, dates, or custom fields

11. **No iterative temp file workflow**
    - Skill: Can save query results to temp file, then grep iteratively without loading all content into LLM context
    - Agent: All results loaded into tool output immediately, consuming tokens
    - **Impact**: Skill can retrieve 100 chunks, save to `/tmp/results.txt`, then grep for specific patterns, only loading relevant portions into context
    - **Agent limitation**: Must either load all content (expensive) or use `includeContent: false` and make additional tool calls

---

## Comparison Table

| Capability | Retrieval Skill | Current Agent | Gap Severity |
|------------|----------------|---------------|--------------|
| **Basic Search** | ✅ Full control | ✅ Via ctx.search() | Low |
| **Hybrid/Semantic/Keyword** | ✅ Full SQL control | ✅ Via method param | Low |
| **COUNT queries** | ✅ `COUNT(*)`, `COUNT(DISTINCT)` | ❌ Cannot count | **HIGH** |
| **Aggregations** | ✅ `SUM`, `AVG`, `GROUP BY` | ❌ Cannot aggregate | **HIGH** |
| **Field filtering** | ✅ ANY field (tags, dates, JSONB) | ❌ Only name/id/external_id | **MEDIUM** |
| **Direct table queries** | ✅ Can query items table directly | ❌ Must use search | **MEDIUM** |
| **Custom SQL** | ✅ Any SQL query | ❌ Fixed to ctx.search() | **HIGH** |
| **RRF control** | ✅ Can adjust weights | ❌ Fixed implementation | Low |
| **Learning** | ✅ STRATEGY.md | ❌ No persistence | **MEDIUM** |
| **Multi-step reasoning** | ✅ Manual steps | ✅ Automatic | Equal |
| **Context expansion** | ✅ Precise SQL BETWEEN | ✅ get_more_content tool | Equal |
| **Multi-context** | ✅ Manual UNION | ✅ Automatic | Equal |
| **includeContent opt** | N/A | ✅ Smart optimization | Agent better |
| **Iterative filtering** | ✅ Temp file + grep workflow | ❌ All results in context | **HIGH** |

---

## Root Cause Analysis

### Why is the Agent Limited?

The agent is constrained by its **tool-based architecture**:

1. **Tools must be predefined** - Cannot dynamically create SQL-based tools
2. **ctx.search() abstraction** - Hides the underlying SQL flexibility
3. **No direct database access** - Tools don't expose `postgresClient` for raw queries
4. **Fixed schema** - Tool input schemas cannot be dynamically generated based on table structure

### What the Skill Does Differently

The skill operates at a **lower level**:
1. **Direct PostgreSQL access** - Uses `psql` commands with full SQL control
2. **Context discovery** - Queries `information_schema` to understand table structures
3. **Dynamic query building** - Crafts SQL based on query type (COUNT, search, aggregation)
4. **Strategy learning** - Stores successful patterns in STRATEGY.md

---

## Proposed Solution Strategy

### Option 1: Add SQL Query Tool (RECOMMENDED)

**Concept:** Give the agent a new tool that can execute safe, read-only SQL queries directly.

**Implementation:**

```typescript
const sqlQueryTool = tool({
  description: `
    Execute a read-only SQL query against ExuluContext tables for advanced retrieval needs.

    Use this tool when you need to:
    - COUNT or aggregate data (e.g., "How many documents mention X?")
    - Filter by custom fields (tags, dates, JSONB fields)
    - Get statistics (AVG, SUM, MIN, MAX)
    - Query item metadata without searching content
    - Execute complex JOINs or GROUP BY queries

    IMPORTANT:
    - Only SELECT queries allowed (no INSERT, UPDATE, DELETE)
    - Must query ExuluContext tables (${contexts.map(c => `${c.id}_items, ${c.id}_chunks`).join(', ')})
    - Use parameterized queries for user input
  `,
  inputSchema: z.object({
    context_id: z.enum(contexts.map(c => c.id)),
    query: z.string().describe("The SQL SELECT query to execute"),
    reasoning: z.string().describe("Explain why you need this SQL query vs using search_content"),
  }),
  execute: async ({ context_id, query, reasoning }) => {
    // Validate query is read-only
    if (!/^\\s*SELECT/i.test(query)) {
      throw new Error("Only SELECT queries allowed");
    }

    // Validate table names
    const validTables = [`${context_id}_items`, `${context_id}_chunks`];
    // ... more validation

    // Execute with safety limits
    const { db } = await postgresClient();
    const results = await db.raw(query + ' LIMIT 1000');

    return JSON.stringify(results.rows, null, 2);
  }
});
```

**Pros:**
- ✅ Maximum flexibility - agent can do anything the skill can
- ✅ Leverages LLM's SQL knowledge
- ✅ Minimal code changes

**Cons:**
- ⚠️ SQL injection risk (needs robust validation)
- ⚠️ Agent might generate inefficient queries
- ⚠️ Requires LLM to know table schemas

**Mitigation:**
- Provide table schema in tool description
- Use SQL parser to validate queries
- Set strict LIMIT caps
- Log all SQL queries for audit

---

### Option 1.5: Add Iterative Filtering with Virtual Bash Environment

**Concept:** Allow agent to save large result sets to a virtual filesystem, then iteratively grep/filter without loading all content into context. Uses `bash-tool` from AI SDK to provide grep/bash capabilities.

**Implementation:**

```typescript
import { createBashTool } from 'bash-tool';
import { generateText } from 'ai';

// Create agent with bash tool support
const createAgenticRetrievalWithBashSupport = async ({
  contexts,
  model,
  // ... other params
}) => {
  // Initialize virtual bash environment
  const { tools: bashTools, updateFiles } = await createBashTool({
    files: {}, // Start with empty virtual filesystem
  });

  // Tool to save search results to virtual filesystem
  const saveSearchResultsTool = tool({
    description: `
      Execute a search and save results to the virtual filesystem instead of returning them directly.
      This is useful when you expect many results and want to iteratively filter them
      without consuming tokens by loading all content into context.

      After saving, you can use bash tools (grep, awk, head, tail) to find specific patterns.
      The file will be available in the virtual filesystem at /search_results.txt
    `,
    inputSchema: z.object({
      context_ids: z.array(z.enum(contexts.map(c => c.id))),
      query: z.string(),
      searchMethod: z.enum(['keyword', 'semantic', 'hybrid']),
      limit: z.number().max(1000).describe("Can retrieve up to 1000 results"),
      includeContent: z.boolean().default(true),
    }),
    execute: async ({ query, context_ids, searchMethod, limit, includeContent }) => {
      // Execute search across contexts
      const results = await Promise.all(
        context_ids.map(async (contextId) => {
          const ctx = contexts.find(c => c.id === contextId);
          return await ctx.search({
            query,
            method: searchMethod === 'hybrid' ? 'hybridSearch' : ...,
            limit,
            // ... other params
          });
        })
      );

      const chunks = results.flat();

      // Format results in a greppable format with clear separators
      const formattedContent = chunks.map((chunk, idx) =>
        `### RESULT ${idx + 1} ###\n` +
        `ITEM_NAME: ${chunk.item_name}\n` +
        `ITEM_ID: ${chunk.item_id}\n` +
        `CHUNK_ID: ${chunk.chunk_id}\n` +
        `CHUNK_INDEX: ${chunk.chunk_index}\n` +
        `CONTEXT: ${chunk.context?.id}\n` +
        `SCORE: ${chunk.chunk_hybrid_score || chunk.chunk_fts_rank || chunk.chunk_cosine_distance}\n` +
        `---CONTENT START---\n` +
        `${includeContent ? chunk.chunk_content : '[Content not included - use includeContent: true to load]'}\n` +
        `---CONTENT END---\n\n`
      ).join('');

      // Update virtual filesystem with search results
      await updateFiles({
        'search_results.txt': formattedContent,
        'search_metadata.json': JSON.stringify({
          query,
          timestamp: new Date().toISOString(),
          results_count: chunks.length,
          contexts: context_ids,
          method: searchMethod,
        }, null, 2)
      });

      return JSON.stringify({
        success: true,
        results_count: chunks.length,
        message: `Saved ${chunks.length} results to virtual filesystem at /search_results.txt`,
        available_commands: [
          'grep -i "pattern" search_results.txt',
          'grep "ITEM_NAME: specific_name" search_results.txt -A 10',
          'awk \'/RESULT/ {print $3}\' search_results.txt',
          'head -50 search_results.txt',
          'grep "CHUNK_ID:" search_results.txt | wc -l'
        ],
        next_steps: "Use bash tools to grep/filter the results. Example: grep -i 'safety' search_results.txt"
      }, null, 2);
    }
  });

  // Combine all tools
  const allTools = {
    ...searchTools,
    ...searchItemsByNameTool,
    save_search_results: saveSearchResultsTool,
    ...bashTools, // Provides: bash, grep, awk, sed, head, tail, cat, etc.
  };

  return createCustomAgenticRetrievalToolLoopAgent({
    model,
    tools: allTools,
    // ... other config
  });
};
```

**Workflow Example:**
```
1. User: "Find all documents about elevator safety"

2. Agent reasoning: "This is a broad query, I'll save results to virtual filesystem"
   Tool: save_search_results → Saves 100 chunks to virtual /search_results.txt
   Output: "Saved 100 results, use grep to filter"

3. Agent reasoning: "Now I'll grep for specific safety procedures"
   Tool: bash → grep -i "notfall\|emergency" search_results.txt | head -30
   Output: Shows 30 lines mentioning emergency procedures (minimal tokens)

4. Agent reasoning: "Found relevant section in ITEM_NAME: Safety_Manual_2024, let me extract that chunk ID"
   Tool: bash → grep -B 3 "Notfallverfahren" search_results.txt | grep "CHUNK_ID:"
   Output: CHUNK_ID: abc-123-def

5. Agent reasoning: "Now I'll get the full content for that specific chunk"
   Tool: get_content_abc-123-def → Returns full chunk content
```

**Pros:**
- ✅ Token efficiency - can retrieve 1000+ results without loading into context
- ✅ Iterative refinement - grep, awk, sed for complex filtering
- ✅ Cost savings - only load specific chunks after identifying via grep
- ✅ Speed - bash operations are instant vs multiple LLM tool calls
- ✅ Safe - virtual filesystem, no actual file system access
- ✅ Familiar - agents already know how to use bash/grep

**Cons:**
- ⚠️ Requires bash-tool dependency
- ⚠️ More complex workflow - agent needs training on when to use this pattern
- ⚠️ Formatting matters - results must be in greppable format with clear separators

**Token Savings Example:**
- Without this: Load 100 chunks × 500 tokens each = 50,000 tokens
- With this: Save to file (100 tokens) + grep operations (500 tokens) + load 3 specific chunks (1,500 tokens) = **2,100 tokens (96% savings)**

---

### Option 2: Add Specialized COUNT/Aggregation Tools

**Concept:** Create dedicated tools for common operations the skill can do.

**Implementation:**

```typescript
const countTool = tool({
  description: "Count items or chunks matching criteria",
  inputSchema: z.object({
    context_ids: z.array(z.enum(contexts.map(c => c.id))),
    count_what: z.enum(['items', 'chunks', 'distinct_items']),
    content_query: z.string().optional().describe("FTS query for chunks content"),
    item_name_contains: z.string().optional(),
    item_tags_contain: z.string().optional(),
    created_after: z.string().optional().describe("ISO date"),
  }),
  execute: async ({ ... }) => {
    // Build COUNT query based on parameters
    const countQuery = buildCountQuery(params);
    const results = await db.raw(countQuery);
    return results.rows[0].count;
  }
});

const aggregateTool = tool({
  description: "Get statistics and aggregations",
  inputSchema: z.object({
    context_ids: z.array(z.enum(contexts.map(c => c.id))),
    group_by: z.enum(['tags', 'created_date', 'item_name']).optional(),
    aggregate: z.enum(['count', 'avg_chunks', 'sum_chunks']),
  }),
  // ... similar pattern
});

const filterItemsTool = tool({
  description: "Query items table directly with advanced filtering",
  inputSchema: z.object({
    context_id: z.enum(contexts.map(c => c.id)),
    filters: z.array(z.object({
      field: z.string(),
      operator: z.enum(['equals', 'contains', 'greater_than', 'less_than', 'in']),
      value: z.any(),
    })),
    limit: z.number().default(100),
  }),
  // ... builds WHERE clause from filters
});
```

**Pros:**
- ✅ Safer than raw SQL
- ✅ More guided - agent knows exactly what each tool does
- ✅ Can optimize each tool independently

**Cons:**
- ❌ Less flexible - need to add new tools for new patterns
- ❌ More code to maintain
- ❌ Still limited to predefined operations

---

### Option 3: Hybrid Approach (BEST BALANCE)

**Concept:** Combine both approaches with safety layers.

1. **Add specialized tools** for common patterns (COUNT, basic aggregations)
2. **Add SQL tool** for advanced cases, but with strict validation
3. **Teach the agent** when to use which tool

**Implementation:**

```typescript
const tools = {
  ...existingTools,

  // Safe, common operations
  count_items_or_chunks: countTool,
  aggregate_statistics: aggregateTool,
  query_items_metadata: filterItemsTool,

  // Advanced fallback (requires reasoning)
  advanced_sql_query: {
    ...sqlQueryTool,
    description: `
      ${sqlQueryTool.description}

      USE THIS ONLY WHEN:
      - count_items_or_chunks cannot handle the COUNT query
      - aggregate_statistics cannot handle the aggregation
      - query_items_metadata cannot handle the filtering
      - You need complex JOINs or subqueries

      ALWAYS TRY the specialized tools FIRST!
    `
  }
};
```

**Agent instruction updates:**

```typescript
const updatedInstructions = `
${baseInstructions}

QUERY STRATEGY DECISION TREE:

1. FOR COUNTING QUERIES ("how many...", "count...", "number of..."):
   - Use count_items_or_chunks tool
   - Specify what to count (items, chunks, distinct_items)
   - Apply filters as needed

2. FOR STATISTICS ("average...", "total...", "breakdown by..."):
   - Use aggregate_statistics tool
   - Choose aggregation type and grouping

3. FOR METADATA QUERIES ("list items created after...", "show items tagged..."):
   - Use query_items_metadata tool
   - Build filter conditions

4. FOR CONTENT SEARCH (default pattern):
   - Use existing search_content / search_items_by_name tools

5. FOR COMPLEX QUERIES (last resort):
   - Use advanced_sql_query with full justification
   - Must explain why specialized tools insufficient
`;
```

**Pros:**
- ✅ Safe common path (80% of cases)
- ✅ Flexible escape hatch (20% of cases)
- ✅ Guided decision-making
- ✅ Easier to maintain safety

**Cons:**
- ⚠️ More tools = more complexity
- ⚠️ Agent must learn when to use which tool

---

## Recommended Implementation Plan

### Phase 1: Add Counting & Aggregation (Week 1)

1. **Implement `count_items_or_chunks` tool**
   - Support: count items, count chunks, count distinct items by content query
   - Add filtering: by name, tags, dates, custom fields
   - Test with queries like "How many documents mention X?"

2. **Implement `aggregate_statistics` tool**
   - Support: COUNT, AVG, SUM, MIN, MAX
   - GROUP BY support for: tags, dates, item names
   - Test with queries like "Show me a breakdown of documents by tag"

3. **Update agent instructions**
   - Add COUNT query pattern
   - Add STATISTICS query pattern
   - Provide examples

**Success Metrics:**
- Agent can handle "how many..." queries
- Agent can provide breakdowns and statistics
- No SQL injection vulnerabilities

### Phase 2: Add Advanced Filtering (Week 2)

1. **Implement `query_items_metadata` tool**
   - Support filtering by ANY field with operators
   - Return item metadata without content
   - Support pagination

2. **Implement `query_by_custom_fields` tool**
   - Allow filtering by tags, JSONB fields, dates
   - Support complex conditions (AND, OR)

3. **Implement iterative filtering tool**
   - Add `save_search_results_to_file` tool that saves results without loading into context
   - Returns file path where results were saved
   - Agent can then use grep/analysis tools on the file iteratively
   - Only loads relevant portions into context

4. **Update dynamic tools**
   - Make `get_more_content` accept chunk index ranges
   - Add `get_item_details` for specific item exploration

**Success Metrics:**
- Agent can find items by date ranges
- Agent can filter by tags and custom fields
- Agent can explore specific items in detail
- Agent can retrieve 100+ chunks efficiently without consuming excessive tokens

### Phase 3: Add SQL Tool (Week 3) - OPTIONAL

1. **Implement `advanced_sql_query` tool with validation**
   - SQL parser to verify SELECT-only
   - Table name whitelist
   - LIMIT enforcement
   - Parameter binding

2. **Add guardrails**
   - Require reasoning field
   - Log all queries
   - Rate limiting

3. **Update instructions**
   - Teach agent when SQL tool is appropriate
   - Provide SQL query templates
   - Show table schemas

**Success Metrics:**
- Agent uses SQL tool only when necessary
- Zero SQL injection incidents
- Complex queries execute correctly

### Phase 4: Add Learning (Week 4)

1. **Implement strategy persistence**
   - Store successful query patterns
   - Track what tools worked for what queries
   - Learn from failures

2. **Add feedback loop**
   - Agent asks if results were helpful
   - Updates strategy based on feedback
   - Shares learnings across sessions

3. **Create STRATEGY.json**
   - Store learned patterns
   - Context-specific strategies
   - Query type → tool mapping

**Success Metrics:**
- Agent improves over time
- Fewer failed searches
- Better tool selection

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| SQL Injection | 🔴 HIGH | SQL parser, whitelist, parameterization |
| Performance impact | 🟡 MEDIUM | Query timeouts, LIMIT enforcement |
| Wrong tool selection | 🟡 MEDIUM | Clear instructions, examples, learning |
| Maintenance burden | 🟡 MEDIUM | Good documentation, tests |
| Cost increase | 🟢 LOW | Proper tool selection reduces retries |

---

## Appendix: Example Queries the Agent Cannot Handle Now

1. **COUNT queries:**
   ```sql
   -- Skill can do this
   SELECT COUNT(DISTINCT source) FROM vorschriften_chunks
   WHERE fts @@ to_tsquery('german', 'EN-8100');

   -- Agent cannot
   ```

2. **Aggregations:**
   ```sql
   -- Skill can do this
   SELECT
     unnest(string_to_array(tags, ',')) as tag,
     COUNT(*) as count
   FROM techDoc_items
   GROUP BY tag
   ORDER BY count DESC;

   -- Agent cannot
   ```

3. **Date filtering:**
   ```sql
   -- Skill can do this
   SELECT * FROM techDoc_items
   WHERE "createdAt" > NOW() - INTERVAL '7 days'
   AND archived = false;

   -- Agent cannot filter by dates
   ```

4. **Tag filtering:**
   ```sql
   -- Skill can do this
   SELECT * FROM vorschriften_items
   WHERE tags LIKE '%important%';

   -- Agent cannot filter by tags
   ```

5. **Statistics:**
   ```sql
   -- Skill can do this
   SELECT
     AVG(chunks_count) as avg_chunks,
     MAX(chunks_count) as max_chunks,
     COUNT(*) as total_items
   FROM techDoc_items;

   -- Agent cannot compute statistics
   ```

---

## Conclusion

The agentic retrieval agent is **functionally good** but **strategically limited** compared to the ExuluContext retrieval skill. The recommended path forward is:

1. **Immediate (Week 1):** Add COUNT and aggregation tools
2. **Short-term (Week 2):** Add advanced filtering tools
3. **Medium-term (Week 3):** Consider SQL tool with strict validation
4. **Long-term (Week 4):** Add learning/strategy persistence

This approach balances **safety**, **flexibility**, and **maintenance burden** while bringing the agent closer to the skill's capabilities.
