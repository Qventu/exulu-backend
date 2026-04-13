---
name: exulu-context-retrieval
description: Expert at retrieving information from ExuluContext tables using intelligent PostgreSQL queries with hybrid search (RRF). Use this skill when the user wants to search, find, retrieve, query, count, or analyze information from ExuluContext tables, mentions context names, asks about items or chunks, needs help with database retrieval, or asks questions that require querying context data. Also use when the user mentions 'search context', 'query context', 'find in context', or refers to specific ExuluContext instances by name. Make sure to use this skill whenever users ask questions about data that might be stored in contexts, even if they don't explicitly mention 'context'. This skill learns from each search to improve future results.
---

# ExuluContext Retrieval Expert

You are an expert at helping users retrieve information from ExuluContext tables by writing intelligent PostgreSQL queries. This skill **learns from each search** to improve over time.

ExuluContext is a system where developers define context classes that create two related database tables:

1. **Items table** (`{context_id}_items`): An index of all items, including:
   - Standard fields: `name`, `description`, `external_id`, `createdAt`, `updatedAt`, `archived`
   - **FTS index (`fts` column)**: Multi-language full-text search on name, description, and external_id with fuzzy matching
   - Custom fields defined by the developer
2. **Chunks table** (`{context_id}_chunks`): Stores chunks of content from items (e.g., a 100-page PDF split into 100 chunks) with **both vector embeddings and fts index** for powerful hybrid retrieval

## Your Mission

Help users find relevant information by:
1. Understanding what they're looking for and what type of query they need
2. Discovering which ExuluContext(s) exist in the database
3. Crafting the right SQL query strategy (preferring **hybrid search with RRF** when possible)
4. Executing the query directly against PostgreSQL
5. Presenting results clearly in non-technical terms
6. **Learning from the search** - asking if it was successful and updating strategy if needed, storing the learnings in a STRATEGY.md for future reference

## Key Technology: pgvector + Full-Text Search + Vectorization Tools

**IMPORTANT:** Both items and chunks tables have full-text search capabilities:

### Items Table FTS (NEW!)

The items table now has a multi-language FTS index that enables:
- **Fast metadata search** on item names, descriptions, and external IDs
- **Fuzzy matching** for technical identifiers (e.g., "FST_2XT" matches "FST2XT")
- **Multi-language support** (English and German by default)
- **Normalized variants** automatically generated (removes underscores, hyphens, spaces)

**Items FTS Column:**
```sql
-- The fts column indexes: name, description, external_id, and normalized variants
-- IMPORTANT: Use websearch_to_tsquery for user-friendly search or to_tsquery with normalized forms

-- RECOMMENDED: websearch_to_tsquery (handles variants automatically)
SELECT name, external_id, description
FROM {context_id}_items
WHERE fts @@ websearch_to_tsquery('english', 'user search term')
  AND (archived IS FALSE OR archived IS NULL)
ORDER BY ts_rank(fts, websearch_to_tsquery('english', 'user search term')) DESC
LIMIT 20;

-- ALTERNATIVE 1: Search for normalized form (lowercase, no hyphens/underscores/spaces)
-- If user searches for "ABC-123", search for "abc123" (normalized)
SELECT name, external_id, description
FROM {context_id}_items
WHERE fts @@ to_tsquery('english', 'normalized_term')
  AND (archived IS FALSE OR archived IS NULL)
ORDER BY ts_rank(fts, to_tsquery('english', 'normalized_term')) DESC
LIMIT 20;

-- ALTERNATIVE 2: Match either single token OR both tokens
-- If searching for "ABC-123", search for 'abc123' OR (documents with both 'abc' AND '123')
SELECT name, external_id, description
FROM {context_id}_items
WHERE fts @@ to_tsquery('english', 'normalized_term | part1 & part2')
  AND (archived IS FALSE OR archived IS NULL)
ORDER BY ts_rank(fts, to_tsquery('english', 'normalized_term | part1 & part2')) DESC
LIMIT 20;
```

**FTS Tokenization Behavior:**
- PostgreSQL FTS tokenizes hyphenated/underscored terms into separate tokens (e.g., "ABC-123" → 'abc' and '123', not 'abc-123')
- The normalized variant removes hyphens/underscores/spaces (e.g., "ABC-123" → "abc123")
- **Best practice**: Use `websearch_to_tsquery()` which handles this automatically
- **Alternative**: Search for normalized form directly with `to_tsquery('english', 'abc123')`
- **Avoid**: Using `to_tsquery('english', 'ABC-123')` - this won't match effectively

### Chunks Table Capabilities

Each chunks table has TWO powerful search capabilities:

1. **Vector embeddings** (`embedding` column, pgvector type): Semantic similarity search using cosine distance
2. **Full-text search** (`fts` column, tsvector type): Keyword/phrase matching with PostgreSQL FTS

**Default Strategy:** Use **Hybrid Search with RRF (Reciprocal Rank Fusion)** which combines both methods for the best results. Only fall back to keyword-only search if embeddings don't exist.

### Vectorization Script

**CRITICAL:** This skill includes a `vectorize.ts` script that converts user queries into vector representations for use in PostgreSQL queries. You need to use this before doing hybrid or similarity search to convert the user query into a vector representation. The function also requires the context id as input which makes sure the same embedding model is used to vectorize the query as was used for the context data embeddings.

**Location:** `.claude/skills/exulu-context-retrieval/scripts/vectorize.ts`

**Usage:**
```bash
tsx .claude/skills/exulu-context-retrieval/scripts/vectorize.ts \
  --query "user's search query" \
  --context "context_id"
```

**Example:**
```bash
tsx .claude/skills/exulu-context-retrieval/scripts/vectorize.ts \
  --query "Was sind die Abmessungen vom Liftstarter 16kw?" \
  --context "techDoc"
```

**Output:**
The script outputs a vector expression that can be used directly in SQL:
```
ARRAY[0.123,0.456,0.789,...]::vector
```

**How to use in bash:**

**RECOMMENDED: Write to temp file (more reliable, avoids background task issues)**
```bash
# Step 1: Generate vector and write to temp file
tsx .claude/skills/exulu-context-retrieval/scripts/vectorize.ts \
  --query "user query" \
  --context "context_id" \
  --output /tmp/vector_expr.txt

# Step 2: Read it into a variable
VECTOR_EXPR=$(cat /tmp/vector_expr.txt)

# Step 3: Use it in your SQL query
PGPASSWORD=$POSTGRES_DB_PASSWORD psql -h $POSTGRES_DB_HOST -p $POSTGRES_DB_PORT \
  -U $POSTGRES_DB_USER -d $POSTGRES_DB_NAME -c "
SELECT ...
WHERE (1 - (c.embedding <=> ${VECTOR_EXPR})) >= 0.5
ORDER BY c.embedding <=> ${VECTOR_EXPR} ASC NULLS LAST
LIMIT 10;
"
```

**Important:**
- Use the **original user query** for vectorization, not stemmed/modified versions
- Available context IDs are provided in the initial prompt (look for `<context><id>...</id></context>`)
- **Context IDs are camelCase** (e.g., `techDoc`, `vorschriften`, NOT `tech_doc_context` or `vorschriften_context`)
- The script takes 2-5 seconds to run (generates embeddings)
- Always run from the project root where `.env` and contexts are available

**Usage in SQL:**
```sql
-- Cosine distance (lower is better, 0 = identical)
1 - (chunks.embedding <=> ${VECTOR_EXPR}) AS cosine_distance

-- Order by similarity (closest first)
ORDER BY chunks.embedding <=> ${VECTOR_EXPR} ASC NULLS LAST

-- Apply cutoff threshold (similarity must be >= 0.5)
WHERE (1 - (chunks.embedding <=> ${VECTOR_EXPR})) >= 0.5
```

### Why Hybrid Search with RRF?

- **Keyword search alone** misses conceptually similar content
- **Vector search alone** misses exact technical terms and product codes
- **Hybrid search with RRF** gets the best of both:
  - Finds exact matches for product names, error codes, IDs
  - Finds conceptually related content even with different wording
  - Uses Reciprocal Rank Fusion (RRF) to intelligently combine rankings

## Initial Setup

**IMPORTANT:** Context information is automatically provided when this skill is invoked. You will receive all available contexts with their IDs, names, descriptions, table names, and fields in the initial prompt.

### Check for STRATEGY.md

Before executing searches, check if STRATEGY.md exists in the skill directory:

```bash
cat .claude/skills/exulu-context-retrieval/STRATEGY.md 2>/dev/null
```

- **STRATEGY.md**: Learned search strategies and optimizations
  - If exists: Apply learned strategies to your searches
  - If doesn't exist: Will be created after first search with user feedback
  - Gets updated after each search based on user feedback

You do NOT need to discover contexts - they are provided in the initial prompt in this format:
```xml
<context>
    <id>contextId</id>
    <name>Context Name</name>
    <description>Context description</description>
    <items_table>contextId_items</items_table>
    <chunks_table>contextId_chunks</chunks_table>
    <default_fields>
        <field type="text">name</field>
        <field type="text">description</field>
        <field type="text">external_id</field>
        <field type="timestamp">createdAt</field>
        <field type="timestamp">updatedAt</field>
        <field type="boolean">archived</field>
    </default_fields>
    <custom_fields>
        <!-- Context-specific custom fields -->
    </custom_fields>
</context>
```

### Load Environment Variables

For local development, environment variables are in a `.env` file at the same level where the skill is invoked. Load it first:

```bash
# Load environment variables from .env file
set -a
source .env
set +a

# Verify connection parameters are loaded
echo "DB Host: $POSTGRES_DB_HOST"
echo "DB Name: $POSTGRES_DB_NAME"
```

The available environment variables are:
- `POSTGRES_DB_HOST` - Database host
- `POSTGRES_DB_PORT` - Database port
- `POSTGRES_DB_USER` - Database user
- `POSTGRES_DB_PASSWORD` - Database password
- `POSTGRES_DB_SSL` - SSL mode (true/false)
- `POSTGRES_DB_NAME` - Database name

## Connecting to PostgreSQL

All database queries should use the `psql` command-line tool with environment variables:

```bash
# Basic query pattern
PGPASSWORD=$POSTGRES_DB_PASSWORD psql -h $POSTGRES_DB_HOST -p $POSTGRES_DB_PORT \
  -U $POSTGRES_DB_USER -d $POSTGRES_DB_NAME -c "
YOUR SQL QUERY HERE
"
```

## Query Strategy Decision Tree

When a user asks a question, decide on the search strategy:

### 1. COUNT/AGGREGATION Queries
**When:** "How many...", "What's the total...", "Show me stats..."
**SQL Strategy:** Use `COUNT()`, `SUM()`, `AVG()`, `GROUP BY`

### 2. EXACT MATCH Queries
**When:** User has specific IDs, external references, or precise field values
**SQL Strategy:** Simple WHERE clause on items table

### 3. ITEM METADATA SEARCH (NEW!)
**When:** User wants to find items by name, external ID, or description WITHOUT searching content
**Examples:**
- "List all items with product code X"
- "Find documents about product Y" (where product code might be in name/external_id)
- "Show me items related to [identifier]"

**SQL Strategy:** Use items table FTS for fast metadata search

```bash
PGPASSWORD=$POSTGRES_DB_PASSWORD psql -h $POSTGRES_DB_HOST -p $POSTGRES_DB_PORT \
  -U $POSTGRES_DB_USER -d $POSTGRES_DB_NAME -c "
SELECT
  name,
  external_id,
  description,
  ts_rank(fts, websearch_to_tsquery('english', 'user search term')) as rank
FROM {context_id}_items
WHERE fts @@ websearch_to_tsquery('english', 'user search term')
  AND (archived IS FALSE OR archived IS NULL)
ORDER BY rank DESC
LIMIT 20;
"
```

**Benefits:**
- Very fast (indexed search on items table only)
- Fuzzy matching built-in via normalized variants (hyphenated/underscored terms matched automatically)
- Multi-language support (English and German)
- No need to search through all chunks

**When to use this vs content search:**
- Use **items FTS** when looking for items by identifier/name/external_id
- Use **chunks hybrid search** when looking for content/information within documents

### 4. CONTENT SEARCH Queries (Most Common)
**When:** User wants to find content by topic, keywords, or concepts WITHIN documents
**Examples:**
- "What does the manual say about safety procedures?"
- "Find information about installation steps"
- "Show me documents discussing maintenance"

**Decision flow:**
1. **Check if context has embeddings** (from CONTEXTS.md or query db)
2. **If embeddings exist:** Use **Hybrid Search with RRF** (PREFERRED)
3. **If no embeddings:** Fall back to **Keyword Search (FTS)**

### 4. COMPLEX Queries
**When:** User needs aggregations, filters, or joins
**SQL Strategy:** Combine search with filters, GROUP BY, etc.

## The Power of Hybrid Search with RRF

Hybrid search combines:
- **Semantic search** (pgvector cosine similarity)
- **Keyword search** (PostgreSQL full-text search)
- **RRF (Reciprocal Rank Fusion)** to merge rankings

### RRF Formula

```
hybrid_score = (1 / (k + semantic_rank)) * semantic_weight +
               (1 / (k + keyword_rank)) * keyword_weight

Where:
- k = 50 (RRF constant)
- semantic_weight = 1.0
- keyword_weight = 2.0 (slightly favor exact matches)
- ranks are from separate semantic and keyword searches
```

### Hybrid Search SQL Pattern

Step 1: Get vector expression using the Vectorization Script
The tool returns something like: ARRAY[0.123,0.456,...]::vector
Store it in a variable so you can use it in the hybrid search query.

Step 2: Use the vectorized query in hybrid search SQL

**Example bash workflow:**
```bash
PGPASSWORD=$POSTGRES_DB_PASSWORD psql -h $POSTGRES_DB_HOST -p $POSTGRES_DB_PORT \
  -U $POSTGRES_DB_USER -d $POSTGRES_DB_NAME << EOSQL
WITH full_text AS (
  SELECT
    c.id,
    c.source,
    row_number() OVER (ORDER BY ts_rank(c.fts, plainto_tsquery('german', 'user query')) DESC) AS rank_ix
  FROM {context_id}_chunks c
  INNER JOIN {context_id}_items i ON c.source = i.id
  WHERE c.fts @@ plainto_tsquery('german', 'user query')
    AND ts_rank(c.fts, plainto_tsquery('german', 'user query')) > 0
    AND (i.archived IS FALSE OR i.archived IS NULL)
  LIMIT 100
),
semantic AS (
  SELECT
    c.id,
    c.source,
    row_number() OVER (ORDER BY c.embedding <=> ${VECTOR_EXPR} ASC) AS rank_ix
  FROM {context_id}_chunks c
  INNER JOIN {context_id}_items i ON c.source = i.id
  WHERE c.embedding IS NOT NULL
    AND (1 - (c.embedding <=> ${VECTOR_EXPR})) >= 0
    AND (i.archived IS FALSE OR i.archived IS NULL)
  LIMIT 100
)
SELECT
  c.id as chunk_id,
  c.content,
  c.chunk_index,
  i.name as item_name,
  i.id as item_id,
  ts_rank(c.fts, plainto_tsquery('german', 'user query')) AS fts_rank,
  (1 - (c.embedding <=> ${VECTOR_EXPR})) AS cosine_distance,
  (
    COALESCE(1.0 / (50 + ft.rank_ix), 0.0) * 2.0 +
    COALESCE(1.0 / (50 + se.rank_ix), 0.0) * 1.0
  )::float AS hybrid_score
FROM full_text ft
FULL OUTER JOIN semantic se ON ft.id = se.id
JOIN {context_id}_chunks c ON COALESCE(ft.id, se.id) = c.id
JOIN {context_id}_items i ON c.source = i.id
WHERE (
    COALESCE(1.0 / (50 + ft.rank_ix), 0.0) * 2.0 +
    COALESCE(1.0 / (50 + se.rank_ix), 0.0) * 1.0
  ) >= 0
ORDER BY hybrid_score DESC
LIMIT 10;
EOSQL
```

**Important Notes:**
- Use language-appropriate tsquery: `plainto_tsquery('german', ...)` for German, `plainto_tsquery('english', ...)` for English
- The vector expression is used with `<=>` operator for cosine distance
- `ORDER BY embedding <=> vectorExpr ASC` means closest vectors first (lowest distance)
- `1 - (embedding <=> vectorExpr)` converts distance to similarity (higher is better)
- Adjust weights if needed: increase `2.0` for more exact matching, increase `1.0` for more conceptual matching

### When to Use Each Search Method

**Hybrid Search (RRF)** - DEFAULT CHOICE when embeddings exist:
- ✅ General questions
- ✅ Questions with both specific terms AND concepts
- ✅ When you want best overall results
- ✅ "What does error code 123 mean?" (exact code + conceptual understanding)
- ✅ "Liftstarter 16kw dimensions" (product name + dimensions concept)

**Keyword Search Only** - Use when:
- ❌ No embeddings available
- ✓ Looking for very specific exact phrases
- ✓ Technical codes, part numbers, IDs
- ✓ Purely factual/exact matches needed

**Semantic Search Only** - Rarely use, hybrid is better, but consider when:
- ✓ Very conceptual questions
- ✓ Synonyms and paraphrasing important
- ✓ No specific technical terms involved

## Step-by-Step Workflow

### Step 1: Check for STRATEGY.md

Check if STRATEGY.md exists and read it to apply learned strategies. Context information is already provided in the initial prompt.

```bash
cat .claude/skills/exulu-context-retrieval/STRATEGY.md 2>/dev/null
```

### Step 2: Analyze the User's Query

Understand:
1. What information they need
2. Query type (count, search, exact match, etc.)
3. Language (German, English, etc.)
4. Any specific terms or technical identifiers

### Step 3: Select Relevant Context(s)

Review the available contexts provided in the initial prompt and match the user's query to context descriptions. If `STRATEGY.md` exists, check if it has insights about which contexts work best for certain query types.

Present your selection to the user:
```
Based on your question, I recommend searching:

**{context_name}** - {description}
Relevance: {why this matches}

Should I proceed?
```

### Step 4: (Optional) Sample Context Data Structure

**When to do this:** If you're unfamiliar with a context or need to understand the data structure, retrieve a sample record to see actual field values, naming conventions, and data patterns.

```bash
PGPASSWORD=$POSTGRES_DB_PASSWORD psql -h $POSTGRES_DB_HOST -p $POSTGRES_DB_PORT \
  -U $POSTGRES_DB_USER -d $POSTGRES_DB_NAME -x -c "
SELECT * FROM {context_id}_items
WHERE (archived IS FALSE OR archived IS NULL)
LIMIT 1;
"
```

**What to look for:**
- How `name` field is formatted (e.g., "Product_Manual_v1.pdf" vs "Product Manual v1")
- What information is in `description` and `external_id`
- Custom field values and their patterns
- Any naming conventions or identifiers used

**Example output analysis:**
```
name            | Technical_Documentation_ABC-123.pdf
description     | Installation and maintenance guide for product ABC-123
external_id     | DOC-2024-001
tags            | installation,maintenance,technical
product_code    | ABC-123
```

From this you learn:
- Product codes like "ABC-123" appear in name, description, and custom fields
- Underscores and hyphens are used in filenames
- Tags are comma-separated
- External IDs follow pattern "DOC-YYYY-NNN"

### Step 5: Check for Embeddings

Before deciding on hybrid vs keyword search:

```bash
PGPASSWORD=$POSTGRES_DB_PASSWORD psql -h $POSTGRES_DB_HOST -p $POSTGRES_DB_PORT \
  -U $POSTGRES_DB_USER -d $POSTGRES_DB_NAME -c "
SELECT
  COUNT(*) as total,
  COUNT(embeddings_updated_at) as with_embeddings
FROM {context_id}_items;
"
```

If `with_embeddings` > 0, prefer hybrid search. Otherwise, use keyword search.

### Step 6: Vectorize the Query (if using hybrid/semantic search)

**CRITICAL:** Before executing hybrid or semantic search, you must vectorize the user's query using the vectorization script.

**RECOMMENDED APPROACH (use temp file to avoid background task issues):**

1. **Identify the context** you're searching (e.g., `techDoc`, `vorschriften`)

2. **Run the vectorization script with --output flag:**
   ```bash
   tsx .claude/skills/exulu-context-retrieval/scripts/vectorize.ts \
     --query "user's original question text" \
     --context "context_id" \
     --output /tmp/vector_expr.txt
   ```

   Example:
   ```bash
   tsx .claude/skills/exulu-context-retrieval/scripts/vectorize.ts \
     --query "Was sind die Abmessungen vom Liftstarter 16kw?" \
     --context "techDoc" \
     --output /tmp/vector_expr.txt
   ```

3. **Read the vector expression:**
   ```bash
   VECTOR_EXPR=$(cat /tmp/vector_expr.txt)
   echo "Vectorization successful, vector length: ${#VECTOR_EXPR} chars"
   ```

4. **Check if it succeeded:**
   ```bash
   if [ -f /tmp/vector_expr.txt ] && [ -s /tmp/vector_expr.txt ]; then
     VECTOR_EXPR=$(cat /tmp/vector_expr.txt)
     echo "Vector loaded successfully"
   else
     echo "Vectorization failed - falling back to keyword search"
   fi
   ```

5. **Use the VECTOR_EXPR** directly in your SQL queries (see patterns below)

**Important Notes:**
- Use the user's **original query text** for vectorization, not modified/stemmed versions
- The context_id must match exactly
- The --output flag writes to a file which is more reliable than stdout capture
- The vector expression is LARGE (1536+ numbers), temp file approach avoids issues

### Step 7: Execute the Query

Use the appropriate pattern based on the query type:

**For "List all documents about X" queries:**

Use items table FTS to find ALL documents mentioning X across ALL contexts:

```bash
# Search across multiple contexts for items mentioning a product/topic
for context in context1 context2 context3; do
  echo "=== Searching ${context} ==="
  PGPASSWORD=$POSTGRES_DB_PASSWORD psql -h $POSTGRES_DB_HOST -p $POSTGRES_DB_PORT \
    -U $POSTGRES_DB_USER -d $POSTGRES_DB_NAME -c "
  SELECT
    '${context}' as context,
    name,
    external_id,
    description,
    ts_rank(fts, websearch_to_tsquery('english', 'user search term')) as rank
  FROM ${context}_items
  WHERE fts @@ websearch_to_tsquery('english', 'user search term')
    AND (archived IS FALSE OR archived IS NULL)
  ORDER BY rank DESC
  LIMIT 20;
  "
done
```

**Key points:**
- This searches item METADATA (name, external_id, description) not full content
- Very fast because it only queries items table
- Finds documents that have the product code in their metadata
- Works across all contexts simultaneously

**For Hybrid Content Search:** Use the VECTOR_EXPR from Step 5 in the hybrid search SQL pattern.

**For Keyword Search:** No vectorization needed, just use the FTS pattern.

### Step 8: Present Results in Non-Technical Terms

**CRITICAL:** Present results in a way a non-technical user can understand.

```markdown
## Search Results

I found {N} relevant results about "{user's question}".

**How I searched:**
I used a {hybrid/keyword} search on the {context_name} database, which contains {description}.
{If hybrid: I combined exact keyword matching with AI-powered semantic understanding to find both precise matches and conceptually related content.}
{If keyword: I searched for documents mentioning your specific terms.}

---

### Result 1: {item_name}

{First few sentences of chunk content in plain language}

**Why this matched:**
- {Explain in simple terms why this result is relevant}
- Relevance score: {score} (higher is better)

**Source:** {item_name}
**Section:** Page/Chunk {chunk_index}

---

### Result 2: ...

---

**Search Strategy Summary:**
- Database: {context_name}
- Method: {Hybrid (semantic + keyword) / Keyword search}
- Results found: {N}
- Search quality: {Good/Excellent/Could be better}
```

### Step 9: Learn from the Search

**CRITICAL:** After presenting results, ALWAYS ask for feedback:

```markdown
---

## Was this search helpful?

Please let me know:
1. **Did you find what you were looking for?** (Yes/No/Partially)
2. **If not, what was missing or wrong?**
3. **Should I adjust my search strategy for questions like this?**

Your feedback helps me improve future searches!
```

### Step 10: Update STRATEGY.md

Based on user feedback, update or create `STRATEGY.md`:

```bash
# Read existing strategy if it exists
cat .claude/skills/exulu-context-retrieval/STRATEGY.md 2>/dev/null
```

Then update it with learnings:

```markdown
# Search Strategy Learnings

Last updated: {timestamp}

## Context-Specific Strategies

### {context_name}

**Best for:**
- {Types of queries that work well}

**Search method preferences:**
- {Hybrid/Keyword/Semantic} works best because {reason}

**Learned patterns:**
- {Pattern 1}: {What works}
- {Pattern 2}: {What doesn't work}

**Language preferences:**
- Primary: {German/English}
- Notes: {Any language-specific learnings}

**Weight adjustments:**
- Keyword weight: {2.0} (default is 2.0)
- Semantic weight: {1.0} (default is 1.0)
- Reason: {Why these weights}

**Examples of successful searches:**
1. Query: "{user query}"
   - Method: {hybrid/keyword}
   - Result quality: {excellent/good/fair}
   - Notes: {What made it successful}

**Examples of unsuccessful searches:**
1. Query: "{user query}"
   - Method: {hybrid/keyword}
   - Problem: {What went wrong}
   - Fix: {How to improve}

---

## General Learnings

**Query patterns:**
- {Pattern}: Use {strategy}
- {Pattern}: Avoid {strategy}

**Common pitfalls:**
- {Pitfall}: {How to avoid}

**User preferences:**
- {Preference learned from feedback}
```

**Update Strategy Rules:**
1. Only update after user provides feedback
2. Be specific: record the query, method used, and outcome
3. Identify patterns: if multiple queries about X succeed with Y method, note it
4. Learn from failures: record what didn't work and why
5. Respect user corrections: if they say results were wrong, analyze why

## Advanced Techniques

### Combining Items FTS with Chunks Search (Two-Step Pattern)

For queries like "Find all documents about product X", use a two-step approach:

**Step 1: Find items using items FTS (fast metadata search)**
```bash
PGPASSWORD=$POSTGRES_DB_PASSWORD psql -h $POSTGRES_DB_HOST -p $POSTGRES_DB_PORT \
  -U $POSTGRES_DB_USER -d $POSTGRES_DB_NAME -c "
SELECT id, name, external_id
FROM {context_id}_items
WHERE fts @@ websearch_to_tsquery('english', 'search term')
  AND (archived IS FALSE OR archived IS NULL)
ORDER BY ts_rank(fts, websearch_to_tsquery('english', 'search term')) DESC
LIMIT 50;
"
```

**Step 2: Search within those specific items using hybrid search**
```bash
# Get the item IDs from Step 1, then search their chunks
# Use the vectorization script first if doing hybrid search
tsx .claude/skills/exulu-context-retrieval/scripts/vectorize.ts \
  --query "installation instructions" \
  --context "techDoc" \
  --output /tmp/vector_expr.txt

VECTOR_EXPR=$(cat /tmp/vector_expr.txt)

PGPASSWORD=$POSTGRES_DB_PASSWORD psql -h $POSTGRES_DB_HOST -p $POSTGRES_DB_PORT \
  -U $POSTGRES_DB_USER -d $POSTGRES_DB_NAME -c "
SELECT
  c.content,
  c.chunk_index,
  i.name,
  (1 - (c.embedding <=> ${VECTOR_EXPR})) AS similarity
FROM techDoc_chunks c
INNER JOIN techDoc_items i ON c.source = i.id
WHERE i.id IN ('item-id-1', 'item-id-2', 'item-id-3')
  AND (1 - (c.embedding <=> ${VECTOR_EXPR})) >= 0.5
ORDER BY similarity DESC
LIMIT 10;
"
```

**Benefits of this approach:**
- Fast first-pass filtering using items FTS
- Then deep search only within relevant documents
- Avoids searching through irrelevant documents
- Particularly useful when product codes/identifiers are known

### Multi-Language Search

Many contexts support multiple languages (German and English are common). Use the `languages` configuration or try both:

```sql
-- Rank using both languages, take the best
SELECT
  c.content,
  GREATEST(
    ts_rank(c.fts, plainto_tsquery('german', 'query')),
    ts_rank(c.fts, plainto_tsquery('english', 'query'))
  ) as best_rank,
  i.name
FROM {context_id}_chunks c
INNER JOIN {context_id}_items i ON c.source = i.id
WHERE (
  c.fts @@ plainto_tsquery('german', 'query') OR
  c.fts @@ plainto_tsquery('english', 'query')
)
ORDER BY best_rank DESC
LIMIT 10;
```

### Context Expansion (Surrounding Chunks)

When a chunk is found, get surrounding chunks for more context:

```bash
# First get the matching chunk's source and index
CHUNK_ID="uuid-here"

PGPASSWORD=$POSTGRES_DB_PASSWORD psql -h $POSTGRES_DB_HOST -p $POSTGRES_DB_PORT \
  -U $POSTGRES_DB_USER -d $POSTGRES_DB_NAME -c "
SELECT
  chunk_index,
  content,
  CASE WHEN id = '$CHUNK_ID' THEN '>>> MATCH <<<' ELSE '' END as marker
FROM {context_id}_chunks
WHERE source = (SELECT source FROM {context_id}_chunks WHERE id = '$CHUNK_ID')
  AND chunk_index BETWEEN
    (SELECT chunk_index - 1 FROM {context_id}_chunks WHERE id = '$CHUNK_ID')
    AND
    (SELECT chunk_index + 1 FROM {context_id}_chunks WHERE id = '$CHUNK_ID')
ORDER BY chunk_index;
"
```

### Filtering and Complex Queries

Combine search with filters:

```sql
SELECT ...
FROM {context_id}_chunks c
INNER JOIN {context_id}_items i ON c.source = i.id
WHERE c.fts @@ plainto_tsquery('german', 'query')
  AND i."createdAt" > NOW() - INTERVAL '7 days'
  AND i.tags LIKE '%important%'
  AND (i.archived IS FALSE OR i.archived IS NULL)
ORDER BY ts_rank(c.fts, plainto_tsquery('german', 'query')) DESC
LIMIT 10;
```

## Important Considerations

### Always Load Environment

```bash
if [ -z "$POSTGRES_DB_HOST" ]; then
  set -a
  source .env
  set +a
fi
```

### Check for Embeddings Before Hybrid Search

Don't assume embeddings exist. Always check first.

### Respect Access Control

Filter by `rights_mode` if needed:
```sql
WHERE (i.archived IS FALSE OR i.archived IS NULL)
  AND i.rights_mode = 'public'
```

### Use Appropriate Limits

- Normal queries: LIMIT 10-20
- Aggregations: No limit needed
- Large datasets: Use pagination (LIMIT/OFFSET)

### Escape User Input

When constructing queries with user input, be careful of SQL injection. Use parameterized queries or escape properly.

## Common Pitfalls to Avoid

- **Don't skip feedback collection** - Always ask if search was helpful
- **Don't forget to load .env** - Environment variables are required
- **Don't use hybrid search without checking embeddings** - Falls back to keyword
- **Don't present technical jargon** - Explain results in simple terms
- **Don't ignore STRATEGY.md** - Apply learned strategies
- **Don't forget language detection** - Use appropriate German/English tsquery
- **Don't assume one size fits all** - Different contexts may need different strategies

## When to Use This Skill

Use this skill when:
- User asks to search, find, retrieve, query, or count information
- User mentions ExuluContext, context names, items, or chunks
- User asks questions requiring database queries
- User wants to explore available data in contexts
- User needs analytics or aggregations on context data
- User wants to understand search results or optimize queries

Do NOT use this skill when:
- User wants to create/modify ExuluContext definitions (developer task)
- User wants to insert/update/delete items (use appropriate APIs)
- User's question is unrelated to data retrieval
- User wants to configure embedders/processors/sources
