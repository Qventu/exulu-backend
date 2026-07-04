# Agentic Retrieval Wizard (Frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat agentic-retrieval config card in the agent editor's Knowledge section with a guided six-step wizard + summary card that reads/writes the pipeline tool's new config format (5 `json` options + 6 flat options), per spec §4.

**Architecture:** A pure config module (`config-schema.ts`, zod parse/serialize between the saved `{name, variable, type}[]` entries and a typed `WizardConfig` draft) carries all logic and is unit-tested; the wizard is a Sheet with a hand-rolled step state machine (house pattern) editing that draft in memory; Finish serializes back into the staged `editor.setTools` state — persistence stays the page SaveBar → `UpdateAgentEditor` mutation. The Knowledge section shows a summary card whose edit buttons deep-link into wizard steps.

**Tech Stack:** Next.js 16 / React 19, shadcn/radix primitives (`components/ui/*`), next-intl, zod 3, Apollo (existing queries only — no new API), vitest (node env, pure-module tests).

**Spec:** `docs/superpowers/specs/2026-07-03-agentic-retrieval-pipeline-design.md` §4 (this repo). This is plan 2 of 3; plan 1 (backend) is merged — the config shapes below are copied from the shipped `ee/agentic-retrieval/pipeline/config.ts` and `pipeline/index.ts`.

## Global Constraints

- Target repo: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend` (execution happens in a worktree of THAT repo; all paths below are relative to its root).
- Tool id `agentic_context_search`. Its declared config (from the backend `tools` GraphQL query) is exactly 11 options — flat: `instructions` (string), `reranker` (string), `managed_context` (boolean), `require_preselected_contexts` (boolean), `logging` (boolean), `utility_model` (string); json: `knowledge_bases`, `routing`, `vocabulary`, `memory`, `tuning`.
- Saved-value conventions on `agent.tools[].config[].variable` (the chat runtime depends on them — `app/(application)/chat/hooks.ts` reads `managed_context`'s `variable === "true"`): booleans as `"true"`/`"false"` strings; strings raw; **json values as `JSON.stringify`'d strings**.
- Backend json shapes and defaults (verbatim from `exulu/backend/ee/agentic-retrieval/pipeline/config.ts`):
  - kb profile: `{ enabled: boolean=true, kind: "documents"|"conversations"|"records"="documents", instructions: string="", overrides: { limit?: int>0, expand?: int>=0, multiQuery?: boolean, hyde?: boolean } }`, keyed by context id; **a context missing from the map = enabled documents**; disabling requires an explicit `{ enabled: false }` entry.
  - routing: `{ rules: [{ id, label, description, main: string[], fallback: string[] }] }`; no rules = search all enabled.
  - vocabulary: `{ glossary: [{term, meaning}], identifiers: [{name, description, examples: string[], strategy: "fuzzy"|"exact", contexts: string[]}], rewrites: [{find, replace}], styleHint: string }`.
  - memory: `{ enabled: true, override: false, filePrioritization: false, queryAugmentation: true }`.
  - tuning: `{ topK: 5, fallbackThreshold: 0.95, pinBoost: 0.15, identifierBoost: 0.15, pageWindow: 1, maxQueriesPerContext: 5 }`.
  - KIND_PRESETS (shown as explainer copy, not sent): documents `{limit 100, expand 7, multiQuery, hyde}`, conversations `{limit 20, expand 5, keyword prefilter}`, records `{limit 20, expand 2}`.
- The backend parser is tolerant (bad json → defaults), so the wizard MUST round-trip cleanly but MAY receive `""`/garbage in `variable` — parse defensively with zod defaults, never throw.
- ALL user-facing copy via next-intl under `agents.editor.knowledge.*` — every new key added to BOTH `messages/en.json` and `messages/de.json`.
- No new npm dependencies. Reuse `components/ui/*` (sheet, select, switch, slider, input, textarea, badge, accordion, button, command/popover), `RerankerSelector` (`components/reranker-selector.tsx`, props `{disabled, value, onSelect}`), `TextPreview`.
- Tests: vitest node environment (`npx vitest run`), include pattern already covers `app/**/*.test.ts` — pure-module tests only (no DOM). Components are verified by `npx tsc --noEmit` + `npx eslint <changed files>` + the Task 7 manual UAT checklist (spec §7 explicitly scopes frontend testing this way).
- Type-check baseline: run `npx tsc --noEmit` BEFORE your first change and record the existing error count; you must add ZERO new errors.
- The wizard never talks to the backend: reads `refs.agenticRetrievalTool` (declared config) + the staged entries from `editor.tools`, writes via `editor.setTools`. Unsaved-changes tracking and persistence remain the page-level SaveBar.
- Commit after every task with trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

```
app/(application)/agents/edit/[id]/components/knowledge-search/
  config-schema.ts            pure module: WizardConfig types, zod schemas, parse/serialize, summary digest
  config-schema.test.ts       vitest (node) — the TDD core of this plan
  wizard.tsx                  Sheet shell: step machine, draft state, footer nav, apply-on-finish
  steps/knowledge-bases-step.tsx
  steps/routing-step.tsx
  steps/vocabulary-step.tsx
  steps/memory-step.tsx
  steps/behavior-step.tsx
  steps/review-step.tsx
  summary-card.tsx            digest card with per-area edit buttons
Modified:
  app/(application)/agents/edit/[id]/components/tool-config-fields.tsx   (json textarea fallback; ToolConfigEntry union)
  app/(application)/agents/edit/[id]/sections/knowledge.tsx              (summary card + wizard replace flat renderer)
  types/models/tool.ts, types/models/agent.ts                            (add "json" to config type unions)
  messages/en.json, messages/de.json                                     (agents.editor.knowledge.wizard/summary keys)
```

---

### Task 1: `json` config type in frontend types + generic renderer fallback

**Files:**
- Modify: `types/models/tool.ts` (ExuluTool.config type union)
- Modify: `types/models/agent.ts:6-16` (AgentTool.config type union)
- Modify: `app/(application)/agents/edit/[id]/components/tool-config-fields.tsx` (ToolConfigEntry union + json case)

**Interfaces:**
- Produces: `ToolConfigEntry.type` includes `"json"`; `ToolConfigurationElement` renders a raw-JSON `Textarea` for `type: "json"` options (the generic fallback for tools WITHOUT bespoke UI, spec §3.1). Later tasks import `ToolConfigEntry` from this file.

- [ ] **Step 1: Record the tsc baseline**

Run: `npx tsc --noEmit 2>&1 | tail -3` — note the existing error count (may be zero).

- [ ] **Step 2: Widen the type unions**

`types/models/tool.ts` — change the config entry:

```ts
    config: {
        name: string;
        description: string;
        type: "boolean" | "string" | "number" | "variable" | "json";
        default?: string | boolean | number | "variable";
        value?: string; // the exulu variable reference
    }[];
```

`types/models/agent.ts` — change `AgentTool.config`:

```ts
    config: {
        name: string;
        variable: string;
        type: "boolean" | "string" | "number" | "variable" | "json";
    }[];
```

`tool-config-fields.tsx` — change the exported entry type:

```ts
export type ToolConfigEntry = {
  name: string;
  variable: string | boolean | number;
  type: "string" | "number" | "boolean" | "variable" | "json";
};
```

- [ ] **Step 3: Add the json case to the generic renderer**

In `tool-config-fields.tsx`, insert a `case "json":` between `case "boolean":` and `default:` (same card layout as the `string` case, but monospace and with defensive display of object values):

```tsx
          case "json":
            return (
              <div
                key={configIndex}
                className="space-y-2 rounded-md border p-3"
              >
                <div className="text-sm font-medium capitalize">
                  {configItem.name.replace(/_/g, " ")}
                </div>
                {configItem.description && (
                  <TextPreview
                    text={configItem.description}
                    sliceLength={200}
                  />
                )}
                <Textarea
                  disabled={!configEntry}
                  className="font-mono text-xs"
                  rows={6}
                  placeholder={
                    typeof configItem.default === "string"
                      ? configItem.default
                      : JSON.stringify(configItem.default ?? {})
                  }
                  value={
                    typeof currentValue === "object" && currentValue !== null
                      ? JSON.stringify(currentValue, null, 2)
                      : (currentValue as string) || ""
                  }
                  onChange={(e) => update(e.target.value, configItem.name)}
                />
              </div>
            );
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit 2>&1 | tail -3` — same error count as the Step 1 baseline.
Run: `npx eslint "types/models/tool.ts" "types/models/agent.ts" "app/(application)/agents/edit/[id]/components/tool-config-fields.tsx"` — clean (warnings pre-existing in untouched lines are acceptable; no new errors).

- [ ] **Step 5: Commit**

```bash
git add types/models/tool.ts types/models/agent.ts "app/(application)/agents/edit/[id]/components/tool-config-fields.tsx"
git commit -m "feat(agents): json config option type with raw-JSON fallback renderer"
```

---

### Task 2: `config-schema.ts` — parse / serialize / digest (the tested core)

**Files:**
- Create: `app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.ts`
- Test: `app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.test.ts`

**Interfaces:**
- Consumes: `ToolConfigEntry` (Task 1).
- Produces (exact — every wizard component imports from here):

```ts
export type KbKind = "documents" | "conversations" | "records";
export type WizardKbProfile = {
  enabled: boolean; kind: KbKind; instructions: string;
  overrides: { limit?: number; expand?: number; multiQuery?: boolean; hyde?: boolean };
};
export type RoutingRule = { id: string; label: string; description: string; main: string[]; fallback: string[] };
export type IdentifierSet = { name: string; description: string; examples: string[]; strategy: "fuzzy" | "exact"; contexts: string[] };
export type WizardConfig = {
  instructions: string; reranker: string; utilityModel: string;
  managedContext: boolean; requirePreselectedContexts: boolean; logging: boolean;
  knowledgeBases: Record<string, WizardKbProfile>;
  routing: { rules: RoutingRule[] };
  vocabulary: { glossary: { term: string; meaning: string }[]; identifiers: IdentifierSet[];
    rewrites: { find: string; replace: string }[]; styleHint: string };
  memory: { enabled: boolean; override: boolean; filePrioritization: boolean; queryAugmentation: boolean };
  tuning: { topK: number; fallbackThreshold: number; pinBoost: number; identifierBoost: number;
    pageWindow: number; maxQueriesPerContext: number };
};
export const TUNING_DEFAULTS: WizardConfig["tuning"];
export const MEMORY_DEFAULTS: WizardConfig["memory"];
export const KIND_PRESETS: Record<KbKind, { limit: number; expand: number }>;
export function defaultWizardConfig(): WizardConfig;
export function parseWizardConfig(entries: ToolConfigEntry[] | undefined | null): WizardConfig;
export function serializeWizardConfig(cfg: WizardConfig): ToolConfigEntry[]; // exactly 11 entries
export function selectedKbIds(cfg: WizardConfig, allContextIds: string[]): string[]; // enabled per backend semantics (missing = enabled)
export function setKbSelection(cfg: WizardConfig, allContextIds: string[], selected: string[]): WizardConfig; // explicit {enabled:false} for deselected
export function buildSummary(cfg: WizardConfig, allContextIds: string[]): {
  kbCount: number; ruleCount: number; memoryOn: boolean; rerankerLabel: string; glossaryCount: number };
export function ruleIdFromLabel(label: string, existingIds: string[]): string; // slug, de-duped with -2, -3…
```

Implementation notes (bake these in):
- zod schemas mirror the backend Global Constraints shapes with `.default(...)` everywhere; `parseWizardConfig` looks up each of the 11 entry names, coerces flat values (`boolVal`: `v === true || v === "true" || v === 1`; strings via `typeof v === "string" ? v : ""`), and for json values accepts an already-parsed object OR a JSON string OR anything else → `safeParse` → schema defaults on failure. Never throws.
- `serializeWizardConfig` emits all 11 entries in declaration order with correct `type` fields: `instructions`/`reranker`/`utility_model` type `"string"` (raw), `managed_context`/`require_preselected_contexts`/`logging` type `"boolean"` with `"true"`/`"false"` string values, the five json options type `"json"` with `JSON.stringify(...)` values.
- `selectedKbIds(cfg, all)` = ids where `cfg.knowledgeBases[id]?.enabled !== false` (backend semantics: missing = enabled).
- `setKbSelection` returns a NEW cfg: selected ids get their existing profile or `{ enabled: true, kind: "documents", instructions: "", overrides: {} }`; deselected ids get `{ ...existingOrDefault, enabled: false }` (preserving kind/instructions so re-selecting restores them).
- `ruleIdFromLabel("Technical questions", [])` → `"technical-questions"` (lowercase, non-alphanumerics → `-`, trimmed); collision → suffix `-2`, `-3`, …
- `buildSummary`: `kbCount` = `selectedKbIds(...).length`; `ruleCount` = rules length; `memoryOn` = `cfg.memory.enabled`; `rerankerLabel` = `cfg.reranker === "none" || !cfg.reranker ? "" : cfg.reranker`; `glossaryCount` = glossary length.
- `KIND_PRESETS` here holds only `{limit, expand}` per kind — display copy for the KB step's explainers.

- [ ] **Step 1: Write the failing test**

```ts
// app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.test.ts
import { describe, test, expect } from "vitest";
import {
  defaultWizardConfig, parseWizardConfig, serializeWizardConfig,
  selectedKbIds, setKbSelection, buildSummary, ruleIdFromLabel,
} from "./config-schema";
import type { ToolConfigEntry } from "../tool-config-fields";

const entry = (name: string, variable: any, type: any): ToolConfigEntry => ({ name, variable, type });

describe("parseWizardConfig", () => {
  test("returns full defaults for empty/missing entries", () => {
    const cfg = parseWizardConfig(undefined);
    expect(cfg.tuning).toEqual({ topK: 5, fallbackThreshold: 0.95, pinBoost: 0.15,
      identifierBoost: 0.15, pageWindow: 1, maxQueriesPerContext: 5 });
    expect(cfg.memory).toEqual({ enabled: true, override: false, filePrioritization: false, queryAugmentation: true });
    expect(cfg.routing.rules).toEqual([]);
    expect(cfg.knowledgeBases).toEqual({});
    expect(cfg.reranker).toBe("none");
    expect(cfg.managedContext).toBe(false);
  });

  test("parses saved entries: booleans as strings, json as strings or objects", () => {
    const cfg = parseWizardConfig([
      entry("managed_context", "true", "boolean"),
      entry("instructions", "be careful", "string"),
      entry("tuning", '{"topK":8}', "json"),
      entry("knowledge_bases", { docs: { enabled: false } }, "json"),
    ]);
    expect(cfg.managedContext).toBe(true);
    expect(cfg.instructions).toBe("be careful");
    expect(cfg.tuning.topK).toBe(8);
    expect(cfg.tuning.fallbackThreshold).toBe(0.95); // partial json keeps defaults
    expect(cfg.knowledgeBases.docs.enabled).toBe(false);
    expect(cfg.knowledgeBases.docs.kind).toBe("documents"); // schema default fills in
  });

  test("never throws on garbage values", () => {
    const cfg = parseWizardConfig([
      entry("routing", "{oops", "json"),
      entry("vocabulary", 42, "json"),
      entry("memory", null as any, "json"),
      entry("logging", "banana", "boolean"),
    ]);
    expect(cfg.routing.rules).toEqual([]);
    expect(cfg.vocabulary.glossary).toEqual([]);
    expect(cfg.memory.enabled).toBe(true);
    expect(cfg.logging).toBe(false);
  });
});

describe("serializeWizardConfig", () => {
  test("emits exactly 11 entries with the platform value conventions", () => {
    const cfg = defaultWizardConfig();
    cfg.managedContext = true;
    cfg.tuning.topK = 7;
    const entries = serializeWizardConfig(cfg);
    expect(entries).toHaveLength(11);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName["managed_context"]).toEqual({ name: "managed_context", variable: "true", type: "boolean" });
    expect(byName["logging"].variable).toBe("false");
    expect(byName["tuning"].type).toBe("json");
    expect(JSON.parse(byName["tuning"].variable as string).topK).toBe(7);
    expect(byName["knowledge_bases"].variable).toBe("{}");
  });

  test("round-trips: parse(serialize(cfg)) === cfg", () => {
    const cfg = defaultWizardConfig();
    cfg.knowledgeBases = { docs: { enabled: true, kind: "conversations", instructions: "tickets", overrides: { limit: 30 } } };
    cfg.routing.rules = [{ id: "tech", label: "Tech", description: "d", main: ["docs"], fallback: [] }];
    cfg.vocabulary.glossary = [{ term: "FST", meaning: "controller" }];
    cfg.reranker = "rerank-v4";
    expect(parseWizardConfig(serializeWizardConfig(cfg))).toEqual(cfg);
  });
});

describe("KB selection semantics (backend parity: missing = enabled)", () => {
  const all = ["a", "b", "c"];
  test("selectedKbIds treats missing profiles as enabled", () => {
    const cfg = defaultWizardConfig();
    cfg.knowledgeBases = { b: { enabled: false, kind: "documents", instructions: "", overrides: {} } };
    expect(selectedKbIds(cfg, all)).toEqual(["a", "c"]);
  });
  test("setKbSelection writes explicit enabled:false and preserves profiles on re-select", () => {
    let cfg = defaultWizardConfig();
    cfg.knowledgeBases = { a: { enabled: true, kind: "records", instructions: "x", overrides: {} } };
    cfg = setKbSelection(cfg, all, ["b"]);
    expect(cfg.knowledgeBases.a.enabled).toBe(false);
    expect(cfg.knowledgeBases.a.kind).toBe("records"); // preserved for re-selection
    expect(cfg.knowledgeBases.b.enabled).toBe(true);
    cfg = setKbSelection(cfg, all, ["a", "b"]);
    expect(cfg.knowledgeBases.a).toMatchObject({ enabled: true, kind: "records", instructions: "x" });
  });
});

describe("helpers", () => {
  test("ruleIdFromLabel slugs and de-dupes", () => {
    expect(ruleIdFromLabel("Technical questions!", [])).toBe("technical-questions");
    expect(ruleIdFromLabel("Tech", ["tech"])).toBe("tech-2");
    expect(ruleIdFromLabel("Tech", ["tech", "tech-2"])).toBe("tech-3");
  });
  test("buildSummary digests the config", () => {
    const cfg = defaultWizardConfig();
    cfg.knowledgeBases = { b: { enabled: false, kind: "documents", instructions: "", overrides: {} } };
    cfg.routing.rules = [{ id: "r", label: "R", description: "", main: [], fallback: [] }];
    cfg.reranker = "none";
    const s = buildSummary(cfg, ["a", "b"]);
    expect(s).toEqual({ kbCount: 1, ruleCount: 1, memoryOn: true, rerankerLabel: "", glossaryCount: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `config-schema.ts`** per the Interfaces block and implementation notes. The zod schemas are direct transcriptions of the backend shapes in Global Constraints (all fields `.default(...)`; `knowledgeBases` via `z.record(z.string(), kbProfileSchema)` defaulting to `{}`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.test.ts"`
Expected: PASS (9 tests). Also `npx tsc --noEmit` — baseline unchanged.

- [ ] **Step 5: Commit**

```bash
git add "app/(application)/agents/edit/[id]/components/knowledge-search/"
git commit -m "feat(agents): knowledge-search wizard config schema with round-trip parsing"
```

---

### Task 3: Wizard shell + Knowledge-bases step

**Files:**
- Create: `app/(application)/agents/edit/[id]/components/knowledge-search/wizard.tsx`
- Create: `app/(application)/agents/edit/[id]/components/knowledge-search/steps/knowledge-bases-step.tsx`

**Interfaces:**
- Consumes: Task 2 exports; `ToolConfigEntry`; `refs.contexts` shape `{ id: string; name: string; description?: string }[]`.
- Produces:

```ts
// wizard.tsx
export type WizardStepId = "sources" | "routing" | "vocabulary" | "memory" | "behavior" | "review";
export const WIZARD_STEPS: WizardStepId[]; // in order
export function KnowledgeSearchWizard(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialStep?: WizardStepId;
  entries: ToolConfigEntry[];                 // current staged config entries
  contexts: { id: string; name: string; description?: string }[];
  memoryContextId: string;                     // editor.memory ("" = none)
  onApply: (entries: ToolConfigEntry[]) => void;
}): JSX.Element;

// steps/knowledge-bases-step.tsx
export function KnowledgeBasesStep(props: {
  draft: WizardConfig;
  setDraft: (updater: (prev: WizardConfig) => WizardConfig) => void;
  contexts: { id: string; name: string; description?: string }[];
}): JSX.Element;
```

- [ ] **Step 1: Implement `wizard.tsx`**

```tsx
"use client";

/**
 * KnowledgeSearchWizard — guided configuration for the agentic_context_search
 * tool (spec §4). Sheet + hand-rolled step machine (house pattern: see
 * add-user-dialog.tsx). Edits a WizardConfig draft in memory; Finish
 * serializes to config entries via onApply. Never talks to the backend.
 */

import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import type { ToolConfigEntry } from "../tool-config-fields";
import {
  parseWizardConfig, serializeWizardConfig, type WizardConfig,
} from "./config-schema";
import { KnowledgeBasesStep } from "./steps/knowledge-bases-step";
import { RoutingStep } from "./steps/routing-step";
import { VocabularyStep } from "./steps/vocabulary-step";
import { MemoryStep } from "./steps/memory-step";
import { BehaviorStep } from "./steps/behavior-step";
import { ReviewStep } from "./steps/review-step";

export type WizardStepId =
  | "sources" | "routing" | "vocabulary" | "memory" | "behavior" | "review";

export const WIZARD_STEPS: WizardStepId[] = [
  "sources", "routing", "vocabulary", "memory", "behavior", "review",
];

export function KnowledgeSearchWizard({
  open, onOpenChange, initialStep, entries, contexts, memoryContextId, onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialStep?: WizardStepId;
  entries: ToolConfigEntry[];
  contexts: { id: string; name: string; description?: string }[];
  memoryContextId: string;
  onApply: (entries: ToolConfigEntry[]) => void;
}) {
  const t = useTranslations("agents");
  const [step, setStep] = React.useState<WizardStepId>(initialStep ?? "sources");
  const [draft, setDraftState] = React.useState<WizardConfig>(() => parseWizardConfig(entries));

  // Re-seed the draft each time the wizard opens (staged entries may have changed).
  React.useEffect(() => {
    if (open) {
      setDraftState(parseWizardConfig(entries));
      setStep(initialStep ?? "sources");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setDraft = React.useCallback(
    (updater: (prev: WizardConfig) => WizardConfig) => setDraftState((p) => updater(p)),
    [],
  );

  const stepIndex = WIZARD_STEPS.indexOf(step);
  const isLast = stepIndex === WIZARD_STEPS.length - 1;

  const finish = () => {
    onApply(serializeWizardConfig(draft));
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-hidden sm:max-w-2xl">
        <SheetHeader className="border-b pb-3">
          <SheetTitle>{t("editor.knowledge.wizard.title")}</SheetTitle>
          <SheetDescription>
            {t(`editor.knowledge.wizard.steps.${step}.description`)}
          </SheetDescription>
          {/* Step dots + jump navigation */}
          <div className="flex items-center gap-1 pt-1">
            {WIZARD_STEPS.map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => setStep(s)}
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs transition-colors",
                  s === step
                    ? "bg-primary text-primary-foreground"
                    : i < stepIndex
                      ? "bg-muted text-foreground"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {t(`editor.knowledge.wizard.steps.${s}.label`)}
              </button>
            ))}
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto py-4">
          {step === "sources" && (
            <KnowledgeBasesStep draft={draft} setDraft={setDraft} contexts={contexts} />
          )}
          {step === "routing" && (
            <RoutingStep draft={draft} setDraft={setDraft} contexts={contexts} />
          )}
          {step === "vocabulary" && (
            <VocabularyStep draft={draft} setDraft={setDraft} contexts={contexts} />
          )}
          {step === "memory" && (
            <MemoryStep draft={draft} setDraft={setDraft} memoryContextId={memoryContextId} />
          )}
          {step === "behavior" && <BehaviorStep draft={draft} setDraft={setDraft} />}
          {step === "review" && (
            <ReviewStep draft={draft} contexts={contexts} memoryContextId={memoryContextId} />
          )}
        </div>

        <div className="flex items-center justify-between border-t pt-3">
          <Button
            type="button"
            variant="ghost"
            disabled={stepIndex === 0}
            onClick={() => setStep(WIZARD_STEPS[stepIndex - 1]!)}
          >
            <ArrowLeft className="mr-1 size-4" />
            {t("editor.knowledge.wizard.back")}
          </Button>
          {isLast ? (
            <Button type="button" onClick={finish}>
              <Check className="mr-1 size-4" />
              {t("editor.knowledge.wizard.finish")}
            </Button>
          ) : (
            <Button type="button" onClick={() => setStep(WIZARD_STEPS[stepIndex + 1]!)}>
              {t("editor.knowledge.wizard.continue")}
              <ArrowRight className="ml-1 size-4" />
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Implement `steps/knowledge-bases-step.tsx`**

```tsx
"use client";

import { useTranslations } from "next-intl";
import * as React from "react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import {
  selectedKbIds, setKbSelection, KIND_PRESETS,
  type KbKind, type WizardConfig,
} from "../config-schema";

const KINDS: KbKind[] = ["documents", "conversations", "records"];

export function KnowledgeBasesStep({
  draft, setDraft, contexts,
}: {
  draft: WizardConfig;
  setDraft: (updater: (prev: WizardConfig) => WizardConfig) => void;
  contexts: { id: string; name: string; description?: string }[];
}) {
  const t = useTranslations("agents");
  const allIds = contexts.map((c) => c.id);
  const selected = new Set(selectedKbIds(draft, allIds));

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...selected, id] : [...selected].filter((s) => s !== id);
    setDraft((prev) => setKbSelection(prev, allIds, next));
  };

  const updateProfile = (id: string, patch: Partial<WizardConfig["knowledgeBases"][string]>) =>
    setDraft((prev) => ({
      ...prev,
      knowledgeBases: {
        ...prev.knowledgeBases,
        [id]: {
          ...(prev.knowledgeBases[id] ?? {
            enabled: true, kind: "documents" as KbKind, instructions: "", overrides: {},
          }),
          ...patch,
        },
      },
    }));

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t("editor.knowledge.wizard.sources.intro")}
      </p>
      {contexts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t("editor.knowledge.noContexts")}
        </p>
      )}
      {contexts.map((ctx) => {
        const isOn = selected.has(ctx.id);
        const profile = draft.knowledgeBases[ctx.id];
        return (
          <div key={ctx.id} className="space-y-3 rounded-md border p-3">
            <label className="flex items-start gap-3">
              <Checkbox
                checked={isOn}
                onCheckedChange={(v) => toggle(ctx.id, v === true)}
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">{ctx.name}</span>
                {ctx.description && (
                  <span className="block text-xs text-muted-foreground">{ctx.description}</span>
                )}
              </span>
            </label>
            {isOn && (
              <div className="space-y-3 border-t pt-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium">
                    {t("editor.knowledge.wizard.sources.kindLabel")}
                  </p>
                  <Select
                    value={profile?.kind ?? "documents"}
                    onValueChange={(v) => updateProfile(ctx.id, { kind: v as KbKind })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {t(`editor.knowledge.wizard.sources.kinds.${kind}.label`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      `editor.knowledge.wizard.sources.kinds.${profile?.kind ?? "documents"}.hint`,
                      KIND_PRESETS[profile?.kind ?? "documents"],
                    )}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium">
                    {t("editor.knowledge.wizard.sources.instructionsLabel")}
                  </p>
                  <Textarea
                    rows={2}
                    placeholder={t("editor.knowledge.wizard.sources.instructionsPlaceholder")}
                    value={profile?.instructions ?? ""}
                    onChange={(e) => updateProfile(ctx.id, { instructions: e.target.value })}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Temporary stubs so tsc passes before Tasks 4-5**

Create minimal placeholder files for the four not-yet-built steps so `wizard.tsx` compiles (each replaced by its real task; the review step stub too):

```tsx
// steps/routing-step.tsx — REPLACED IN TASK 4
"use client";
import type { WizardConfig } from "../config-schema";
export function RoutingStep(_props: {
  draft: WizardConfig;
  setDraft: (updater: (prev: WizardConfig) => WizardConfig) => void;
  contexts: { id: string; name: string; description?: string }[];
}) {
  return null;
}
```

Repeat the same pattern for `vocabulary-step.tsx` (`VocabularyStep`, same props), `memory-step.tsx` (`MemoryStep`, props `{ draft, setDraft, memoryContextId: string }`), `behavior-step.tsx` (`BehaviorStep`, props `{ draft, setDraft }`), `review-step.tsx` (`ReviewStep`, props `{ draft, contexts, memoryContextId }`).

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit 2>&1 | tail -3` — baseline unchanged.
Run: `npx eslint "app/(application)/agents/edit/[id]/components/knowledge-search/"` — no new errors.
Run: `npx vitest run "app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.test.ts"` — still green.

- [ ] **Step 5: Commit**

```bash
git add "app/(application)/agents/edit/[id]/components/knowledge-search/"
git commit -m "feat(agents): knowledge-search wizard shell and knowledge-bases step"
```

---

### Task 4: Routing + Vocabulary steps

**Files:**
- Replace: `.../knowledge-search/steps/routing-step.tsx` (stub from Task 3)
- Replace: `.../knowledge-search/steps/vocabulary-step.tsx` (stub from Task 3)

**Interfaces:**
- Consumes: `WizardConfig`, `RoutingRule`, `IdentifierSet`, `ruleIdFromLabel`, `selectedKbIds` (Task 2); props exactly as the Task 3 stubs declare.
- Produces: real `RoutingStep` / `VocabularyStep` (same exported names/props as the stubs).

- [ ] **Step 1: Implement `routing-step.tsx`**

```tsx
"use client";

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import {
  ruleIdFromLabel, selectedKbIds, type RoutingRule, type WizardConfig,
} from "../config-schema";

/** Toggleable KB chips used for a rule's main/fallback lists. */
function KbChips({
  ids, active, onToggle,
}: {
  ids: { id: string; name: string }[];
  active: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((kb) => (
        <Badge
          key={kb.id}
          variant={active.includes(kb.id) ? "default" : "outline"}
          className="cursor-pointer select-none"
          onClick={() => onToggle(kb.id)}
        >
          {kb.name}
        </Badge>
      ))}
    </div>
  );
}

export function RoutingStep({
  draft, setDraft, contexts,
}: {
  draft: WizardConfig;
  setDraft: (updater: (prev: WizardConfig) => WizardConfig) => void;
  contexts: { id: string; name: string; description?: string }[];
}) {
  const t = useTranslations("agents");
  const enabledIds = selectedKbIds(draft, contexts.map((c) => c.id));
  const enabledKbs = contexts
    .filter((c) => enabledIds.includes(c.id))
    .map((c) => ({ id: c.id, name: c.name }));

  const setRules = (rules: RoutingRule[]) =>
    setDraft((prev) => ({ ...prev, routing: { rules } }));

  const updateRule = (idx: number, patch: Partial<RoutingRule>) =>
    setRules(draft.routing.rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const toggleIn = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const addRule = () =>
    setRules([
      ...draft.routing.rules,
      {
        id: ruleIdFromLabel(
          t("editor.knowledge.wizard.routing.newRuleLabel"),
          draft.routing.rules.map((r) => r.id),
        ),
        label: "", description: "", main: [], fallback: [],
      },
    ]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t("editor.knowledge.wizard.routing.intro")}
      </p>
      <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
        {t("editor.knowledge.wizard.routing.defaultNote")}
      </p>

      {draft.routing.rules.map((rule, idx) => (
        <div key={rule.id} className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between gap-2">
            <Input
              placeholder={t("editor.knowledge.wizard.routing.labelPlaceholder")}
              value={rule.label}
              onChange={(e) =>
                updateRule(idx, {
                  label: e.target.value,
                  id: ruleIdFromLabel(
                    e.target.value || rule.id,
                    draft.routing.rules.filter((_, i) => i !== idx).map((r) => r.id),
                  ),
                })
              }
            />
            <Button
              type="button" variant="ghost" size="icon"
              aria-label={t("editor.knowledge.wizard.routing.removeRule")}
              onClick={() => setRules(draft.routing.rules.filter((_, i) => i !== idx))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          <Textarea
            rows={2}
            placeholder={t("editor.knowledge.wizard.routing.descriptionPlaceholder")}
            value={rule.description}
            onChange={(e) => updateRule(idx, { description: e.target.value })}
          />
          <div className="space-y-1">
            <p className="text-xs font-medium">
              {t("editor.knowledge.wizard.routing.mainLabel")}
            </p>
            <KbChips
              ids={enabledKbs}
              active={rule.main}
              onToggle={(id) => updateRule(idx, { main: toggleIn(rule.main, id) })}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">
              {t("editor.knowledge.wizard.routing.fallbackLabel")}
            </p>
            <KbChips
              ids={enabledKbs.filter((kb) => !rule.main.includes(kb.id))}
              active={rule.fallback}
              onToggle={(id) => updateRule(idx, { fallback: toggleIn(rule.fallback, id) })}
            />
          </div>
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={addRule}>
        <Plus className="mr-1 size-4" />
        {t("editor.knowledge.wizard.routing.addRule")}
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Implement `vocabulary-step.tsx`**

```tsx
"use client";

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import {
  selectedKbIds, type IdentifierSet, type WizardConfig,
} from "../config-schema";

export function VocabularyStep({
  draft, setDraft, contexts,
}: {
  draft: WizardConfig;
  setDraft: (updater: (prev: WizardConfig) => WizardConfig) => void;
  contexts: { id: string; name: string; description?: string }[];
}) {
  const t = useTranslations("agents");
  const enabledIds = selectedKbIds(draft, contexts.map((c) => c.id));
  const enabledKbs = contexts.filter((c) => enabledIds.includes(c.id));

  const setVocab = (patch: Partial<WizardConfig["vocabulary"]>) =>
    setDraft((prev) => ({ ...prev, vocabulary: { ...prev.vocabulary, ...patch } }));

  const updateIdentifier = (idx: number, patch: Partial<IdentifierSet>) =>
    setVocab({
      identifiers: draft.vocabulary.identifiers.map((s, i) =>
        i === idx ? { ...s, ...patch } : s,
      ),
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("editor.knowledge.wizard.vocabulary.intro")}
      </p>

      {/* Glossary */}
      <div className="space-y-2">
        <p className="text-sm font-medium">
          {t("editor.knowledge.wizard.vocabulary.glossaryTitle")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("editor.knowledge.wizard.vocabulary.glossaryHint")}
        </p>
        {draft.vocabulary.glossary.map((g, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <Input
              className="w-40"
              placeholder={t("editor.knowledge.wizard.vocabulary.termPlaceholder")}
              value={g.term}
              onChange={(e) =>
                setVocab({
                  glossary: draft.vocabulary.glossary.map((x, i) =>
                    i === idx ? { ...x, term: e.target.value } : x,
                  ),
                })
              }
            />
            <Input
              className="flex-1"
              placeholder={t("editor.knowledge.wizard.vocabulary.meaningPlaceholder")}
              value={g.meaning}
              onChange={(e) =>
                setVocab({
                  glossary: draft.vocabulary.glossary.map((x, i) =>
                    i === idx ? { ...x, meaning: e.target.value } : x,
                  ),
                })
              }
            />
            <Button
              type="button" variant="ghost" size="icon"
              aria-label={t("editor.knowledge.wizard.vocabulary.remove")}
              onClick={() =>
                setVocab({ glossary: draft.vocabulary.glossary.filter((_, i) => i !== idx) })
              }
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          type="button" variant="outline" size="sm"
          onClick={() => setVocab({ glossary: [...draft.vocabulary.glossary, { term: "", meaning: "" }] })}
        >
          <Plus className="mr-1 size-4" />
          {t("editor.knowledge.wizard.vocabulary.addTerm")}
        </Button>
      </div>

      {/* Identifier sets */}
      <div className="space-y-2">
        <p className="text-sm font-medium">
          {t("editor.knowledge.wizard.vocabulary.identifiersTitle")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("editor.knowledge.wizard.vocabulary.identifiersHint")}
        </p>
        {draft.vocabulary.identifiers.map((set, idx) => (
          <div key={idx} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Input
                placeholder={t("editor.knowledge.wizard.vocabulary.identifierNamePlaceholder")}
                value={set.name}
                onChange={(e) => updateIdentifier(idx, { name: e.target.value })}
              />
              <Button
                type="button" variant="ghost" size="icon"
                aria-label={t("editor.knowledge.wizard.vocabulary.remove")}
                onClick={() =>
                  setVocab({ identifiers: draft.vocabulary.identifiers.filter((_, i) => i !== idx) })
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <Input
              placeholder={t("editor.knowledge.wizard.vocabulary.examplesPlaceholder")}
              value={set.examples.join(", ")}
              onChange={(e) =>
                updateIdentifier(idx, {
                  examples: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                })
              }
            />
            <Select
              value={set.strategy}
              onValueChange={(v) => updateIdentifier(idx, { strategy: v as "fuzzy" | "exact" })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="fuzzy">
                  {t("editor.knowledge.wizard.vocabulary.strategyFuzzy")}
                </SelectItem>
                <SelectItem value="exact">
                  {t("editor.knowledge.wizard.vocabulary.strategyExact")}
                </SelectItem>
              </SelectContent>
            </Select>
            <div className="space-y-1">
              <p className="text-xs font-medium">
                {t("editor.knowledge.wizard.vocabulary.appliesTo")}
              </p>
              <div className="flex flex-wrap gap-1">
                {enabledKbs.map((kb) => (
                  <Badge
                    key={kb.id}
                    variant={set.contexts.includes(kb.id) ? "default" : "outline"}
                    className="cursor-pointer select-none"
                    onClick={() =>
                      updateIdentifier(idx, {
                        contexts: set.contexts.includes(kb.id)
                          ? set.contexts.filter((x) => x !== kb.id)
                          : [...set.contexts, kb.id],
                      })
                    }
                  >
                    {kb.name}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        ))}
        <Button
          type="button" variant="outline" size="sm"
          onClick={() =>
            setVocab({
              identifiers: [
                ...draft.vocabulary.identifiers,
                { name: "", description: "", examples: [], strategy: "fuzzy", contexts: [] },
              ],
            })
          }
        >
          <Plus className="mr-1 size-4" />
          {t("editor.knowledge.wizard.vocabulary.addIdentifierSet")}
        </Button>
      </div>

      {/* Style hint */}
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {t("editor.knowledge.wizard.vocabulary.styleHintTitle")}
        </p>
        <Textarea
          rows={3}
          placeholder={t("editor.knowledge.wizard.vocabulary.styleHintPlaceholder")}
          value={draft.vocabulary.styleHint}
          onChange={(e) => setVocab({ styleHint: e.target.value })}
        />
      </div>

      {/* Advanced: rewrites */}
      <Accordion type="single" collapsible>
        <AccordionItem value="rewrites" className="border-none">
          <AccordionTrigger className="py-2 text-sm">
            {t("editor.knowledge.wizard.vocabulary.rewritesTitle")}
          </AccordionTrigger>
          <AccordionContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {t("editor.knowledge.wizard.vocabulary.rewritesHint")}
            </p>
            {draft.vocabulary.rewrites.map((rw, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  placeholder={t("editor.knowledge.wizard.vocabulary.findPlaceholder")}
                  value={rw.find}
                  onChange={(e) =>
                    setVocab({
                      rewrites: draft.vocabulary.rewrites.map((x, i) =>
                        i === idx ? { ...x, find: e.target.value } : x,
                      ),
                    })
                  }
                />
                <Input
                  placeholder={t("editor.knowledge.wizard.vocabulary.replacePlaceholder")}
                  value={rw.replace}
                  onChange={(e) =>
                    setVocab({
                      rewrites: draft.vocabulary.rewrites.map((x, i) =>
                        i === idx ? { ...x, replace: e.target.value } : x,
                      ),
                    })
                  }
                />
                <Button
                  type="button" variant="ghost" size="icon"
                  aria-label={t("editor.knowledge.wizard.vocabulary.remove")}
                  onClick={() =>
                    setVocab({ rewrites: draft.vocabulary.rewrites.filter((_, i) => i !== idx) })
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button" variant="outline" size="sm"
              onClick={() =>
                setVocab({ rewrites: [...draft.vocabulary.rewrites, { find: "", replace: "" }] })
              }
            >
              <Plus className="mr-1 size-4" />
              {t("editor.knowledge.wizard.vocabulary.addRewrite")}
            </Button>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit 2>&1 | tail -3` — baseline unchanged. `npx eslint "app/(application)/agents/edit/[id]/components/knowledge-search/steps/"` — no new errors.

- [ ] **Step 4: Commit**

```bash
git add "app/(application)/agents/edit/[id]/components/knowledge-search/steps/"
git commit -m "feat(agents): wizard routing and vocabulary steps"
```

---

### Task 5: Memory, Behavior, and Review steps

**Files:**
- Replace: `.../knowledge-search/steps/memory-step.tsx`, `behavior-step.tsx`, `review-step.tsx` (stubs from Task 3)

**Interfaces:**
- Consumes: `WizardConfig`, `TUNING_DEFAULTS`, `selectedKbIds`, `buildSummary` (Task 2); `RerankerSelector` (`@/components/reranker-selector`, props `{disabled, value, onSelect}`); `Slider` (`@/components/ui/slider`, props `value: number[]`, `min`, `max`, `step`, `onValueChange`).
- Produces: real `MemoryStep` / `BehaviorStep` / `ReviewStep` (same exported names/props as the stubs).

- [ ] **Step 1: Implement `memory-step.tsx`**

```tsx
"use client";

import { useTranslations } from "next-intl";
import * as React from "react";

import { Switch } from "@/components/ui/switch";

import type { WizardConfig } from "../config-schema";

const FEATURES = ["enabled", "override", "filePrioritization", "queryAugmentation"] as const;

export function MemoryStep({
  draft, setDraft, memoryContextId,
}: {
  draft: WizardConfig;
  setDraft: (updater: (prev: WizardConfig) => WizardConfig) => void;
  memoryContextId: string;
}) {
  const t = useTranslations("agents");

  if (!memoryContextId) {
    return (
      <div className="space-y-2 rounded-md border p-4">
        <p className="text-sm font-medium">
          {t("editor.knowledge.wizard.memory.noMemoryTitle")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("editor.knowledge.wizard.memory.noMemoryHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t("editor.knowledge.wizard.memory.intro")}
      </p>
      {FEATURES.map((key) => (
        <div key={key} className="flex items-start justify-between gap-3 rounded-md border p-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">
              {t(`editor.knowledge.wizard.memory.features.${key}.label`)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(`editor.knowledge.wizard.memory.features.${key}.hint`)}
            </p>
          </div>
          <Switch
            checked={draft.memory[key]}
            disabled={key !== "enabled" && !draft.memory.enabled}
            onCheckedChange={(v) =>
              setDraft((prev) => ({ ...prev, memory: { ...prev.memory, [key]: v } }))
            }
          />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Implement `behavior-step.tsx`**

```tsx
"use client";

import { useTranslations } from "next-intl";
import * as React from "react";

import { RerankerSelector } from "@/components/reranker-selector";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import type { WizardConfig } from "../config-schema";

function NumberField({
  label, hint, value, min, max, onChange,
}: {
  label: string; hint?: string; value: number; min: number; max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{label}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <Input
        type="number" min={min} max={max} value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </div>
  );
}

export function BehaviorStep({
  draft, setDraft,
}: {
  draft: WizardConfig;
  setDraft: (updater: (prev: WizardConfig) => WizardConfig) => void;
}) {
  const t = useTranslations("agents");
  const setTuning = (patch: Partial<WizardConfig["tuning"]>) =>
    setDraft((prev) => ({ ...prev, tuning: { ...prev.tuning, ...patch } }));

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("editor.knowledge.wizard.behavior.rerankerTitle")}</p>
        <p className="text-xs text-muted-foreground">
          {t("editor.knowledge.wizard.behavior.rerankerHint")}
        </p>
        <RerankerSelector
          disabled={false}
          value={draft.reranker === "none" ? "" : draft.reranker}
          onSelect={(v: string) => setDraft((prev) => ({ ...prev, reranker: v || "none" }))}
        />
      </div>

      <NumberField
        label={t("editor.knowledge.wizard.behavior.topKLabel")}
        hint={t("editor.knowledge.wizard.behavior.topKHint")}
        value={draft.tuning.topK} min={1} max={50}
        onChange={(n) => setTuning({ topK: Math.max(1, Math.round(n)) })}
      />

      <div className="space-y-1">
        <p className="text-xs font-medium">
          {t("editor.knowledge.wizard.behavior.fallbackLabel", {
            percent: Math.round(draft.tuning.fallbackThreshold * 100),
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("editor.knowledge.wizard.behavior.fallbackHint")}
        </p>
        <Slider
          value={[draft.tuning.fallbackThreshold]}
          min={0} max={1} step={0.01}
          onValueChange={([v]) => setTuning({ fallbackThreshold: v ?? 0.95 })}
        />
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium">
          {t("editor.knowledge.wizard.behavior.instructionsTitle")}
        </p>
        <Textarea
          rows={3}
          placeholder={t("editor.knowledge.wizard.behavior.instructionsPlaceholder")}
          value={draft.instructions}
          onChange={(e) => setDraft((prev) => ({ ...prev, instructions: e.target.value }))}
        />
      </div>

      <Accordion type="single" collapsible>
        <AccordionItem value="advanced" className="border-none">
          <AccordionTrigger className="py-2 text-sm">
            {t("editor.knowledge.wizard.behavior.advancedTitle")}
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <NumberField
              label={t("editor.knowledge.wizard.behavior.pinBoostLabel")}
              value={draft.tuning.pinBoost} min={0} max={1}
              onChange={(n) => setTuning({ pinBoost: Math.min(1, Math.max(0, n)) })}
            />
            <NumberField
              label={t("editor.knowledge.wizard.behavior.identifierBoostLabel")}
              value={draft.tuning.identifierBoost} min={0} max={1}
              onChange={(n) => setTuning({ identifierBoost: Math.min(1, Math.max(0, n)) })}
            />
            <NumberField
              label={t("editor.knowledge.wizard.behavior.pageWindowLabel")}
              value={draft.tuning.pageWindow} min={0} max={10}
              onChange={(n) => setTuning({ pageWindow: Math.max(0, Math.round(n)) })}
            />
            <NumberField
              label={t("editor.knowledge.wizard.behavior.maxQueriesLabel")}
              value={draft.tuning.maxQueriesPerContext} min={1} max={10}
              onChange={(n) => setTuning({ maxQueriesPerContext: Math.max(1, Math.round(n)) })}
            />
            <div className="space-y-1">
              <p className="text-xs font-medium">
                {t("editor.knowledge.wizard.behavior.utilityModelLabel")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("editor.knowledge.wizard.behavior.utilityModelHint")}
              </p>
              <Input
                value={draft.utilityModel}
                onChange={(e) => setDraft((prev) => ({ ...prev, utilityModel: e.target.value }))}
              />
            </div>
            {(["managedContext", "requirePreselectedContexts", "logging"] as const).map((key) => (
              <div key={key} className="flex items-start justify-between gap-3 rounded-md border p-3">
                <div className="space-y-0.5">
                  <p className="text-xs font-medium">
                    {t(`editor.knowledge.wizard.behavior.flags.${key}.label`)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(`editor.knowledge.wizard.behavior.flags.${key}.hint`)}
                  </p>
                </div>
                <Switch
                  checked={draft[key]}
                  onCheckedChange={(v) => setDraft((prev) => ({ ...prev, [key]: v }))}
                />
              </div>
            ))}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
```

- [ ] **Step 3: Implement `review-step.tsx`**

```tsx
"use client";

import { useTranslations } from "next-intl";
import * as React from "react";

import { Badge } from "@/components/ui/badge";

import { buildSummary, selectedKbIds, type WizardConfig } from "../config-schema";

export function ReviewStep({
  draft, contexts, memoryContextId,
}: {
  draft: WizardConfig;
  contexts: { id: string; name: string; description?: string }[];
  memoryContextId: string;
}) {
  const t = useTranslations("agents");
  const allIds = contexts.map((c) => c.id);
  const summary = buildSummary(draft, allIds);
  const enabled = selectedKbIds(draft, allIds);
  const nameOf = (id: string) => contexts.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t("editor.knowledge.wizard.review.intro")}
      </p>

      <div className="space-y-1 rounded-md border p-3">
        <p className="text-sm font-medium">
          {t("editor.knowledge.wizard.review.sourcesTitle", { count: summary.kbCount })}
        </p>
        <div className="flex flex-wrap gap-1">
          {enabled.map((id) => (
            <Badge key={id} variant="secondary">
              {nameOf(id)}
              <span className="ml-1 text-muted-foreground">
                {t(`editor.knowledge.wizard.sources.kinds.${draft.knowledgeBases[id]?.kind ?? "documents"}.label`)}
              </span>
            </Badge>
          ))}
        </div>
      </div>

      <div className="space-y-1 rounded-md border p-3">
        <p className="text-sm font-medium">
          {t("editor.knowledge.wizard.review.routingTitle", { count: summary.ruleCount })}
        </p>
        {draft.routing.rules.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("editor.knowledge.wizard.routing.defaultNote")}
          </p>
        ) : (
          draft.routing.rules.map((r) => (
            <p key={r.id} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{r.label || r.id}</span>
              {" → "}{r.main.map(nameOf).join(", ")}
              {r.fallback.length > 0 && ` (${t("editor.knowledge.wizard.review.fallback")}: ${r.fallback.map(nameOf).join(", ")})`}
            </p>
          ))
        )}
      </div>

      <div className="space-y-1 rounded-md border p-3">
        <p className="text-sm font-medium">{t("editor.knowledge.wizard.review.vocabularyTitle")}</p>
        <p className="text-xs text-muted-foreground">
          {t("editor.knowledge.wizard.review.vocabularyLine", {
            glossary: draft.vocabulary.glossary.length,
            identifiers: draft.vocabulary.identifiers.length,
            rewrites: draft.vocabulary.rewrites.length,
          })}
        </p>
      </div>

      <div className="space-y-1 rounded-md border p-3">
        <p className="text-sm font-medium">{t("editor.knowledge.wizard.review.memoryTitle")}</p>
        <p className="text-xs text-muted-foreground">
          {!memoryContextId
            ? t("editor.knowledge.wizard.memory.noMemoryTitle")
            : draft.memory.enabled
              ? t("editor.knowledge.wizard.review.memoryOn")
              : t("editor.knowledge.wizard.review.memoryOff")}
        </p>
      </div>

      <div className="space-y-1 rounded-md border p-3">
        <p className="text-sm font-medium">{t("editor.knowledge.wizard.review.behaviorTitle")}</p>
        <p className="text-xs text-muted-foreground">
          {t("editor.knowledge.wizard.review.behaviorLine", {
            topK: draft.tuning.topK,
            percent: Math.round(draft.tuning.fallbackThreshold * 100),
            reranker: summary.rerankerLabel || t("editor.knowledge.wizard.review.noReranker"),
          })}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit 2>&1 | tail -3` — baseline unchanged. `npx eslint "app/(application)/agents/edit/[id]/components/knowledge-search/"` — no new errors. `npx vitest run` — green.

- [ ] **Step 5: Commit**

```bash
git add "app/(application)/agents/edit/[id]/components/knowledge-search/steps/"
git commit -m "feat(agents): wizard memory, behavior, and review steps"
```

---

### Task 6: Summary card, Knowledge-section integration, i18n

**Files:**
- Create: `.../knowledge-search/summary-card.tsx`
- Modify: `app/(application)/agents/edit/[id]/sections/knowledge.tsx` (replace the `ToolConfigurationElement` block; auto-open wizard on first enable)
- Modify: `messages/en.json`, `messages/de.json` (all `agents.editor.knowledge.wizard.*` and `.summary.*` keys)

**Interfaces:**
- Consumes: `KnowledgeSearchWizard`, `WizardStepId` (Task 3); `parseWizardConfig`, `buildSummary` (Task 2); existing `editor.tools` / `editor.setTools` / `editor.memory` / `refs.agenticRetrievalTool` / `refs.contexts`.
- Produces: `KnowledgeSearchSummaryCard(props: { entries, contexts, onEdit: (step: WizardStepId) => void })`.

- [ ] **Step 1: Implement `summary-card.tsx`**

```tsx
"use client";

import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";

import type { ToolConfigEntry } from "../tool-config-fields";
import { buildSummary, parseWizardConfig } from "./config-schema";
import type { WizardStepId } from "./wizard";

export function KnowledgeSearchSummaryCard({
  entries, contexts, onEdit,
}: {
  entries: ToolConfigEntry[];
  contexts: { id: string; name: string; description?: string }[];
  onEdit: (step: WizardStepId) => void;
}) {
  const t = useTranslations("agents");
  const cfg = parseWizardConfig(entries);
  const s = buildSummary(cfg, contexts.map((c) => c.id));

  const parts = [
    t("editor.knowledge.summary.kbs", { count: s.kbCount }),
    t("editor.knowledge.summary.rules", { count: s.ruleCount }),
    s.memoryOn
      ? t("editor.knowledge.summary.memoryOn")
      : t("editor.knowledge.summary.memoryOff"),
    s.rerankerLabel
      ? t("editor.knowledge.summary.reranker", { name: s.rerankerLabel })
      : t("editor.knowledge.summary.noReranker"),
  ];

  const areas: { step: WizardStepId; key: string }[] = [
    { step: "sources", key: "editSources" },
    { step: "routing", key: "editRouting" },
    { step: "vocabulary", key: "editVocabulary" },
    { step: "behavior", key: "editBehavior" },
  ];

  return (
    <div className="space-y-3 border-t pt-3">
      <p className="text-sm text-muted-foreground">{parts.join(" · ")}</p>
      <div className="flex flex-wrap gap-2">
        {areas.map((a) => (
          <Button
            key={a.step}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onEdit(a.step)}
          >
            {t(`editor.knowledge.summary.${a.key}`)}
          </Button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Rewire `sections/knowledge.tsx`**

Replace the import of `ToolConfigurationElement` and the `updateAgenticConfig` helper and the `{agenticEnabled && (...)}` block. Full changes:

1. Imports: remove `ToolConfigurationElement`; add:

```tsx
import { KnowledgeSearchSummaryCard } from "../components/knowledge-search/summary-card";
import {
  KnowledgeSearchWizard, type WizardStepId,
} from "../components/knowledge-search/wizard";
import type { ToolConfigEntry } from "../components/tool-config-fields";
```

2. Inside `KnowledgeSection`, add state + helpers (after `selectedContext`):

```tsx
  const [wizardOpen, setWizardOpen] = React.useState(false);
  const [wizardStep, setWizardStep] = React.useState<WizardStepId>("sources");

  const agenticEntries =
    (editor.tools.find((t) => t.id === "agentic_context_search")
      ?.config as ToolConfigEntry[]) || [];

  const applyAgenticConfig = (entries: ToolConfigEntry[]) => {
    editor.setTools(
      editor.tools.map((t) =>
        t.id === "agentic_context_search" ? { ...t, config: entries as any } : t,
      ),
    );
  };

  const openWizard = (step: WizardStepId) => {
    setWizardStep(step);
    setWizardOpen(true);
  };
```

3. In `toggleAgentic`, after the `editor.setTools([...])` enable branch, auto-open: add `openWizard("sources");` as the last statement of the `if (enabled)` branch. Delete the now-unused `updateAgenticConfig` function.

4. Replace the `{agenticEnabled && ( <div ...><ToolConfigurationElement ... /></div> )}` block with:

```tsx
          {agenticEnabled && (
            <KnowledgeSearchSummaryCard
              entries={agenticEntries}
              contexts={refs.contexts}
              onEdit={openWizard}
            />
          )}
```

5. Before the closing `</section>` tag, mount the wizard:

```tsx
      <KnowledgeSearchWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        initialStep={wizardStep}
        entries={agenticEntries}
        contexts={refs.contexts}
        memoryContextId={editor.memory}
        onApply={applyAgenticConfig}
      />
```

Note: `editor.memory` is a `string` (`""` = none) and `refs.variables` is no longer needed by this section — remove any now-unused imports.

- [ ] **Step 3: Add the i18n keys**

Insert into `messages/en.json` under `agents.editor.knowledge` (merge as siblings of the existing `agenticTitle` etc.):

```json
"summary": {
  "kbs": "{count, plural, one {# knowledge base} other {# knowledge bases}}",
  "rules": "{count, plural, =0 {no routing rules} one {# routing rule} other {# routing rules}}",
  "memoryOn": "memory on",
  "memoryOff": "memory off",
  "reranker": "reranker: {name}",
  "noReranker": "no reranker",
  "editSources": "Knowledge bases",
  "editRouting": "Routing",
  "editVocabulary": "Vocabulary",
  "editBehavior": "Behavior"
},
"wizard": {
  "title": "Configure knowledge search",
  "back": "Back",
  "continue": "Continue",
  "finish": "Apply",
  "steps": {
    "sources": { "label": "Sources", "description": "Choose which knowledge bases the assistant may search and what kind of content each one holds." },
    "routing": { "label": "Routing", "description": "Teach the assistant which sources to check first for different kinds of questions." },
    "vocabulary": { "label": "Vocabulary", "description": "Give the assistant your domain language: abbreviations, product names, and how your documents are written." },
    "memory": { "label": "Memory", "description": "Control how curated memory entries participate in answers." },
    "behavior": { "label": "Behavior", "description": "Tune how results are ranked and how many are returned." },
    "review": { "label": "Review", "description": "Check everything before applying. Changes are saved with the agent." }
  },
  "sources": {
    "intro": "Pick the knowledge bases this assistant may search. Everything you leave unchecked will never be searched.",
    "kindLabel": "What's in it?",
    "kinds": {
      "documents": { "label": "Documents & manuals", "hint": "Searched thoroughly with query expansion — best for manuals, PDFs, and long documents (up to {limit} passages, reads {expand} neighboring sections)." },
      "conversations": { "label": "Conversations & tickets", "hint": "Matched by names and keywords first — best for support tickets and email threads (up to {limit} passages)." },
      "records": { "label": "Structured records", "hint": "Searched directly by keywords — best for database rows and short entries (up to {limit} passages)." }
    },
    "instructionsLabel": "When should the assistant look here? (optional)",
    "instructionsPlaceholder": "e.g. Product manuals and datasheets — check here first for technical questions."
  },
  "routing": {
    "intro": "Routing rules describe kinds of questions in plain language and point them at the right sources.",
    "defaultNote": "No rules means every enabled knowledge base is searched for every question. That's a fine default — add rules when you want faster, more focused answers.",
    "newRuleLabel": "New rule",
    "labelPlaceholder": "e.g. Technical questions",
    "descriptionPlaceholder": "e.g. Questions about products, error codes, installation or specifications.",
    "mainLabel": "Search these first",
    "fallbackLabel": "Also check when the first search looks weak",
    "addRule": "Add rule",
    "removeRule": "Remove rule"
  },
  "vocabulary": {
    "intro": "Optional, but powerful: your domain language helps the assistant find documents even when users phrase things differently.",
    "glossaryTitle": "Glossary",
    "glossaryHint": "Abbreviations and terms your documents use. e.g. FST → field bus controller.",
    "termPlaceholder": "Term",
    "meaningPlaceholder": "Meaning",
    "addTerm": "Add term",
    "identifiersTitle": "Names & codes",
    "identifiersHint": "Kinds of identifiers users mention that map to specific files — product names, standards, error codes. The assistant pins matching files when it spots one.",
    "identifierNamePlaceholder": "e.g. Product names",
    "examplesPlaceholder": "Examples, comma-separated: FST, ECO, CBM-2",
    "strategyFuzzy": "Names & titles (approximate matching)",
    "strategyExact": "Codes & standards (exact matching)",
    "appliesTo": "Applies to",
    "styleHintTitle": "Describe your documents (optional)",
    "styleHintPlaceholder": "e.g. German technical manuals for elevator controllers, with menu paths, parameters and error codes.",
    "rewritesTitle": "Advanced: query rewrites",
    "rewritesHint": "Replace phrases in the user's question before searching. Use for systematic wording differences between how users ask and how documents are written.",
    "findPlaceholder": "Find",
    "replacePlaceholder": "Replace with",
    "addRewrite": "Add rewrite",
    "remove": "Remove"
  },
  "memory": {
    "intro": "Memory entries are curated notes attached to this agent's memory knowledge base. These features control how they shape retrieval.",
    "noMemoryTitle": "No memory knowledge base configured",
    "noMemoryHint": "Pick a memory context in the Knowledge & memory section below to use these features.",
    "features": {
      "enabled": { "label": "Use memory during retrieval", "hint": "Relevant memory entries are retrieved and offered to the assistant alongside document results." },
      "override": { "label": "Let verified memory override documents", "hint": "When a curated entry directly answers the question, the answer leads with it — even over the documents. Strictly gated." },
      "filePrioritization": { "label": "Follow file hints in memory", "hint": "Memory notes like \"always check X first\" pin those files into the search." },
      "queryAugmentation": { "label": "Expand queries with memory & glossary", "hint": "Adds synonyms and expansions from memory and your glossary to the search." }
    }
  },
  "behavior": {
    "rerankerTitle": "Reranker",
    "rerankerHint": "A reranker re-scores search results for relevance. Strongly recommended — without one, results are ordered by raw search score.",
    "topKLabel": "Results to hand the assistant",
    "topKHint": "How many top passages the assistant sees. More = broader context, slower and costlier answers.",
    "fallbackLabel": "Backup-source trigger: {percent}%",
    "fallbackHint": "When the best first-search result scores below this, backup sources are also checked. Higher = backups used more often.",
    "instructionsTitle": "Extra instructions (optional)",
    "instructionsPlaceholder": "Free-text guidance for the retrieval pipeline.",
    "advancedTitle": "Advanced tuning",
    "pinBoostLabel": "Pinned-file score boost",
    "identifierBoostLabel": "Identifier-match score boost",
    "pageWindowLabel": "Page window for page references",
    "maxQueriesLabel": "Max query variations per source",
    "utilityModelLabel": "Utility model (optional)",
    "utilityModelHint": "Model id for the pipeline's internal micro-calls. Empty = the agent's own model.",
    "flags": {
      "managedContext": { "label": "Managed context", "hint": "Users must preselect items before this tool will search." },
      "requirePreselectedContexts": { "label": "Require chosen knowledge bases", "hint": "Users must pick which knowledge bases to search before the tool runs." },
      "logging": { "label": "Debug logging", "hint": "Verbose per-phase logging to the server console." }
    }
  },
  "review": {
    "intro": "Here's what will be applied. Use the step buttons above to change anything.",
    "sourcesTitle": "{count, plural, one {# knowledge base} other {# knowledge bases}}",
    "routingTitle": "{count, plural, =0 {No routing rules} one {# routing rule} other {# routing rules}}",
    "fallback": "backup",
    "vocabularyTitle": "Vocabulary",
    "vocabularyLine": "{glossary} glossary terms · {identifiers} identifier sets · {rewrites} rewrites",
    "memoryTitle": "Memory",
    "memoryOn": "Memory features are on.",
    "memoryOff": "Memory is off for retrieval.",
    "behaviorTitle": "Behavior",
    "behaviorLine": "Top {topK} results · backup trigger {percent}% · {reranker}",
    "noReranker": "no reranker"
  }
}
```

And the German equivalents into `messages/de.json` at the same position (translate faithfully; keep ICU plural syntax; e.g. `"kbs": "{count, plural, one {# Wissensdatenbank} other {# Wissensdatenbanken}}"`, `"title": "Wissenssuche konfigurieren"`, `"finish": "Übernehmen"`, kinds `"Dokumente & Handbücher"` / `"Konversationen & Tickets"` / `"Strukturierte Datensätze"`, memory features etc. — translate every key added to en.json; no English left in de.json).

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit 2>&1 | tail -3` — baseline unchanged.
Run: `node -e "JSON.parse(require('fs').readFileSync('messages/en.json')); JSON.parse(require('fs').readFileSync('messages/de.json')); console.log('json ok')"` — `json ok`.
Run: `npx vitest run` — green.
Run: `npx eslint "app/(application)/agents/edit/[id]/"` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add "app/(application)/agents/edit/[id]/" messages/en.json messages/de.json
git commit -m "feat(agents): knowledge-search summary card, wizard integration, i18n copy"
```

---

### Task 7: Full verification + manual UAT checklist

**Files:**
- None created; verification only. (If `npm run build` surfaces type errors in the new files, fix them here.)

- [ ] **Step 1: Static verification**

Run: `npx tsc --noEmit 2>&1 | tail -3` (baseline unchanged), `npx vitest run` (all green), `npx eslint "app/(application)/agents/edit/[id]/" "types/models/"` (no new errors), `npm run build 2>&1 | tail -5` (build succeeds).

- [ ] **Step 2: Manual UAT (requires the dev stack: backend + frontend running, one agent, ≥2 contexts)**

Walk this checklist in the browser and record pass/fail per item in the task report:

1. Agent editor → Knowledge section: enabling the agentic switch auto-opens the wizard at Sources.
2. Sources: contexts listed with descriptions; selecting/deselecting works; kind select shows the three options with hints; per-KB instructions persist across step navigation.
3. Routing: add rule → label typed → chips toggle between main/fallback; fallback chips exclude main selections; delete rule works; default note visible with zero rules.
4. Vocabulary: glossary rows add/remove; identifier set with comma-separated examples; strategy select; applies-to chips; rewrites under Advanced.
5. Memory: with no memory context set → explainer + pointer; with one set → four toggles, three gated by the master toggle.
6. Behavior: reranker dropdown lists rerankers; slider updates the % label live; advanced accordion opens.
7. Review: counts and lines reflect earlier steps; Apply closes the wizard; summary card digest updates.
8. SaveBar: after Apply the page shows unsaved changes; Save persists; reload shows the saved state in both summary card and re-opened wizard.
9. Chat regression: with `managed_context` toggled on in Advanced and saved, the chat composer still enforces item preselection (reads `variable === "true"`).
10. Generic fallback: any other tool with a `json` config option (none ship today — verify via the agentic tool temporarily in the Tools section is NOT possible since it's excluded; instead verify the json case renders by temporarily inspecting `ToolConfigurationElement` with a story-less smoke: skip if impractical, note as such).
11. Language switch to German: wizard fully translated (no raw keys, no English).

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix(agents): wizard UAT polish"
```

(Skip the commit if no fixes were needed.)

---

## Plan Self-Review Notes

- Spec §4 coverage: placement/summary card (Task 6), wizard shell + six steps (Tasks 3-5), data-flow-no-new-API + zod parse/serialize (Task 2), json textarea fallback + `tool-config-fields` change (Task 1), copy in plain language via next-intl en+de (Task 6), manual UAT + type-check verification per spec §7 (Task 7).
- Deviation from spec §4 wording: spec's step 5 mentions `managed_context`/`require_preselected_contexts`/`logging` under Behavior→Advanced — implemented exactly there (Task 5). Spec's "closing mid-wizard warns about unapplied edits" is simplified to: closing discards the draft (staged entries unchanged — nothing silently applied); re-opening re-seeds from staged entries. Rationale: the draft is never half-applied, so there is nothing destructive to warn about beyond losing in-sheet edits; flagged here for the reviewer.
- Type consistency check: `ToolConfigEntry` (Task 1) consumed by Tasks 2/3/6; `WizardConfig`/`selectedKbIds`/`setKbSelection`/`buildSummary`/`ruleIdFromLabel`/`KIND_PRESETS` (Task 2) consumed by Tasks 3-6 with matching names; step props match the Task 3 stubs exactly; `WizardStepId`/`KnowledgeSearchWizard` (Task 3) consumed by Task 6.
