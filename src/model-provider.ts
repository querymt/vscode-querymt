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

interface AgentModelInfo {
  id: string;
  name: string;
  family: string;
  version: string;
  provider: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: {
    imageInput?: boolean;
    toolCalling?: boolean;
  };
}

interface AgentModelsResponse {
  models: AgentModelInfo[];
}

interface AgentChatRequest {
  modelId: string;
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
  options?: Record<string, unknown>;
}

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

      return (resp.models ?? []).map(
        (m): QueryMTModelInfo => ({
          id: m.id,
          modelId: m.id,
          name: m.name,
          family: m.family,
          version: m.version,
          maxInputTokens: m.maxInputTokens,
          maxOutputTokens: m.maxOutputTokens,
          capabilities: {
            imageInput: m.capabilities.imageInput ?? false,
            toolCalling: m.capabilities.toolCalling ?? false,
          },
        }),
      );
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
