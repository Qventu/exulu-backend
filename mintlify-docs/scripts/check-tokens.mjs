// Verifies mockups/tokens.css values still match the canonical CI sources.
import { readFileSync } from "node:fs";

const tokens = readFileSync(new URL("../mockups/tokens.css", import.meta.url), "utf8");
const website = readFileSync("../exulu-website/web/app/globals.css", "utf8");
const reskin = readFileSync("../backend/releases/_build/reskin-videos-prep.mjs", "utf8");

const mustMatchWebsite = ["#f8f6f1", "#efece4", "#e4ddd0", "#cef79e", "#222f30", "#1b1714"];
const mustMatchReskin = ["#6f9a37", "#8fbf4d", "#fbfaf7", "#241f1a", "#55504a", "#6b6560", "#9b948d"];

let fail = 0;
for (const hex of mustMatchWebsite) {
  if (!tokens.includes(hex)) { console.error(`tokens.css missing ${hex}`); fail = 1; }
  if (!website.toLowerCase().includes(hex)) { console.error(`WEBSITE DRIFT: ${hex} no longer in exulu-website globals.css`); fail = 1; }
}
for (const hex of mustMatchReskin) {
  if (!tokens.includes(hex)) { console.error(`tokens.css missing ${hex}`); fail = 1; }
  if (!reskin.toLowerCase().includes(hex)) { console.error(`RESKIN DRIFT: ${hex} not in reskin-videos-prep.mjs`); fail = 1; }
}
if (fail) process.exit(1);
console.log("tokens.css matches website CI + reskin map.");
