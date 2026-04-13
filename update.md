# FTS Index Update for Items Table

## Changes

Added multi-language full-text search (FTS) index to the items table in `src/exulu/context.ts:createItemsTable()`.

## What Was Added

- **Generated tsvector column** (`fts`) that indexes combined `name`, `description`, and `external_id` fields
- **Multi-language support** for English and German (configurable via `configuration.languages`)
- **Normalized text variants** to support fuzzy matching (e.g., "FST_2XT" matches "FST2XT")
  - Removes underscores, hyphens, and spaces from `name` and `external_id` using `regexp_replace`
- **GIN index** on the `fts` column for efficient full-text search

## Migration for Existing Tables

To add this index to an existing items table:

```sql
-- Replace {table_name} with your actual table name
ALTER TABLE {table_name}
ADD COLUMN fts tsvector GENERATED ALWAYS AS (
  to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(external_id, '') || ' ' || regexp_replace(coalesce(name, ''), '[_\-\s]+', '', 'g') || ' ' || regexp_replace(coalesce(external_id, ''), '[_\-\s]+', '', 'g')) ||
  to_tsvector('german', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(external_id, '') || ' ' || regexp_replace(coalesce(name, ''), '[_\-\s]+', '', 'g') || ' ' || regexp_replace(coalesce(external_id, ''), '[_\-\s]+', '', 'g'))
) STORED;

CREATE INDEX {table_name}_fts_gin_idx ON {table_name} USING gin(fts);
```

## Benefits

- Enables fast full-text search on item metadata
- Supports fuzzy matching for technical identifiers and product codes
- Automatically maintained by PostgreSQL (no manual updates needed)
- Single index solution (no need for separate trigram indexes)
