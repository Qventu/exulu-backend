// One-off migration: rewrites agents.tools JSON from the v3 agentic-retrieval
// config format (flat ${ctx}_|_* keys) to the pipeline format (json options).
// Usage: npx tsx scripts/migrate-agentic-retrieval-config.ts [--dry-run]
import { postgresClient } from "../src/postgres/client";
import { migrateAgenticToolConfig, type SavedTool } from "../src/utils/migrate-agentic-retrieval-config";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { db } = await postgresClient();
  const agents = await db.from("agents").select(["id", "name", "tools"]);
  let migrated = 0;
  for (const agent of agents) {
    const tools: SavedTool[] = typeof agent.tools === "string" ? JSON.parse(agent.tools) : agent.tools;
    if (!Array.isArray(tools)) continue;
    let changed = false;
    const next = tools.map((tool) => {
      const m = migrateAgenticToolConfig(tool);
      if (m) changed = true;
      return m ?? tool;
    });
    if (!changed) continue;
    migrated++;
    console.log(`${dryRun ? "[dry-run] would migrate" : "migrating"} agent ${agent.id} (${agent.name})`);
    if (!dryRun) await db.from("agents").where({ id: agent.id }).update({ tools: JSON.stringify(next) });
  }
  console.log(`${dryRun ? "[dry-run] " : ""}done — ${migrated} agent(s) ${dryRun ? "would be" : ""} migrated.`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
