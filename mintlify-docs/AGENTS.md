# IMP Docs — conventions

- Product name is "IMP". Exulu = company, footer only. Never client names (see spec).
- Navigation lives ONLY in docs.json. New page ⇒ add to its tab's group.
- UI pages start with the RightsCallout snippet (snippets/rights-callout.mdx).
- Terminology: Knowledge (contexts/items), Routines, Transcripts, Users & access, Theme.
- Mockups: edit mockups/compositions/<slug>/, run `npm run mockups` to re-render
  images/ and videos/. Never hand-edit rendered PNGs/MP4s.
- Generated files: api-reference/graphql/schema.graphql (`npm run sdl`),
  changelog/index.mdx (`npm run changelog`). Regenerate, don't hand-edit.
- Gates before push: `mint validate && mint broken-links` plus `npm run check`
  inside any touched mockup composition.
