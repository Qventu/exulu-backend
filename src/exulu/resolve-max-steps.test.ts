import { resolveRetrievalCallBudget, resolveTurnStepBudget, finalAnswerGuard, DEFAULT_MAX_STEPS, retrievalBudgetGuard } from "./resolve-max-steps";
import { composePrepareSteps } from "./context-guard";

const cfg = (entries: { name: string; variable: any; type: string }[]) =>
  [{ id: "agentic_context_search", type: "context", name: "Context Search", config: entries }] as any;

describe("resolveRetrievalCallBudget", () => {
  it("returns the configured positive integer (string-stored, platform convention)", () => {
    expect(resolveRetrievalCallBudget(cfg([{ name: "max_steps", variable: "4", type: "number" }]))).toBe(4);
  });

  it("accepts numeric values and floors them", () => {
    expect(resolveRetrievalCallBudget(cfg([{ name: "max_steps", variable: 6.7, type: "number" }]))).toBe(6);
  });

  it("returns undefined for unset, zero, negative, or garbage values", () => {
    expect(resolveRetrievalCallBudget(undefined)).toBeUndefined();
    expect(resolveRetrievalCallBudget([] as any)).toBeUndefined();
    expect(resolveRetrievalCallBudget(cfg([]))).toBeUndefined();
    expect(resolveRetrievalCallBudget(cfg([{ name: "max_steps", variable: "0", type: "number" }]))).toBeUndefined();
    expect(resolveRetrievalCallBudget(cfg([{ name: "max_steps", variable: "-3", type: "number" }]))).toBeUndefined();
    expect(resolveRetrievalCallBudget(cfg([{ name: "max_steps", variable: "banana", type: "number" }]))).toBeUndefined();
  });

  it("ignores other tools' configs", () => {
    const configs = [{ id: "other_tool", type: "function", name: "x", config: [{ name: "max_steps", variable: "9", type: "number" }] }] as any;
    expect(resolveRetrievalCallBudget(configs)).toBeUndefined();
  });

  it("prefers hydrated value over raw variable when present", () => {
    expect(resolveRetrievalCallBudget(cfg([{ name: "max_steps", variable: "2", value: 8, type: "number" } as any]))).toBe(8);
  });
});

import { flattenToolHistory } from "./resolve-max-steps";

describe("finalAnswerGuard", () => {
  it("does nothing before the last budgeted step", () => {
    const guard = finalAnswerGuard(4);
    expect(guard({ stepNumber: 0 })).toBeUndefined();
    expect(guard({ stepNumber: 2 })).toBeUndefined();
  });

  it("on the final step strips tools and flattens history with an answer-now instruction", () => {
    const guard = finalAnswerGuard(3);
    const messages = [
      { role: "user", content: "Frage?" },
      { role: "assistant", content: [{ type: "tool-call", toolName: "search", input: { q: "x" } }] },
      { role: "tool", content: [{ type: "tool-result", toolName: "search", output: { value: "RESULT TEXT" } }] },
    ];
    const r = guard({ stepNumber: 2, messages }) as any;
    expect(r.toolChoice).toBe("none");
    expect(r.activeTools).toEqual([]);
    const msgs = r.messages as any[];
    // No old bracket-syntax templates survive in history (scoped to all but final instruction)
    const history = JSON.stringify((msgs as any[]).slice(0, -1));
    expect(history).not.toContain("tool-call");
    expect(history).not.toContain("tool-result");
    expect(msgs.find((m) => m.role === "tool")).toBeUndefined();
    // Tool results became readable text, original user turn intact
    expect(msgs[2]).toEqual({ role: "user", content: expect.stringContaining("RESULT TEXT") });
    expect(msgs[0]).toEqual({ role: "user", content: "Frage?" });
    // Trailing answer-now instruction
    expect(msgs[msgs.length - 1].content).toContain("Do not attempt any further tool calls");
  });

  it("flattens non-retrieval tool history (bash/code-execution shape from the client trace)", () => {
    const guard = finalAnswerGuard(5);
    const messages = [
      { role: "user", content: "Bitte analysiere die hochgeladene Datei." },
      { role: "assistant", content: [{ type: "tool-call", toolName: "bash", input: { command: "pandoc Serviceanfragen.docx -t plain -o out.txt" } }] },
      { role: "tool", content: [{ type: "tool-result", toolName: "bash", output: { value: { stdout: "TUERANTRIEB DEFEKT\n", stderr: "", exitCode: 0 } } }] },
      { role: "assistant", content: [
        { type: "text", text: "Ich schreibe nun das Analyse-Skript." },
        { type: "tool-call", toolName: "write_file", input: { path: "analyze.py" } },
      ] },
      { role: "tool", content: [{ type: "tool-result", toolName: "write_file", output: { value: "ok" } }] },
    ];
    const r = guard({ stepNumber: 4, messages }) as any;
    const msgs = r.messages as any[];
    // No old bracket-syntax templates survive in history (scoped to all but final instruction)
    const history = JSON.stringify((msgs as any[]).slice(0, -1));
    expect(history).not.toContain("tool-call");
    expect(history).not.toContain("tool-result");
    // tool outputs survive as readable text, mixed text parts survive too
    expect(JSON.stringify(msgs)).toContain("TUERANTRIEB DEFEKT");
    expect(JSON.stringify(msgs)).toContain("Ich schreibe nun das Analyse-Skript.");
    expect(JSON.stringify(msgs)).toContain("write_file");
  });

  it("instructs the model to disclose the step limit when the task is unfinished", () => {
    const guard = finalAnswerGuard(3);
    const r = guard({ stepNumber: 2, messages: [{ role: "user", content: "Frage?" }] }) as any;
    const instruction = r.messages[r.messages.length - 1].content as string;
    expect(instruction).toContain("maximum number of tool steps");
  });

  it("exposes a platform default step budget of 10", () => {
    expect(DEFAULT_MAX_STEPS).toBe(10);
  });

  it("omits the messages override when none are provided (sync callers)", () => {
    const guard = finalAnswerGuard(3);
    expect(guard({ stepNumber: 5 })).toEqual({ toolChoice: "none", activeTools: [] });
  });

  it("flattens history as prose — no copyable tool-call templates (mimicry hardening)", () => {
    const guard = finalAnswerGuard(3);
    const messages = [
      { role: "user", content: "Frage?" },
      { role: "assistant", content: [{ type: "tool-call", toolName: "bash", input: { command: "ls" } }] },
      { role: "tool", content: [{ type: "tool-result", toolName: "bash", output: { value: "file.pdf" } }] },
    ];
    const r = guard({ stepNumber: 2, messages }) as any;
    const msgs = r.messages as any[];
    // No generic tool-call-shaped templates in history (scoped to all but final instruction)
    const history = JSON.stringify((msgs as any[]).slice(0, -1));
    expect(history).not.toContain("[called tool");
    expect(history).not.toContain("[result of");
    expect(history).not.toContain("[searched");
    // Use unescaped text for flexible assertions (fallback approach from brief)
    const texts = (msgs).map((m) => String(m.content)).join("\n");
    // prose phrasing present, content preserved
    expect(texts).toContain("ran the \"bash\" tool with input");
    expect(texts).toContain("The \"bash\" tool returned");
    expect(texts).toContain("file.pdf");
    // the instruction forbids tool-call-shaped output
    const instruction = msgs[msgs.length - 1].content as string;
    expect(instruction).toContain("normal prose");
    expect(instruction).toContain("[called tool ...]");
  });
});

describe("resolveTurnStepBudget", () => {
  it("uses the explicit maxStepCount argument first", () => {
    expect(resolveTurnStepBudget(4, { max_tool_steps: 7 })).toBe(4);
    expect(resolveTurnStepBudget(4.9, undefined)).toBe(4);
  });

  it("falls back to the agent's max_tool_steps column", () => {
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: 7 })).toBe(7);
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: 7.9 })).toBe(7);
    // pg number columns can surface as strings depending on driver config
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: "12" as never })).toBe(12);
  });

  it("returns the platform default for unset/zero/negative/garbage", () => {
    expect(resolveTurnStepBudget(undefined, undefined)).toBe(DEFAULT_MAX_STEPS);
    expect(resolveTurnStepBudget(undefined, {})).toBe(DEFAULT_MAX_STEPS);
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: null })).toBe(DEFAULT_MAX_STEPS);
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: 0 })).toBe(DEFAULT_MAX_STEPS);
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: -3 })).toBe(DEFAULT_MAX_STEPS);
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: "banana" as never })).toBe(DEFAULT_MAX_STEPS);
    expect(resolveTurnStepBudget(0, { max_tool_steps: 0 })).toBe(DEFAULT_MAX_STEPS);
  });
});

describe("flattenToolHistory", () => {
  it("passes plain user/system messages through untouched", () => {
    const msgs = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
    expect(flattenToolHistory(msgs)).toEqual(msgs);
  });

  it("falls back to placeholders for empty structured content", () => {
    const r = flattenToolHistory([
      { role: "assistant", content: [] },
      { role: "tool", content: [] },
    ]) as any[];
    expect(r[0].content).toBe("(searching)");
    expect(r[1]).toEqual({ role: "user", content: "(tool results)" });
  });
});

describe("retrievalBudgetGuard", () => {
  const step = (...toolNames: string[]) => ({ toolCalls: toolNames.map((toolName) => ({ toolName })) });
  const KEYS = ["Context_Search", "bash", "writeFile"];

  it("is inert without a limit, without a key, or when the key is not registered", async () => {
    expect(await retrievalBudgetGuard(undefined, "Context_Search", KEYS)({ stepNumber: 1, steps: [step("Context_Search")] })).toBeUndefined();
    expect(await retrievalBudgetGuard(0, "Context_Search", KEYS)({ stepNumber: 1, steps: [step("Context_Search")] })).toBeUndefined();
    expect(await retrievalBudgetGuard(1, undefined, KEYS)({ stepNumber: 1, steps: [step("Context_Search")] })).toBeUndefined();
    expect(await retrievalBudgetGuard(1, "not_registered", KEYS)({ stepNumber: 1, steps: [step("not_registered")] })).toBeUndefined();
  });

  it("is inert while calls are under the limit", async () => {
    const guard = retrievalBudgetGuard(2, "Context_Search", KEYS);
    expect(await guard({ stepNumber: 0, steps: [] })).toBeUndefined();
    expect(await guard({ stepNumber: 1, steps: [step("Context_Search"), step("bash")] })).toBeUndefined();
  });

  it("removes ONLY the agentic tool once the limit is reached, on every later step", async () => {
    const guard = retrievalBudgetGuard(2, "Context_Search", KEYS);
    const spent = [step("Context_Search"), step("Context_Search")];
    expect(await guard({ stepNumber: 2, steps: spent })).toEqual({ activeTools: ["bash", "writeFile"] });
    // re-asserted on later steps too (activeTools applies per-step)
    expect(await guard({ stepNumber: 5, steps: [...spent, step("bash")] })).toEqual({ activeTools: ["bash", "writeFile"] });
  });

  it("counts multiple calls within one step", async () => {
    const guard = retrievalBudgetGuard(2, "Context_Search", KEYS);
    expect(await guard({ stepNumber: 1, steps: [step("Context_Search", "Context_Search")] })).toEqual({ activeTools: ["bash", "writeFile"] });
  });

  it("composes so finalAnswerGuard still strips ALL tools on the last step", async () => {
    const composed = composePrepareSteps(
      retrievalBudgetGuard(1, "Context_Search", KEYS),
      finalAnswerGuard(5),
    );
    const spent = [step("Context_Search")];
    // mid-turn: retrieval hidden, other tools alive
    expect(((await composed({ stepNumber: 2, steps: spent })) as { activeTools: string[] }).activeTools).toEqual(["bash", "writeFile"]);
    // final step: finalAnswerGuard's [] wins the shallow merge
    expect(((await composed({ stepNumber: 4, steps: spent })) as { activeTools: string[] }).activeTools).toEqual([]);
  });
});
