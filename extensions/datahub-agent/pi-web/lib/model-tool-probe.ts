import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";

const ENTRY = "pi-web:model-tool-probe/1";
const active = new WeakMap<Pick<AgentSession, "sessionId">, AbortController>();
const PROMPT = "這是一次零工具執行的診斷，不是維護要求。請依本次實際收到的工具定義，產生 datahub_semantic 的 action=list_sources 工具呼叫，以確認結構化工具是否可用。執行端只收取這一個模型回應，絕不執行任何工具。不要準備、變更或發布任何內容。若本次沒有該工具，請直接說明。";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");

export function isModelToolProbeRunning(session: Pick<AgentSession, "sessionId">): boolean {
  return active.has(session);
}

export function abortModelToolProbe(session: Pick<AgentSession, "sessionId">): void {
  active.get(session)?.abort();
}

export async function probeModelTools(session: AgentSession, expectedSessionId: unknown) {
  if (typeof expectedSessionId !== "string" || session.sessionId !== expectedSessionId) {
    throw new Error("model_tool_probe_session_mismatch");
  }
  if (active.has(session) || session.isStreaming || session.isCompacting || session.isBashRunning || session.pendingMessageCount > 0 || session.agent.hasQueuedMessages()) {
    throw new Error("model_tool_probe_busy");
  }
  if (session.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === ENTRY)) {
    throw new Error("model_tool_probe_already_consumed_no_replay");
  }
  const source = session.agent;
  const state = source.state;
  const model = state.model;
  if (!model || typeof source.streamFunction !== "function") throw new Error("model_tool_probe_runtime_unavailable");
  const names = state.tools.map(tool => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(["datahub_catalog", "datahub_semantic"])) {
    throw new Error("model_tool_probe_requires_actual_semantic_governance_tools");
  }
  // Only descriptors enter Context. There is no Agent loop, tool dispatcher,
  // execute callback, prompt admission, foreground continuation or publication.
  const tools = state.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const controller = new AbortController();
  active.set(session, controller);
  const timeout = setTimeout(() => controller.abort(), 180_000);
  let payloadProof: unknown;
  try {
    const messages = await source.convertToLlm(structuredClone(state.messages));
    const context: Context = {
      systemPrompt: state.systemPrompt,
      tools,
      messages: [...messages, { role: "user", content: PROMPT, timestamp: Date.now() }],
    };
    // Consume durably BEFORE invoking the provider. Error/abort/unknown response
    // also consumes this probe. Existing history is never edited or retried.
    session.sessionManager.appendCustomEntry(ENTRY, {
      phase: "ATTEMPTED", sessionId: expectedSessionId,
      model: { provider: model.provider, id: model.id },
      tools: tools.map(tool => ({ name: tool.name, schemaSHA256: digest(tool.parameters) })),
      toolExecutions: 0, retryAllowed: false,
    });
    const onPayload = async (payload: unknown, targetModel: Model<Api>) => {
      const replacement = await source.onPayload?.(payload, targetModel);
      const finalPayload = replacement === undefined ? payload : replacement;
      const body = finalPayload as { model?: string; instructions?: string; tools?: Array<{ name?: string; parameters?: unknown }>; tool_choice?: unknown };
      payloadProof = {
        model: body.model,
        instructionsSHA256: digest(body.instructions),
        tools: Array.isArray(body.tools) ? body.tools.map(tool => ({ name: tool.name, schemaSHA256: digest(tool.parameters) })) : [],
        toolChoice: body.tool_choice,
      };
      return finalPayload;
    };
    const stream = await source.streamFunction(model, context, {
      apiKey: source.getApiKey ? await source.getApiKey(model.provider) : undefined,
      reasoning: state.thinkingLevel === "off" ? undefined : state.thinkingLevel,
      thinkingBudgets: source.thinkingBudgets,
      transport: source.transport,
      sessionId: source.sessionId,
      maxRetryDelayMs: source.maxRetryDelayMs,
      maxRetries: 0,
      signal: controller.signal,
      onPayload,
      onResponse: source.onResponse,
    });
    const response = await stream.result();
    const result = {
      schema: ENTRY, sessionId: expectedSessionId, status: response.stopReason,
      model: { provider: model.provider, id: model.id },
      payload: payloadProof,
      text: response.content.filter(block => block.type === "text").map(block => block.text).join("\n"),
      toolCalls: response.content.filter(block => block.type === "toolCall").map(block => ({ name: block.name, action: block.arguments.action })),
      error: response.errorMessage,
      usage: response.usage,
      providerInvocations: 1, toolExecutions: 0, nativeWrites: 0,
      retryAllowed: false,
    };
    session.sessionManager.appendCustomEntry(ENTRY, { phase: "RESULT", sessionId: expectedSessionId, status: result.status, payload: payloadProof, toolCalls: result.toolCalls, toolExecutions: 0, retryAllowed: false });
    return result;
  } finally {
    clearTimeout(timeout);
    active.delete(session);
  }
}
