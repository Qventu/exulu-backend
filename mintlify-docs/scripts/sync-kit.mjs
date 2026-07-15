// Syncs the canonical mockup workspace (mockups/tokens.css, fonts.css, fonts/,
// kit/) into every composition under mockups/compositions/.
//
// Why copies instead of links: hyperframes lint rejects "../" asset paths and
// the Studio preview server serves only real files inside the project dir
// (symlinks 404). The single source of truth stays at mockups/ — edit there,
// then run:  npm run sync-kit
//
// --check mode: compare each composition's copied files against canonical
// sources by content hash; on any mismatch prints DRIFT lines and exits 1.
import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mockups = join(root, "mockups");
const compsDir = join(mockups, "compositions");

const kitFiles = readdirSync(join(mockups, "kit")).filter((f) => f.endsWith(".css") || f.endsWith(".js"));
const fontFiles = readdirSync(join(mockups, "fonts")).filter((f) => f.endsWith(".woff2"));

const targets = readdirSync(compsDir).filter((d) => {
  const p = join(compsDir, d);
  return statSync(p).isDirectory() && existsSync(join(p, "index.html"));
});

const checkMode = process.argv.includes("--check");

function hash(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

if (checkMode) {
  let drifted = false;

  for (const comp of targets) {
    const dest = join(compsDir, comp);

    const rootFiles = [
      { src: join(mockups, "tokens.css"), dest: join(dest, "tokens.css"), rel: "tokens.css" },
      { src: join(mockups, "fonts.css"), dest: join(dest, "fonts.css"), rel: "fonts.css" },
    ];
    for (const { src, dest: d, rel } of rootFiles) {
      if (!existsSync(d) || hash(src) !== hash(d)) {
        console.log(`DRIFT: ${comp}/${rel} differs from canonical ${rel}`);
        drifted = true;
      }
    }

    for (const f of fontFiles) {
      const src = join(mockups, "fonts", f);
      const d = join(dest, "fonts", f);
      if (!existsSync(d) || hash(src) !== hash(d)) {
        console.log(`DRIFT: ${comp}/fonts/${f} differs from canonical fonts/${f}`);
        drifted = true;
      }
    }

    for (const f of kitFiles) {
      const src = join(mockups, "kit", f);
      const d = join(dest, "kit", f);
      if (!existsSync(d) || hash(src) !== hash(d)) {
        console.log(`DRIFT: ${comp}/kit/${f} differs from canonical kit/${f}`);
        drifted = true;
      }
    }
  }

  if (drifted) {
    process.exit(1);
  } else {
    console.log("sync-kit check: all copies match canonical.");
  }
} else {
  for (const comp of targets) {
    const dest = join(compsDir, comp);
    copyFileSync(join(mockups, "tokens.css"), join(dest, "tokens.css"));
    copyFileSync(join(mockups, "fonts.css"), join(dest, "fonts.css"));
    mkdirSync(join(dest, "fonts"), { recursive: true });
    for (const f of fontFiles) copyFileSync(join(mockups, "fonts", f), join(dest, "fonts", f));
    mkdirSync(join(dest, "kit"), { recursive: true });
    for (const f of kitFiles) copyFileSync(join(mockups, "kit", f), join(dest, "kit", f));
    console.log(`synced kit -> mockups/compositions/${comp}`);
  }
  if (!targets.length) console.log("no compositions found under mockups/compositions/");
}
