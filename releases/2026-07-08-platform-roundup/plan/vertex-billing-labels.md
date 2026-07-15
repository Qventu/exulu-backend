# Feature plan — Vertex billing labels (PROSE + snippet)

## Sources of truth

- Spec: `docs/superpowers/specs/2026-05-22-vertex-billing-labels-design.md`
- Code: `src/templates/providers/google/vertex/labels.ts` (`buildLabels`,
  `createLabeledFetch`, sanitizers), wired into all Vertex providers in
  `src/templates/providers/google/vertex/index.ts`
- Commit: `2621c1d`

## What shipped

Every Vertex `generateContent` request now carries Google Cloud **billing
labels**, injected by a custom `fetch` that mutates the JSON body before it
leaves the box. Labels emitted (all sanitized to GCP's charset/length rules):
`provider_id`, `provider_name`, and — when known — `user_id`, `role_id`,
`project_id`, `agent_id`. Result: GCP cost reports can attribute Vertex spend
per provider, user, role, project, and agent, with no proxy in the data path.

The wrapper is deliberately paranoid: any decode/parse failure forwards the
original request unmodified — **a billing label can never break a model call**.
Only numeric/opaque IDs are sent; no emails or names reach GCP.

## Hook

**"Your GCP invoice now knows which agent spent what."**

## Surface area

Infra/cost feature (recipe D), prose-only. Audience: enterprise/finance-minded
operators on Vertex.

## Page prose plan (2 paragraphs)

1. The gap: Vertex spend was one undifferentiated line in Cloud Billing;
   internal analytics could slice it, the invoice couldn't.
2. The fix: six labels on every call, best-effort by design, visible in Cloud
   Billing reports (~24h lag). Pair with the LiteLLM-side tagging for the
   in-product view; this one is for the bill itself.

## Code snippet — EARNED (payload-style, JSON)

What the mutated Vertex request body carries (keys verbatim from
`buildLabels`; values illustrative, post-sanitization):

```json
{
  "contents": [ "..." ],
  "labels": {
    "provider_id": "default_vertex_gemini_2_5_flash_provider",
    "provider_name": "gemini-2-5-flash",
    "user_id": "42",
    "role_id": "f3a91c",
    "project_id": "7d20b4",
    "agent_id": "9c51e8"
  }
}
```

Label on page: "Injected into every Vertex generateContent call".
