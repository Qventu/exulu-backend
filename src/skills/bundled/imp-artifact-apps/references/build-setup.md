# Building a bigger app to one file (Vite + React)

For apps with several screens, components or a UI library, keep a normal Vite
project and build it to a single HTML file. The Tender cockpit uses exactly this.

```
npm create vite@latest my-app -- --template react-ts
npm i -D vite-plugin-singlefile
```

`vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// The artifact runs as an about:srcdoc document: a classic inline script, not a
// module. Strip type="module" (and the meaningless crossorigin) from the
// inlined tag; rollup's iife output makes the bundle valid as a classic script.
function classicScriptTag() {
  return {
    name: "classic-script-tag",
    enforce: "post" as const,
    transformIndexHtml: (html: string) =>
      html.replace(/<script\b[^>]*>/g, (tag) =>
        tag.replace(/\s+type="module"/g, "").replace(/\s+crossorigin(?:="[^"]*")?/g, "")),
  };
}

export default defineConfig({
  plugins: [react(), viteSingleFile(), classicScriptTag()],
  build: {
    assetsInlineLimit: 100_000_000, // inline every asset; a separate file cannot load
    cssCodeSplit: false,
    target: "es2020",
    rollupOptions: { output: { format: "iife", inlineDynamicImports: true } },
  },
});
```

`src/main.tsx` — mount when the document is ready. The bundle is inlined into
`<head>`, ahead of `<div id="root">`, and a classic script is not deferred:

```ts
function mount() {
  const el = document.getElementById("root");
  if (!el) throw new Error("mount point #root missing");
  createRoot(el).render(<App />);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
```

Copy `templates/imp-channel.ts` into `src/lib/` as-is — don't port the
handshake out of `templates/app.html` by hand, and don't re-derive it; see
`references/identity-handshake.md` for the full channel (identity plus the
agent panel) `connectImp` implements. Port `client` from `templates/app.html`
into `src/lib/` as its own TypeScript module (it has no v2 counterpart to
copy), construct **one** client at the top level once `connectImp` resolves,
and pass it down. `App` renders three states: connecting, blocked (handshake
denied or timed out — "reload the IMP tab"), ready.

Check the build before publishing:

```sh
test "$(ls dist/*.html | wc -l)" -eq 1 || echo "more than one html file"
grep -c '<script src=' dist/index.html      # must be 0
grep -c 'type="module"' dist/index.html     # must be 0
```

Tailwind, shadcn and Radix work; keep the bundle in the low megabytes — the
viewer fetches the whole file on every open.
