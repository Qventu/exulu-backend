import {
  createUIMessageStream,
  type IdGenerator,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamOnFinishCallback,
} from "ai";

/**
 * The ONLY module coupled to Hermes' HTTP wire format.
 *
 * It drives a Hermes "run" (POST /v1/runs → SSE /v1/runs/{id}/events) and
 * translates Hermes' run events into AI SDK v6 UIMessage stream chunks, so the
 * existing `useChat` frontend consumes advanced-mode output unchanged.
 *
 * IMPORTANT: the exact Hermes run event names/payloads are documented but not
 * yet verified against a live gateway (Phase 0 spike). Everything that depends
 * on the wire format is funnelled through `normalizeEvent()` and
 * `translateEvent()` below — when the real shapes are confirmed, those two
 * functions are the only things that change.
 *
 * Design doc: docs/superpowers/specs/2026-06-03-hermes-agent-mode-design.md
 */

export type HermesUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
};

export type HermesRunStreamParams = {
  /** Gateway base URL, e.g. http://127.0.0.1:8651/v1 (from the supervisor). */
  baseUrl: string;
  /** Per-gateway API key (from the supervisor). */
  apiKey: string;
  /** Hermes session id carried via X-Hermes-Session-Id (our external identity). */
  hermesSessionId: string;
  /** Optional per-request model override (LiteLLM model_name). */
  model?: string;
  /** OpenAI-style messages for the run request. */
  messages: Array<{ role: string; content: string }>;
  /** Original UI messages — enables persistence-mode id assignment. */
  originalMessages: UIMessage[];
  generateId: IdGenerator;
  onError: (error: unknown) => string;
  onFinish: UIMessageStreamOnFinishCallback<UIMessage>;
  /** Aborts the run + event stream when the client disconnects. */
  signal?: AbortSignal;
};

const log = (line: string) => console.log(`[EXULU-HERMES-RUN] ${line}`);

/**
 * Minimal text extraction from UI message parts → an OpenAI-style message.
 * Phase 2 is text-only; tool-call history round-tripping comes with Phase 3.
 */
export const uiMessagesToOpenAI = (
  messages: UIMessage[],
): Array<{ role: string; content: string }> =>
  messages.map((m) => ({
    role: m.role,
    content: (m.parts ?? [])
      .map((p: any) => (p?.type === "text" ? p.text : ""))
      .join(""),
  }));

/** A normalized event the translator understands, decoupled from wire names. */
type NormalizedEvent =
  | { kind: "text"; delta: string }
  | { kind: "reasoning"; delta: string }
  | { kind: "tool-start"; toolCallId: string; toolName: string; input?: unknown }
  | { kind: "tool-end"; toolCallId: string; output: unknown }
  | { kind: "approval"; approvalId: string; toolCallId: string }
  | { kind: "finish"; usage?: HermesUsage }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

/**
 * Map a raw Hermes SSE record onto a NormalizedEvent. Tolerant by design: it
 * accepts several plausible field spellings because the live shapes aren't yet
 * pinned. Adjust HERE (and nowhere else) once verified against a real gateway.
 */
export const normalizeEvent = (
  eventName: string | undefined,
  data: any,
): NormalizedEvent => {
  const type = (eventName ?? data?.type ?? data?.event ?? "").toString();

  // text deltas
  const text =
    data?.delta?.text ?? data?.delta ?? data?.text ?? data?.content ?? undefined;
  if (
    /(message\.delta|output_text\.delta|text\.delta|^token$|^delta$)/i.test(type) &&
    typeof text === "string"
  ) {
    return { kind: "text", delta: text };
  }

  if (/reasoning/i.test(type)) {
    const r = data?.delta ?? data?.text ?? "";
    if (typeof r === "string" && r.length > 0) return { kind: "reasoning", delta: r };
  }

  if (/tool.*(start|call)/i.test(type)) {
    return {
      kind: "tool-start",
      toolCallId: String(data?.tool_call_id ?? data?.id ?? data?.toolCallId ?? ""),
      toolName: String(data?.tool_name ?? data?.name ?? data?.toolName ?? "tool"),
      input: data?.input ?? data?.arguments ?? data?.args,
    };
  }

  if (/tool.*(complete|result|output|end)/i.test(type)) {
    return {
      kind: "tool-end",
      toolCallId: String(data?.tool_call_id ?? data?.id ?? data?.toolCallId ?? ""),
      output: data?.output ?? data?.result ?? data?.content,
    };
  }

  if (/approval/i.test(type)) {
    return {
      kind: "approval",
      approvalId: String(data?.approval_id ?? data?.approvalId ?? data?.id ?? ""),
      toolCallId: String(data?.tool_call_id ?? data?.toolCallId ?? ""),
    };
  }

  if (/(run\.(completed|finished|succeeded)|^done$|^finish$|completed)/i.test(type)) {
    const u = data?.usage ?? data?.tokens;
    const usage: HermesUsage | undefined = u
      ? {
          inputTokens: u.input_tokens ?? u.prompt_tokens ?? u.inputTokens,
          outputTokens: u.output_tokens ?? u.completion_tokens ?? u.outputTokens,
          totalTokens: u.total_tokens ?? u.totalTokens,
          reasoningTokens: u.reasoning_tokens ?? u.reasoningTokens,
          cachedInputTokens: u.cache_read_tokens ?? u.cachedInputTokens,
        }
      : undefined;
    return { kind: "finish", usage };
  }

  if (/(run\.(failed|error)|^error$)/i.test(type)) {
    return {
      kind: "error",
      message: String(data?.error ?? data?.message ?? "Hermes run error"),
    };
  }

  return { kind: "ignore" };
};

/** Per-run translation state (open text block id, surfaced usage). */
type TranslateState = { textId: string | undefined; usage: HermesUsage | undefined };

/** Write the UIMessage chunks for one normalized event. Returns true on finish. */
const translateEvent = (
  ev: NormalizedEvent,
  writer: { write: (c: UIMessageChunk) => void },
  state: TranslateState,
  generateId: IdGenerator,
): boolean => {
  switch (ev.kind) {
    case "text": {
      if (!state.textId) {
        state.textId = generateId();
        writer.write({ type: "text-start", id: state.textId });
      }
      writer.write({ type: "text-delta", id: state.textId, delta: ev.delta });
      return false;
    }
    case "reasoning": {
      const id = generateId();
      writer.write({ type: "reasoning-start", id });
      writer.write({ type: "reasoning-delta", id, delta: ev.delta });
      writer.write({ type: "reasoning-end", id });
      return false;
    }
    case "tool-start": {
      writer.write({
        type: "tool-input-available",
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        input: ev.input ?? {},
        dynamic: true,
      });
      return false;
    }
    case "tool-end": {
      writer.write({
        type: "tool-output-available",
        toolCallId: ev.toolCallId,
        output: ev.output,
        dynamic: true,
      });
      return false;
    }
    case "approval": {
      writer.write({
        type: "tool-approval-request",
        approvalId: ev.approvalId,
        toolCallId: ev.toolCallId,
      });
      return false;
    }
    case "finish": {
      state.usage = ev.usage;
      return true;
    }
    case "error": {
      writer.write({ type: "error", errorText: ev.message });
      return true;
    }
    default:
      return false;
  }
};

/** Parse a fetch ReadableStream of SSE bytes into {event,data} records. */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE records are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event: string | undefined;
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) yield { event, data: dataLines.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** POST /v1/runs and return the run id. */
const startRun = async (
  params: HermesRunStreamParams,
): Promise<string> => {
  const res = await fetch(`${params.baseUrl}/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
      "X-Hermes-Session-Id": params.hermesSessionId,
    },
    body: JSON.stringify({
      messages: params.messages,
      ...(params.model ? { model: params.model } : {}),
      stream: true,
    }),
    signal: params.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hermes POST /runs failed (${res.status}): ${text}`);
  }
  const json: any = await res.json().catch(() => ({}));
  const runId = json?.run_id ?? json?.id ?? json?.runId;
  if (!runId) throw new Error("Hermes POST /runs returned no run_id.");
  return String(runId);
};

/**
 * Build a UIMessage stream that drives a Hermes run and translates its events.
 * The caller pipes the returned stream to the HTTP response.
 */
export const createHermesRunStream = (
  params: HermesRunStreamParams,
): ReadableStream<UIMessageChunk> =>
  createUIMessageStream<UIMessage>({
    originalMessages: params.originalMessages,
    generateId: params.generateId,
    onError: params.onError,
    onFinish: params.onFinish,
    execute: async ({ writer }) => {
      const state: TranslateState = { textId: undefined, usage: undefined };
      writer.write({ type: "start" });

      const runId = await startRun(params);
      log(`run ${runId} started for session ${params.hermesSessionId}`);

      const eventsRes = await fetch(`${params.baseUrl}/runs/${runId}/events`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          Accept: "text/event-stream",
        },
        signal: params.signal,
      });
      if (!eventsRes.ok || !eventsRes.body) {
        const text = await eventsRes.text().catch(() => "");
        throw new Error(
          `Hermes GET /runs/${runId}/events failed (${eventsRes.status}): ${text}`,
        );
      }

      let finished = false;
      for await (const record of parseSse(eventsRes.body, params.signal)) {
        let data: any = record.data;
        try {
          data = JSON.parse(record.data);
        } catch {
          // some events may send a bare string payload
        }
        const ev = normalizeEvent(record.event, data);
        const isFinish = translateEvent(ev, writer, state, params.generateId);
        if (isFinish) {
          finished = true;
          break;
        }
      }

      if (state.textId) writer.write({ type: "text-end", id: state.textId });
      writer.write({
        type: "finish",
        ...(state.usage
          ? {
              messageMetadata: {
                totalTokens: state.usage.totalTokens,
                inputTokens: state.usage.inputTokens,
                outputTokens: state.usage.outputTokens,
                reasoningTokens: state.usage.reasoningTokens,
                cachedInputTokens: state.usage.cachedInputTokens,
              } as any,
            }
          : {}),
      });
      if (!finished) log(`run for session ${params.hermesSessionId} ended without an explicit finish event`);
    },
  });
