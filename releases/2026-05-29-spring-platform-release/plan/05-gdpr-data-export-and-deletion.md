# 05 — GDPR data export and deletion

**Spec:** `docs/superpowers/specs/2026-05-26-gdpr-data-export-and-deletion-design.md`
**Slot:** Fifth — compliance closer. Sets the trust note for the release footer.

## Hook
**Article 15 and Article 17, in two HTTP calls.** Super-admin endpoints to export or hard-delete any user's data footprint — Postgres + S3 — in a single request.

## Surface area
Backend REST feature. Pure API. Use Recipe **E** (compliance — measured, no bouncy motion).

## Code snippet
**Yes** — two `curl` blocks. Pulled from the actual routes in `src/exulu/routes.ts:2594` and `src/exulu/routes.ts:2691`. Showing two block side by side in the page copy.

## Demo arc (1 slice, ~9s, 1920x1080 + 1080x1920)
Pattern: terminal + receipt artifact. Calm easing throughout (`power2.out`, never `back.out`). More whitespace than the other shorts.

1. Hook fades in: **"GDPR, by the line."** (calm entrance)
2. Cut to a clean terminal pane with the prompt. The `curl` command types in:
   ```
   curl -H "Authorization: Bearer $TOKEN" \
        https://api.exulu.com/users/42/data-export -o user-42-export.zip
   ```
3. **Hold 600ms** after typing completes.
4. Below the terminal, a small "downloaded file" artifact slides in: a zip icon labeled `user-42-export-2026-05-29.zip` with a quiet list of contents underneath: `user_data.json`, `sessions.json`, `feedback.json`, `prompt_favorites.json`, `tracking.json`, `README.txt`.
5. **Hold 800ms.**
6. The terminal text fades to a second command:
   ```
   curl -X DELETE -H "Authorization: Bearer $TOKEN" \
        https://api.exulu.com/users/42
   ```
7. A "204 No Content" badge fades in beside it in `--muted-foreground`.
8. **Hold 600ms.**
9. Payoff caption fades in below: **"Export. Delete. Done."**

### Pacing budget
- 0.0–0.4: hook entrance (slow `power2.out`)
- 0.4–1.8: hook holds (1.4s)
- 1.8–2.2: pivot to terminal
- 2.2–3.6: first curl types in (slower than usual; reads as deliberate)
- 3.6–4.2: **breath** (600ms)
- 4.2–5.2: zip artifact slides in, file list fades in stagger
- 5.2–6.0: **breath** (800ms)
- 6.0–6.8: terminal fades to second curl
- 6.8–7.2: 204 badge fades in
- 7.2–7.8: **breath** (600ms)
- 7.8–8.2: payoff fades in
- 8.2–9.0: payoff holds (0.8s) — short, calm rest

## Curl snippets for the page copy
```bash
# Export — DSGVO Art. 15
curl -H "Authorization: Bearer $TOKEN" \
     https://api.exulu.com/users/42/data-export \
     -o user-42-export.zip
```

```bash
# Delete — DSGVO Art. 17
curl -X DELETE \
     -H "Authorization: Bearer $TOKEN" \
     https://api.exulu.com/users/42
```

## Visual brand notes
- Terminal: dark `hsl(0 0% 4%)` background, JetBrains Mono, generous padding, small chrome dots top-left.
- Zip artifact card: light card on `--card`, soft shadow, `--border` outline, zip glyph in `--primary`.
- Payoff: smaller font size than the other shorts. Compliance reads quieter, not louder.
- No `back.out`. Easing only `power2.out` / `power2.inOut`.
