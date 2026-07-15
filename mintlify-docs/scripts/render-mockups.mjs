// Renders every mockup composition to committed docs assets.
// PNG:  images/screens/<slug>.png  — poster frame at 2x (via landscape-4k render + last-frame extraction)
// MP4:  videos/<slug>.mp4          — docs-weight re-encode (only when meta.json has "video": true)
//
// NOTE: the PNG output dir is images/screens/ (NOT images/mockups/) — Mintlify's
// asset server silently excludes any directory named "mockups" (assets 404 and
// `mint broken-links` flags them), so docs assets must not live under that name.
//
// Render asymmetry: PNG path renders at landscape-4k (3840x2160) for a 2x poster;
// video path renders native 1080p because the mp4 is re-encoded to docs weight anyway.
//
// Usage:
//   node scripts/render-mockups.mjs            # all compositions
//   node scripts/render-mockups.mjs my-slug    # single slug

import { execSync } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPS = join(ROOT, "mockups", "compositions");
const IMAGES_OUT = join(ROOT, "images", "screens");
const VIDEOS_OUT = join(ROOT, "videos");

// -- Flags discovered via `npx hyperframes@0.7.42 render --help` --
// render --resolution landscape-4k  →  3840x2160 (integer-2x of 1920x1080 compositions)
// snapshot has no --width / scale flag, so PNG is produced via render + ffmpeg last-frame.
// The --end flag on snapshot defaults to true, but snapshot only renders at 1x; not used here.
const RENDER_PNG_ARGS = "--resolution landscape-4k --quality high";
// For video compositions: standard resolution MP4, then docs-weight re-encode via ffmpeg.
const RENDER_VIDEO_ARGS = "--quality high";

const only = process.argv[2]; // optional single slug

// -- Step 0: verify ffmpeg is available --
try {
  execSync("ffmpeg -version", { stdio: "pipe" });
} catch {
  console.error("BLOCKED: ffmpeg not found on PATH. Install ffmpeg and retry.");
  process.exit(1);
}

// -- Step 1: check kit copies are not drifted --
console.log("Checking kit copies…");
try {
  execSync("node scripts/sync-kit.mjs --check", { cwd: ROOT, stdio: "inherit" });
} catch {
  // sync-kit --check already printed the DRIFT lines; just exit.
  process.exit(1);
}

// -- Step 2: discover compositions --
if (!existsSync(COMPS)) {
  console.log("No mockups/compositions/ directory found — nothing to render.");
  process.exit(0);
}

const allEntries = readdirSync(COMPS);
const slugs = allEntries.filter((d) => {
  if (d.startsWith(".")) return false;
  if (only && d !== only) return false;
  const dir = join(COMPS, d);
  if (!statSync(dir).isDirectory()) return false;
  const hasIndex = existsSync(join(dir, "index.html"));
  const hasMeta = existsSync(join(dir, "meta.json"));
  if (!hasIndex || !hasMeta) {
    console.warn(`WARN: skipping ${d} — missing index.html or meta.json`);
    return false;
  }
  return true;
});

if (slugs.length === 0) {
  console.log(only ? `No composition found for slug: ${only}` : "No compositions to render.");
  process.exit(0);
}

mkdirSync(IMAGES_OUT, { recursive: true });
mkdirSync(VIDEOS_OUT, { recursive: true });

// -- Step 3: render each composition --
for (const slug of slugs) {
  const dir = join(COMPS, slug);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  console.log(`\n— ${slug}`);

  // 3a. PNG poster at 2x: render landscape-4k → extract last frame via ffmpeg
  const rawMp4 = join(dir, "renders", `${slug}_raw.mp4`);
  const pngOut = join(IMAGES_OUT, `${slug}.png`);
  mkdirSync(join(dir, "renders"), { recursive: true });

  console.log(`  rendering 2x MP4 for PNG extraction…`);
  execSync(
    `npx --yes hyperframes@0.7.42 render ${RENDER_PNG_ARGS} --output "${rawMp4}"`,
    { cwd: dir, stdio: "inherit" }
  );
  if (!existsSync(rawMp4)) {
    throw new Error(`render produced no output at ${rawMp4}`);
  }

  console.log(`  extracting last frame → ${pngOut}`);
  // CONVENTION: every composition must hold its final settled state for >=0.3s
  // at the timeline end (data-duration). This -sseof -0.1 grab lands in that hold.
  // Animations that end mid-motion will produce a blurry/in-flight PNG poster.
  execSync(
    `ffmpeg -y -sseof -0.1 -i "${rawMp4}" -frames:v 1 -q:v 2 "${pngOut}"`,
    { stdio: "inherit" }
  );
  if (!existsSync(pngOut)) {
    throw new Error(`ffmpeg produced no PNG at ${pngOut}`);
  }
  // Clean up the intermediate raw render
  rmSync(rawMp4);

  // 3b. MP4 (only when meta.video === true)
  if (meta.video) {
    const rawVideoMp4 = join(dir, "renders", `${slug}_video_raw.mp4`);
    const mp4Out = join(VIDEOS_OUT, `${slug}.mp4`);

    console.log(`  rendering video MP4…`);
    execSync(
      `npx --yes hyperframes@0.7.42 render ${RENDER_VIDEO_ARGS} --output "${rawVideoMp4}"`,
      { cwd: dir, stdio: "inherit" }
    );
    if (!existsSync(rawVideoMp4)) {
      throw new Error(`render produced no video output at ${rawVideoMp4}`);
    }

    // docs-weight re-encode, mirrors releases/_build/encode-all.sh
    console.log(`  re-encoding → ${mp4Out}`);
    execSync(
      `ffmpeg -y -i "${rawVideoMp4}" -an -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -crf 27 -preset veryslow -movflags +faststart "${mp4Out}"`,
      { stdio: "inherit" }
    );
    if (!existsSync(mp4Out)) {
      throw new Error(`ffmpeg re-encode produced no output at ${mp4Out}`);
    }
    rmSync(rawVideoMp4);
  }

  // Clean up composition-local renders directory
  rmSync(join(dir, "renders"), { recursive: true, force: true });

  console.log(`  done: ${slug}`);
}

console.log("\nrender-mockups: complete.");
