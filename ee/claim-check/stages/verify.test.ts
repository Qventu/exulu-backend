jest.mock("@EE/agentic-retrieval/pipeline/micro-call", () => ({
  microCall: jest.fn(),
  microCallProviderOptions: jest.fn(),
}));
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { runVerification } from "./verify";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS } from "../types";
import type { EvidenceSnippet } from "../types";

const EVIDENCE: EvidenceSnippet[] = [
  { sourceId: "s1", sourceName: "handbuch.pdf", text: "Die FST-2XT arbeitet mit 230 Volt.", score: 3 },
  { sourceId: "s2", sourceName: "ticket.txt", text: "Die Tür wurde am 3. März getauscht.", score: 1 },
];

const CLAIMS = [
  { id: "c1", text: "Die FST-2XT arbeitet mit 230 Volt." },
  { id: "c2", text: "Die FST-2XT arbeitet mit 400 Volt." },
  { id: "c3", text: "Die FST-2XT wiegt 12 Kilogramm." },
];

beforeEach(() => (microCall as jest.Mock).mockReset());

describe("runVerification", () => {
  it("maps the three verdicts and echoes the evidence source ids", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        claims: [
          { claimId: "c1", verdict: "supported", evidence: [{ sourceId: "s1", quote: "arbeitet mit 230 Volt" }], rationale: "snippet states it" },
          { claimId: "c2", verdict: "contradicted", evidence: [{ sourceId: "s1", quote: "arbeitet mit 230 Volt" }], rationale: "snippet says 230 V" },
          { claimId: "c3", verdict: "unsupported", evidence: [], rationale: "no snippet mentions weight" },
        ],
      },
      text: "",
      usage: { inputTokens: 1100, outputTokens: 200 },
    });

    const { outcomes, usage } = await runVerification({ claims: CLAIMS, evidence: EVIDENCE, model: {} as any });

    expect(usage).toEqual({ calls: 1, inputTokens: 1100, outputTokens: 200 });
    expect(outcomes.map((o) => o.verdict)).toEqual(["supported", "contradicted", "unsupported"]);
    expect(outcomes[0]!.evidence).toEqual([{ sourceId: "s1", quote: "arbeitet mit 230 Volt" }]);
  });

  it("returns unsupported for every claim WITHOUT calling the model when there is no evidence", async () => {
    const { outcomes, usage } = await runVerification({ claims: CLAIMS, evidence: [], model: {} as any });
    expect(microCall).not.toHaveBeenCalled();
    expect(usage).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
    expect(outcomes.every((o) => o.verdict === "unsupported")).toBe(true);
    expect(outcomes[0]!.rationale).toBe("no evidence was available for this claim");
  });

  it("treats an omitted claim as unsupported rather than supported", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: { claims: [{ claimId: "c1", verdict: "supported", evidence: [], rationale: "ok" }] },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { outcomes } = await runVerification({ claims: CLAIMS, evidence: EVIDENCE, model: {} as any });
    expect(outcomes).toHaveLength(3);
    expect(outcomes[1]).toEqual({
      claimId: "c2",
      verdict: "unsupported",
      evidence: [],
      rationale: "no verdict returned for this claim",
    });
  });

  it("drops evidence citations for source ids that were not in the prompt", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        claims: [{ claimId: "c1", verdict: "supported", evidence: [{ sourceId: "s9", quote: "erfunden" }], rationale: "cites a source that was never shown" }],
      },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { outcomes } = await runVerification({ claims: [CLAIMS[0]!], evidence: EVIDENCE, model: {} as any });
    expect(outcomes[0]!.evidence).toEqual([]);
    expect(outcomes[0]!.verdict).toBe("supported");
  });

  it("numbers the snippets and names their sources in the prompt", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { claims: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    await runVerification({ claims: CLAIMS, evidence: EVIDENCE, model: {} as any });
    const prompt = String((microCall as jest.Mock).mock.calls[0][0].prompt);
    expect(prompt).toContain("s1");
    expect(prompt).toContain("handbuch.pdf");
    expect(prompt).toContain("c1");
  });

  it("passes the raised output cap and uses temperature 0", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: { claims: [] },
      text: "",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await runVerification({ claims: CLAIMS, evidence: EVIDENCE, model: {} as any });
    const args = (microCall as jest.Mock).mock.calls[0][0];
    expect(args.maxOutputTokens).toBe(CLAIM_CHECK_MAX_OUTPUT_TOKENS);
    expect(args.temperature).toBe(0);
  });

  it("returns nothing for an empty claim list, without calling the model", async () => {
    const { outcomes, usage } = await runVerification({
      claims: [],
      evidence: EVIDENCE,
      model: {} as any,
    });
    expect(microCall).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
    expect(usage).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
  });
});
