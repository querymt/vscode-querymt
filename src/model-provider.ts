/**
 * Language Model Chat Provider — exposes QueryMT's LLM providers (Anthropic,
 * OpenAI, local llama.cpp, etc.) in VS Code's model picker so Copilot and
 * other extensions can use them.
 *
 * Communication with the agent uses two custom ACP extension methods:
 *   - `_querymt/models` (client → agent): list available models
 *   - `_querymt/chat`   (client → agent): one-shot chat completion
 */

import * as vscode from "vscode";
import { createLogger, formatError } from "./logger.js";
import type { AcpClient } from "./acp-client.js";

// ── Types for agent ↔ extension model protocol ──

/** Mirrors the `ModelEntry` shape returned by the qmtcode agent. */
interface AgentModelEntry {
  /** Canonical internal identifier */
  id: string;
  /** Human-readable display label */
  label: string;
  /** Model source: "preset", "cached", "custom", "catalog" */
  source: string;
  /** Provider name */
  provider: string;
  /** Original model identifier (for backwards compatibility) */
  model: string;
  /** Stable node id where this provider lives */
  node_id?: string;
  /** Human-readable node label for display purposes */
  node_label?: string;
  /** Model family/repo for grouping */
  family?: string;
  /** Quantization level (e.g., "Q8_0", "Q6_K", "unknown") */
  quant?: string;
}

interface AgentModelsResponse {
  models: AgentModelEntry[];
}

/** Wire shape of ModelInfo as serialized by serde (capabilities flattened). */
interface AgentModelInfo {
  id: string;
  name: string;
  // Capabilities are flattened to top-level by serde
  tool_call: boolean;
  attachment: boolean;
  reasoning: boolean;
  temperature: boolean;
  modalities: { input: string[]; output: string[] };
  // Limits (renamed from "limits" to "limit" by serde)
  limit: { context?: number; output?: number };
  // Pricing (renamed from "pricing" to "cost" by serde)
  cost: { input?: number; output?: number };
  // Metadata
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  open_weights?: boolean;
}

interface AgentModelInfoResponse {
  models: Record<string, AgentModelInfo | null>;
}

interface AgentChatRequest {
  modelId: string;
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
  options?: Record<string, unknown>;
}

// ── Sensible defaults when agent doesn't report token limits ──

const DEFAULT_MAX_INPUT_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

// ── Model info type that extends VS Code's interface ──

interface QueryMTModelInfo extends vscode.LanguageModelChatInformation {
  readonly modelId: string; // our internal model ID for the agent
}

// ── Provider implementation ──

export class QueryMTModelProvider
  implements vscode.LanguageModelChatProvider<QueryMTModelInfo>
{
  private acpClient: AcpClient;
  private readonly log = createLogger("model-provider");
  private _onDidChange = new vscode.EventEmitter<void>();

  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  constructor(acpClient: AcpClient) {
    this.acpClient = acpClient;
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<QueryMTModelInfo[]> {
    if (!this.acpClient.isConnected) {
      this.log.debug("Agent not connected, returning empty model list");
      return [];
    }

    try {
      const resp = (await this.acpClient.extMethod(
        "_querymt/models",
        {},
      )) as unknown as AgentModelsResponse;

      const valid = (resp.models ?? []).filter((m) => {
        if (!m.id) {
          this.log.warn(`Skipping model with missing id: ${JSON.stringify(m)}`);
          return false;
        }
        return true;
      });

      // Fetch model metadata from providers registry in a single batch.
      const infoMap = await this.fetchModelInfo(valid);

      // Detect which base labels appear more than once so we can
      // prepend the provider name to disambiguate in the picker.
      const labelCounts = new Map<string, number>();
      for (const m of valid) {
        const base = m.label || m.model || m.id;
        labelCounts.set(base, (labelCounts.get(base) ?? 0) + 1);
      }

      return valid.map((m): QueryMTModelInfo => {
        const baseLabel = m.label || m.model || m.id;
        const isDuplicate = (labelCounts.get(baseLabel) ?? 0) > 1;
        const displayName = isDuplicate && m.provider
          ? `${baseLabel} (${m.provider})`
          : baseLabel;

        // Build informative detail + tooltip for the picker UI
        const detailParts: string[] = [];
        if (m.provider) detailParts.push(m.provider);
        if (m.source) detailParts.push(m.source);
        if (m.node_label) detailParts.push(m.node_label);
        const detail = detailParts.join(" \u2022 ") || undefined;

        const tooltip = m.id !== displayName ? m.id : undefined;

        // Resolve capabilities and limits from registry metadata
        const infoKey = `${m.provider}/${m.model}`;
        const info = infoMap.get(infoKey);

        return {
          id: m.id,
          modelId: m.id,
          name: displayName,
          family: m.family ?? m.provider ?? "",
          version: m.quant ?? "",
          maxInputTokens: info?.limit?.context ?? DEFAULT_MAX_INPUT_TOKENS,
          maxOutputTokens: info?.limit?.output ?? DEFAULT_MAX_OUTPUT_TOKENS,
          capabilities: {
            imageInput: info?.modalities?.input?.includes("image") ?? false,
            toolCalling: info?.tool_call ?? true,
          },
          ...(detail !== undefined && { detail }),
          ...(tooltip !== undefined && { tooltip }),
        };
      });
    } catch (err) {
      this.log.error("Failed to list models", err);
      return [];
    }
  }

  async provideLanguageModelChatResponse(
    model: QueryMTModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (!this.acpClient.isConnected) {
      throw new Error("QueryMT agent is not connected");
    }

    // Convert VS Code messages to a simple format for the agent
    const simpleMessages = messages.map((msg) => ({
      role: roleToString(msg.role),
      content: extractTextContent(msg.content),
    }));

    const chatReq: AgentChatRequest = {
      modelId: model.modelId,
      messages: simpleMessages,
      options: options.modelOptions ?? {},
    };

    try {
      const resp = (await this.acpClient.extMethod(
        "_querymt/chat",
        chatReq as unknown as Record<string, unknown>,
      )) as Record<string, unknown>;

      // The agent returns the full response text; emit it as a text part
      const text =
        (resp.text as string) ??
        (resp.content as string) ??
        JSON.stringify(resp);
      progress.report(new vscode.LanguageModelTextPart(text));
    } catch (err) {
      throw new Error(
        `QueryMT chat completion failed: ${formatError(err)}`,
      );
    }
  }

  async provideTokenCount(
    model: QueryMTModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    if (!this.acpClient.isConnected) {
      // Rough estimate: ~4 chars per token
      const str =
        typeof text === "string" ? text : extractTextContent(text.content);
      return Math.ceil(str.length / 4);
    }

    try {
      const textStr =
        typeof text === "string" ? text : extractTextContent(text.content);
      const resp = (await this.acpClient.extMethod("_querymt/tokenCount", {
        modelId: model.modelId,
        text: textStr,
      })) as Record<string, unknown>;

      return (resp.count as number) ?? Math.ceil(textStr.length / 4);
    } catch {
      // Fallback estimate
      const str =
        typeof text === "string" ? text : extractTextContent(text.content);
      return Math.ceil(str.length / 4);
    }
  }

  /**
   * Batch-fetch model metadata from the agent's providers registry.
   * Returns a map keyed by "provider/model" with ModelInfo or undefined.
   */
  private async fetchModelInfo(
    models: AgentModelEntry[],
  ): Promise<Map<string, AgentModelInfo>> {
    const result = new Map<string, AgentModelInfo>();

    // Deduplicate keys to avoid redundant lookups
    const uniqueKeys = new Map<string, { provider: string; model: string }>();
    for (const m of models) {
      if (m.provider && m.model) {
        const key = `${m.provider}/${m.model}`;
        if (!uniqueKeys.has(key)) {
          uniqueKeys.set(key, { provider: m.provider, model: m.model });
        }
      }
    }

    if (uniqueKeys.size === 0) return result;

    try {
      const resp = (await this.acpClient.extMethod("_querymt/modelInfo", {
        models: Array.from(uniqueKeys.values()),
      })) as unknown as AgentModelInfoResponse;

      if (resp?.models) {
        for (const [key, info] of Object.entries(resp.models)) {
          if (info) {
            result.set(key, info);
          }
        }
      }
    } catch (err) {
      this.log.warn(`Failed to fetch model info: ${formatError(err)}`);
    }

    return result;
  }

  /** Notify VS Code that available models have changed. */
  refreshModels(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }


}

// ── Helpers ──

function roleToString(role: vscode.LanguageModelChatMessageRole): string {
  switch (role) {
    case vscode.LanguageModelChatMessageRole.User:
      return "user";
    case vscode.LanguageModelChatMessageRole.Assistant:
      return "assistant";
    default:
      return "user";
  }
}

function extractTextContent(
  content: ReadonlyArray<unknown>,
): string {
  const parts: string[] = [];
  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push(part.value);
    } else if (
      typeof part === "object" &&
      part !== null &&
      "value" in part &&
      typeof (part as { value: unknown }).value === "string"
    ) {
      parts.push((part as { value: string }).value);
    }
  }
  return parts.join("");
}
