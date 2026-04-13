# ExuluContext Catalog

This file contains information about all discovered ExuluContext instances in the database.
Last updated: 2026-04-09

**IMPORTANT:** Context IDs are in camelCase, not snake_case!

## techDoc

**Context ID:** `techDoc` (use this exact ID for vectorization and queries)

**Description:** Technical documentation for elevator/lift equipment and components (German language manuals, specifications, regulations, product datasheets)

**Tables:**
- Items: techDoc_items
- Chunks: techDoc_chunks

**Statistics:**
- Total items: 4844
- Items with embeddings: 4839
- Average chunks per item: 12.49

**Custom Fields:**
- type (text)
- last_modified_s3 (timestamp)
- document_s3key (text)
- markdown_s3key (text)

**Notes:**
- Primary language: German
- Contains PDFs of technical manuals, operating instructions, product specifications
- Has embeddings - hybrid search available

---

## vorschriften

**Context ID:** `vorschriften` (use this exact ID for vectorization and queries)

**Description:** Regulations and standards (EN, DIN standards for elevators and lifts)

**Tables:**
- Items: vorschriften_items
- Chunks: vorschriften_chunks

**Statistics:**
- Total items: 355
- Items with embeddings: 327
- Average chunks per item: 33.26

**Notes:**
- Primary language: German
- Contains regulatory documents and safety standards
- Has embeddings - hybrid search available

---

## Other Available Contexts

The following contexts exist but need detailed descriptions:

- **newtonMemory** - Newton memory context
- **softwareDocumentation** - Software documentation
- **zendesk** - Zendesk support tickets
- **newServicedb** - Service database
- **redmine** - Redmine issues

To add descriptions for these contexts, run discovery and ask the user about each one.
