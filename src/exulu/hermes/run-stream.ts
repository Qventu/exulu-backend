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
  /**
   * The user's input for this turn. Hermes' /v1/runs follows the OpenAI
   * Responses API: a single `input` string (the model is server-side via
   * config.yaml), with history carried by the session, not re-sent.
   */
  input: string;
  /** Original UI messages — enables persistence-mode id assignment. */
  originalMessages: UIMessage[];
  generateId: IdGenerator;
  onError: (error: unknown) => string;
  onFinish: UIMessageStreamOnFinishCallback<UIMessage>;
  /** Aborts the run + event stream when the client disconnects. */
  signal?: AbortSignal;
};

const log = (line: string) => console.log(`[EXULU-HERMES-RUN] ${line}`);

/** Concatenate the text parts of a single UI message into a plain string. */
export const uiMessageText = (message: UIMessage | undefined): string =>
  (message?.parts ?? [])
    .map((p: any) => (p?.type === "text" ? p.text : ""))
    .join("");

/** A normalized event the translator understands, decoupled from wire names. */
type NormalizedEvent =
  | { kind: "text"; delta: string }
  | { kind: "reasoning"; delta: string }
  // Two tool-call shapes are supported:
  //  - Hermes-native: `tool.started`/`tool.completed` — name only (data.tool),
  //    no id and no streamed args; paired by order via a LIFO stack.
  //  - OpenAI Responses streaming: an item is added (name known), arguments
  //    stream in as text deltas, then finalize. Identified by `itemId`.
  | {
      kind: "tool-start";
      itemId?: string;
      toolCallId?: string;
      toolName: string;
      input?: unknown;
    }
  | { kind: "tool-args-delta"; itemId: string; delta: string }
  | { kind: "tool-args-done"; itemId: string; toolCallId?: string; arguments: unknown }
  | { kind: "tool-end"; toolCallId?: string; output: unknown; isError?: boolean }
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

  // --- Tool calls (OpenAI Responses streaming sequence) ---
  // Argument deltas/done must be matched BEFORE the generic function_call branch
  // so they aren't mistaken for new tool starts.
  if (/function_call_arguments\.delta/i.test(type)) {
    return {
      kind: "tool-args-delta",
      itemId: String(data?.item_id ?? data?.id ?? ""),
      delta: String(data?.delta ?? ""),
    };
  }
  if (/function_call_arguments\.done/i.test(type)) {
    return {
      kind: "tool-args-done",
      itemId: String(data?.item_id ?? data?.id ?? ""),
      arguments: data?.arguments,
    };
  }

  // An output item was added/done. Inspect the nested item to tell a function
  // call (tool start) from its output (tool result).
  const item = data?.item;
  if (/output_item\.(added|done)/i.test(type) && item) {
    const itemType = String(item.type ?? "");
    if (/function_call_output|tool.*output/i.test(itemType)) {
      return {
        kind: "tool-end",
        toolCallId: String(item.call_id ?? item.id ?? ""),
        output: item.output ?? item.result ?? item.content,
      };
    }
    if (/function_call|tool/i.test(itemType)) {
      // On ".done" the full arguments are present → finalize; on ".added" the
      // name is known but args may be empty → start.
      if (/\.done/i.test(type) && item.arguments !== undefined) {
        return {
          kind: "tool-args-done",
          itemId: String(item.id ?? ""),
          toolCallId: String(item.call_id ?? item.id ?? ""),
          arguments: item.arguments,
        };
      }
      return {
        kind: "tool-start",
        itemId: String(item.id ?? ""),
        toolCallId: String(item.call_id ?? item.id ?? ""),
        toolName: String(item.name ?? item.tool_name ?? "tool"),
      };
    }
  }

  // Tool result (flat / Hermes-native). Checked before the start branch because
  // "function_call_output" also contains "function_call".
  if (/(function_call_output|tool.*(complete|result|output|end))/i.test(type)) {
    const explicitId =
      data?.tool_call_id ?? data?.call_id ?? data?.id ?? data?.toolCallId;
    // Hermes-native `tool.completed` carries no result payload — only the tool
    // name, a duration, and an error flag. Build a small completion summary so
    // the UI shows something meaningful in the result slot.
    const output =
      data?.output ??
      data?.result ??
      data?.content ??
      (data?.tool != null || data?.duration != null
        ? {
            ok: !data?.error,
            ...(typeof data?.duration === "number"
              ? { duration_s: data.duration }
              : {}),
          }
        : undefined);
    return {
      kind: "tool-end",
      ...(explicitId != null ? { toolCallId: String(explicitId) } : {}),
      output,
      isError: !!data?.error,
    };
  }

  // Tool start (flat / Hermes-native). Hermes puts the name in `tool` and an
  // optional human-readable `preview` (e.g. `recall: "..."`), with no id/args.
  if (/(function_call|tool.*(start|call))/i.test(type)) {
    const explicitId =
      data?.tool_call_id ?? data?.call_id ?? data?.id ?? data?.toolCallId;
    const preview = data?.preview;
    return {
      kind: "tool-start",
      ...(explicitId != null
        ? { itemId: String(explicitId), toolCallId: String(explicitId) }
        : {}),
      toolName: String(
        data?.tool_name ?? data?.name ?? data?.toolName ?? data?.tool ?? "tool",
      ),
      input:
        data?.input ??
        data?.arguments ??
        data?.args ??
        (preview != null ? { preview } : undefined),
    };
  }

  if (/approval/i.test(type)) {
    return {
      kind: "approval",
      approvalId: String(data?.approval_id ?? data?.approvalId ?? data?.id ?? ""),
      toolCallId: String(data?.tool_call_id ?? data?.toolCallId ?? ""),
    };
  }

  if (
    /(run\.(completed|finished|succeeded)|response\.(completed|done)|^done$|^finish$|completed)/i.test(
      type,
    )
  ) {
    const u = data?.usage ?? data?.tokens ?? data?.response?.usage;
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

  if (/(run\.(failed|error)|response\.(failed|error)|failed|^error$)/i.test(type)) {
    return {
      kind: "error",
      message: String(
        data?.error?.message ?? data?.error ?? data?.message ?? "Hermes run error",
      ),
    };
  }

  return { kind: "ignore" };
};

/** Per-run translation state (open text block id, in-flight tools, usage). */
type TranslateState = {
  textId: string | undefined;
  usage: HermesUsage | undefined;
  /** itemId → tool identity, so argument deltas/done resolve back to a call. */
  tools: Map<string, { toolCallId: string; toolName: string }>;
  /**
   * LIFO stack of tool calls opened without an id (Hermes-native
   * tool.started → tool.completed), so a completion can be paired with the most
   * recently started call.
   */
  openTools: Array<{ toolCallId: string; toolName: string }>;
};

/** Parse a tool's accumulated argument string into a structured input. */
const parseToolInput = (raw: unknown): unknown => {
  if (raw == null) return {};
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // keep the raw string if it isn't valid JSON
  }
};

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
      // Synthesize an id when Hermes doesn't supply one (its native events have
      // no call id); pair it on completion via the LIFO stack.
      const toolCallId = ev.toolCallId && ev.toolCallId.length ? ev.toolCallId : generateId();
      if (ev.itemId) {
        state.tools.set(ev.itemId, { toolCallId, toolName: ev.toolName });
      }
      state.openTools.push({ toolCallId, toolName: ev.toolName });
      // Surface the tool name to the UI immediately (streaming-input start).
      writer.write({
        type: "tool-input-start",
        toolCallId,
        toolName: ev.toolName,
        dynamic: true,
      });
      // Emit input now when it's already known (Hermes native, no later args)
      // or when the start carried full input. Responses-style calls (with an
      // itemId and no input yet) wait for their argument-done event instead.
      if (ev.input !== undefined || !ev.itemId) {
        writer.write({
          type: "tool-input-available",
          toolCallId,
          toolName: ev.toolName,
          input: parseToolInput(ev.input),
          dynamic: true,
        });
      }
      return false;
    }
    case "tool-args-delta": {
      const t = state.tools.get(ev.itemId);
      if (t) {
        writer.write({
          type: "tool-input-delta",
          toolCallId: t.toolCallId,
          inputTextDelta: ev.delta,
        });
      }
      return false;
    }
    case "tool-args-done": {
      const t = state.tools.get(ev.itemId);
      const toolCallId = t?.toolCallId ?? ev.toolCallId ?? ev.itemId;
      writer.write({
        type: "tool-input-available",
        toolCallId,
        toolName: t?.toolName ?? "tool",
        input: parseToolInput(ev.arguments),
        dynamic: true,
      });
      return false;
    }
    case "tool-end": {
      // Resolve the call id: explicit (Responses) or the most recently opened
      // (Hermes native). Without either we can't correlate, so skip.
      let toolCallId = ev.toolCallId && ev.toolCallId.length ? ev.toolCallId : undefined;
      if (toolCallId) {
        const idx = state.openTools.findIndex((t) => t.toolCallId === toolCallId);
        if (idx !== -1) state.openTools.splice(idx, 1);
      } else {
        toolCallId = state.openTools.pop()?.toolCallId;
      }
      if (!toolCallId) return false;
      if (ev.isError) {
        const out = ev.output;
        const errorText =
          typeof out === "string"
            ? out
            : out != null
              ? JSON.stringify(out)
              : "Tool failed";
        writer.write({ type: "tool-output-error", toolCallId, errorText });
        return false;
      }
      writer.write({
        type: "tool-output-available",
        toolCallId,
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
      input: params.input,
      // Session continuity: also pass it in the body (the X-Hermes-Session-Id
      // header carries it too) so Hermes recalls this conversation's history.
      session_id: params.hermesSessionId,
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
      const state: TranslateState = {
        textId: undefined,
        usage: undefined,
        tools: new Map(),
        openTools: [],
      };
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
        if (process.env.HERMES_DEBUG_EVENTS === "true") {
          // Bring-up aid: dump every event and how it mapped, so the wire format
          // can be pinned. The finish/error payloads are logged in full (no
          // truncation) so a usage object after a long `output` is visible.
          const preview =
            ev.kind === "finish" || ev.kind === "error"
              ? record.data
              : record.data.slice(0, 600);
          log(`event=${record.event ?? "(none)"} -> ${ev.kind} :: ${preview}`);
        }
        const isFinish = translateEvent(ev, writer, state, params.generateId);
        if (isFinish) {
          finished = true;
          break;
        }
      }

      if (process.env.HERMES_DEBUG_EVENTS === "true") {
        log(`run finished. extracted usage=${JSON.stringify(state.usage)}`);
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
