# Sandbox Tool Output Truncation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the partial `truncateToolOutput` implementation in `convert-exulu-tools-to-ai-sdk-tools.ts` so it fully matches the approved spec: head+tail split, correct defaults, all three bash/readFile fields covered, and unit tested.

**Architecture:** `truncateToolOutput` is a pure exported function in `convert-exulu-tools-to-ai-sdk-tools.ts`. The `sandboxTools` block wraps the three sandbox tool execute functions and calls it with per-field `tailFraction` values. No other files change.

**Tech Stack:** TypeScript, Jest + ts-jest (test runner already configured at `jest.config.cjs`).

## Global Constraints

- Only `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` and its new test file change — `create-sandbox.ts` and all other files are out of scope.
- `truncateToolOutput` must be exported so it can be unit tested directly.
- Default `maxContextLength` when absent or ≤ 0: **128 000 tokens**.
- Character limit formula: `floor(effectiveCtx * 0.25 * 4)` — equals `effectiveCtx` when default is used (128 000 chars).
- `tailFraction` per field: `readFile.content = 0.05`, `bash.stdout = 0.10`, `bash.stderr = 0.40`.
- `output.slice(-0)` returns the full string in JavaScript — when `tailChars === 0`, omit the tail slice entirely.

---

### Task 1: Rewrite `truncateToolOutput` and export it

**Files:**
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:36-56`
- Create: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts`

**Interfaces:**
- Produces: `export const truncateToolOutput(output: string, maxContextLength: number | undefined, toolName: string, tailFraction?: number): string`

- [ ] **Step 1: Create the test file with failing tests**

Create `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts`:

```typescript
import { truncateToolOutput } from './convert-exulu-tools-to-ai-sdk-tools';

// charLimit when maxContextLength=128_000: floor(128_000 * 0.25 * 4) = 128_000
// With tailFraction=0.1 (default): headChars=115_200, tailChars=12_800
const LIMIT = 128_000;

describe('truncateToolOutput', () => {
  it('returns output unchanged when at or under the limit', () => {
    const output = 'x'.repeat(LIMIT);
    expect(truncateToolOutput(output, 128_000, 'bash')).toBe(output);
  });

  it('truncates into head + marker + tail when over limit', () => {
    // 200_000 chars > 128_000 limit
    // headChars = floor(128_000 * 0.9) = 115_200
    // tailChars = 128_000 - 115_200 = 12_800
    const head = 'A'.repeat(115_200);
    const middle = 'M'.repeat(72_000); // omitted section
    const tail = 'B'.repeat(12_800);
    const output = head + middle + tail;

    const result = truncateToolOutput(output, 128_000, 'bash', 0.1);

    expect(result.startsWith(head)).toBe(true);
    expect(result).toContain('BASH OUTPUT TRUNCATED');
    expect(result.endsWith(tail)).toBe(true);
    // Result must be shorter than input
    expect(result.length).toBeLessThan(output.length);
  });

  it('marker includes original length and omitted character count', () => {
    const output = 'x'.repeat(200_000);
    const result = truncateToolOutput(output, 128_000, 'bash', 0.1);
    expect(result).toContain('200000');           // original length
    expect(result).toContain('72000');            // omitted = 200_000 - 128_000
    expect(result).toContain('115200');           // headChars
    expect(result).toContain('12800');            // tailChars
  });

  it('uses 128k default when maxContextLength is undefined', () => {
    const output = 'x'.repeat(200_000);
    const withUndefined = truncateToolOutput(output, undefined, 'bash');
    const withExplicit  = truncateToolOutput(output, 128_000, 'bash');
    expect(withUndefined).toBe(withExplicit);
  });

  it('uses 128k default when maxContextLength is 0', () => {
    const output = 'x'.repeat(200_000);
    const result = truncateToolOutput(output, 0, 'bash');
    expect(result).toContain('BASH OUTPUT TRUNCATED');
  });

  it('uses 128k default when maxContextLength is negative', () => {
    const output = 'x'.repeat(200_000);
    const result = truncateToolOutput(output, -1, 'bash');
    expect(result).toContain('BASH OUTPUT TRUNCATED');
  });

  it('tailFraction=0 produces head-only truncation with no tail after marker', () => {
    const output = 'A'.repeat(200_000);
    const result = truncateToolOutput(output, 128_000, 'bash', 0);
    // headChars=128_000, tailChars=0 — no tail slice
    const markerIdx = result.indexOf('BASH OUTPUT TRUNCATED');
    expect(markerIdx).toBeGreaterThan(0);
    // Nothing after the closing ] except nothing — the closing bracket ends the result
    expect(result.endsWith(']')).toBe(true);
  });

  it('tailFraction=1 produces marker+tail with no head before marker', () => {
    const output = 'x'.repeat(200_000);
    const result = truncateToolOutput(output, 128_000, 'bash', 1);
    // headChars=0 — result starts immediately with the marker
    expect(result.startsWith('\n\n[')).toBe(true);
    // tailChars=128_000 — last 128_000 chars of output appear after marker
    expect(result.endsWith('x'.repeat(128_000))).toBe(true);
  });

  it('clamps tailFraction above 1 to 1', () => {
    const output = 'x'.repeat(200_000);
    const withClamped  = truncateToolOutput(output, 128_000, 'bash', 1);
    const withExceeded = truncateToolOutput(output, 128_000, 'bash', 99);
    expect(withExceeded).toBe(withClamped);
  });

  it('clamps tailFraction below 0 to 0', () => {
    const output = 'x'.repeat(200_000);
    const withClamped   = truncateToolOutput(output, 128_000, 'bash', 0);
    const withNegative  = truncateToolOutput(output, 128_000, 'bash', -5);
    expect(withNegative).toBe(withClamped);
  });

  it('uppercases toolName in the marker', () => {
    const output = 'x'.repeat(200_000);
    const result = truncateToolOutput(output, 128_000, 'readFile', 0.05);
    expect(result).toContain('READFILE OUTPUT TRUNCATED');
  });

  it('marker contains recovery command examples', () => {
    const output = 'x'.repeat(200_000);
    const result = truncateToolOutput(output, 128_000, 'bash', 0.1);
    expect(result).toContain('grep');
    expect(result).toContain('sed');
    expect(result).toContain('head');
    expect(result).toContain('tail');
    expect(result).toContain('awk');
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail (function not exported yet)**

```bash
npx jest src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts --no-coverage
```

Expected: Multiple failures — `truncateToolOutput is not a function` or `SyntaxError: The requested module ... does not provide an export named 'truncateToolOutput'`.

- [ ] **Step 3: Replace the `truncateToolOutput` function with the spec-compliant version**

In `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`, replace lines 28–56 (the comment block + function) with:

```typescript
/**
 * Truncates a sandbox tool output string that exceeds 25% of the agent's context window.
 * Uses a head+tail split so the agent sees both the beginning and end of the output.
 * The omitted middle is replaced with a marker listing granular recovery commands.
 *
 * Exported for unit testing.
 */
export const truncateToolOutput = (
  output: string,
  maxContextLength: number | undefined,
  toolName: string,
  tailFraction = 0.1,
): string => {
  const effectiveCtx = (maxContextLength != null && maxContextLength > 0) ? maxContextLength : 128_000;
  const charLimit = Math.floor(effectiveCtx * 0.25 * 4);
  const clampedTail = Math.min(1, Math.max(0, tailFraction));
  if (output.length <= charLimit) return output;
  const headChars = Math.floor(charLimit * (1 - clampedTail));
  const tailChars = charLimit - headChars;
  // Safety guard: if the split would be nonsensical, return unchanged.
  if (headChars + tailChars >= output.length) return output;
  const omitted = output.length - headChars - tailChars;
  const marker =
    `\n\n[${toolName.toUpperCase()} OUTPUT TRUNCATED: output was ${output.length} characters; ` +
    `showing first ${headChars} and last ${tailChars} characters ` +
    `(limit: ${charLimit} = 25% of ${effectiveCtx}-token context). ` +
    `${omitted} characters omitted. To read specific sections use:\n` +
    `  grep -n "pattern" <file>        # find specific text\n` +
    `  sed -n '1,50p' <file>           # lines 1–50\n` +
    `  head -n 100 <file>              # first 100 lines\n` +
    `  tail -n 100 <file>              # last 100 lines\n` +
    `  awk 'NR>=10 && NR<=50' <file>   # lines 10–50]`;
  const head = output.slice(0, headChars);
  // slice(-0) === slice(0) returns the full string — guard tailChars=0 explicitly.
  const tail = tailChars > 0 ? output.slice(-tailChars) : '';
  return head + marker + tail;
};
```

- [ ] **Step 4: Run the tests and confirm they all pass**

```bash
npx jest src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts --no-coverage
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts \
        src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts
git commit -m "feat: rewrite truncateToolOutput with head+tail split, 128k default, export for tests"
```

---

### Task 2: Update call sites — tailFraction values and add stderr truncation

**Files:**
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` (sandboxTools block, lines ~319–359)

**Interfaces:**
- Consumes: `truncateToolOutput(output, maxContextLength, toolName, tailFraction)` from Task 1.

- [ ] **Step 1: Add failing tests for the call-site tailFraction values**

Append to `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts`:

```typescript
// Verify the per-field tailFraction values match the spec by calling
// truncateToolOutput with the same arguments the call sites use and
// checking the head/tail split ratios.
describe('truncateToolOutput — per-field tailFraction contracts', () => {
  const OVER = 200_000; // characters, safely above any reasonable charLimit

  it('readFile tailFraction=0.05: tail is 5% of charLimit', () => {
    const output = 'x'.repeat(OVER);
    const result = truncateToolOutput(output, 128_000, 'readFile', 0.05);
    // tailChars = floor(128_000 * 0.05) = 6_400
    expect(result.endsWith('x'.repeat(6_400))).toBe(true);
  });

  it('bash stdout tailFraction=0.10: tail is 10% of charLimit', () => {
    const output = 'x'.repeat(OVER);
    const result = truncateToolOutput(output, 128_000, 'bash', 0.10);
    // tailChars = 128_000 - floor(128_000 * 0.9) = 12_800
    expect(result.endsWith('x'.repeat(12_800))).toBe(true);
  });

  it('bash stderr tailFraction=0.40: tail is 40% of charLimit', () => {
    const output = 'x'.repeat(OVER);
    const result = truncateToolOutput(output, 128_000, 'bash', 0.40);
    // headChars = floor(128_000 * 0.6) = 76_800; tailChars = 51_200
    expect(result.endsWith('x'.repeat(51_200))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new tests to confirm they pass (they only test the helper, not call sites)**

```bash
npx jest src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts --no-coverage
```

Expected: All tests PASS (these tests call `truncateToolOutput` directly with the spec's tailFraction values — they pass immediately and serve as a contract for the call sites).

- [ ] **Step 3: Update the `sandboxTools` block call sites**

In `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`, find the `sandboxTools` block (the one that starts `const sandboxTools: Record<string, any> = sharedSessionSandbox`).

Replace the entire block with:

```typescript
const sandboxTools: Record<string, any> = sharedSessionSandbox
  ? {
      readFile: {
        ...sharedSessionSandbox.tools.readFile,
        needsApproval: false,
        execute: async (args: any, opts: any) => {
          const origExecute = sharedSessionSandbox.tools.readFile.execute as
            | ((input: any, options: any) => Promise<any>)
            | undefined;
          if (!origExecute) throw new Error('readFile execute is undefined');
          const result = await origExecute(args, opts);
          if (typeof result?.content === 'string') {
            return {
              ...result,
              content: truncateToolOutput(result.content, agent?.maxContextLength, 'readFile', 0.05),
            };
          }
          return result;
        },
      },
      writeFile: { ...sharedSessionSandbox.tools.writeFile, needsApproval: false },
      bash: {
        ...sharedSessionSandbox.tools.bash,
        needsApproval: false,
        execute: async (args: any, opts: any) => {
          const origExecute = sharedSessionSandbox.tools.bash.execute as
            | ((input: any, options: any) => Promise<any>)
            | undefined;
          if (!origExecute) throw new Error('bash execute is undefined');
          const result = await origExecute(args, opts);
          return {
            ...result,
            ...(typeof result?.stdout === 'string' && {
              stdout: truncateToolOutput(result.stdout, agent?.maxContextLength, 'bash', 0.10),
            }),
            ...(typeof result?.stderr === 'string' && {
              stderr: truncateToolOutput(result.stderr, agent?.maxContextLength, 'bash stderr', 0.40),
            }),
          };
        },
      },
    }
  : {};
```

- [ ] **Step 4: Run the full test suite to confirm nothing is broken**

```bash
npx jest src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts --no-coverage
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts \
        src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts
git commit -m "feat: apply tailFraction per field and truncate bash stderr"
```
