#!/usr/bin/env node
/**
 * verify-sdl-blocks.mjs
 *
 * For every MDX file under api-reference/graphql/core-types/, extract every
 * fenced ```graphql block that begins with `type ` and assert that the block
 * appears VERBATIM in api-reference/graphql/schema.graphql (normalising only
 * trailing whitespace on each line and stripping a final blank line).
 *
 * Exit 0 with "<n>/<n> pages match" on success.
 * Exit 1 with details on the first mismatch.
 */

import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(__dirname, "..");

const schemaPath = join(docsRoot, "api-reference/graphql/schema.graphql");
const coreTypesDir = join(docsRoot, "api-reference/graphql/core-types");

const schemaText = readFileSync(schemaPath, "utf8");

/**
 * Normalise a SDL block: trim trailing whitespace on every line, then trim
 * the whole string (removes a trailing newline that fences would add).
 */
function normalise(text) {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/**
 * Extract all ```graphql … ``` blocks from MDX text whose first content line
 * starts with "type ".
 */
function extractTypeBlocks(mdxText) {
  const blocks = [];
  const fence = /^```graphql\n([\s\S]*?)^```/gm;
  let match;
  while ((match = fence.exec(mdxText)) !== null) {
    const body = match[1];
    if (body.trimStart().startsWith("type ")) {
      blocks.push(body);
    }
  }
  return blocks;
}

const mdxFiles = readdirSync(coreTypesDir)
  .filter((f) => f.endsWith(".mdx"))
  .sort();

let passed = 0;
let failed = 0;
const failures = [];

for (const filename of mdxFiles) {
  const mdxPath = join(coreTypesDir, filename);
  const mdxText = readFileSync(mdxPath, "utf8");
  const blocks = extractTypeBlocks(mdxText);

  if (blocks.length === 0) {
    // Page has no `type ` graphql block — count as a failure so we notice
    failed++;
    failures.push({ filename, reason: "No `type ` graphql block found" });
    continue;
  }

  let pageOk = true;
  for (const block of blocks) {
    const normBlock = normalise(block);
    const normSchema = normalise(schemaText);
    if (!normSchema.includes(normBlock)) {
      pageOk = false;
      failures.push({
        filename,
        reason: `SDL block not found verbatim in schema.graphql`,
        block: normBlock.slice(0, 300) + (normBlock.length > 300 ? "…" : ""),
      });
    }
  }

  if (pageOk) {
    passed++;
  } else {
    failed++;
  }
}

const total = passed + failed;
console.log(`\n${passed}/${total} pages match\n`);

if (failures.length > 0) {
  console.error("Failures:");
  for (const f of failures) {
    console.error(`  ✗ ${f.filename}: ${f.reason}`);
    if (f.block) {
      console.error(`    Block preview:\n      ${f.block.replace(/\n/g, "\n      ")}`);
    }
  }
  process.exit(1);
}

process.exit(0);
