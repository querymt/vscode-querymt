/**
 * Webview Chat Panel — provides a standalone chat UI that works on any
 * VS Code-compatible host (including VSCodium / Open VSX) without
 * requiring the proprietary Chat Participant or Language Model APIs.
 *
 * Registered as a WebviewViewProvider so it can live in the sidebar,
 * secondary sidebar, or bottom panel — wherever the user drags it.
 *
 * Communicates with the ACP client to manage sessions, models, and
 * config options, streaming agent responses back to the webview.
 */

import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AcpClient } from "./acp-client.js";
import type { StatusBar } from "./status-bar.js";
import type { SessionNotification, SessionUpdate, ContentBlock } from "@agentclientprotocol/sdk";
import { createLogger, formatError } from "./logger.js";
import {
  selectOptionItems,
  getSelectCurrentValue,
  fetchModelList,
} from "./config-options.js";

const log = createLogger("webview-chat");

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "querymt.chatView";

  private view: vscode.WebviewView | undefined;
  private updateSubscription: vscode.Disposable | undefined;
  private activeSessionId: string | undefined;
  private isPrompting = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly acpClient: AcpClient,
    private readonly statusBar?: StatusBar,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(join(this.context.extensionPath, "media")),
      ],
    };

    // Load the HTML template from disk
    const htmlPath = join(this.context.extensionPath, "media", "webview-chat.html");
    webviewView.webview.html = readFileSync(htmlPath, "utf-8");

    // ── Handle messages from webview ──

    webviewView.webview.onDidReceiveMessage(
      async (msg: WebviewMessage) => {
        try {
          await this.handleWebviewMessage(msg);
        } catch (err) {
          log.error(`Webview message handler error: ${formatError(err)}`);
          this.postToWebview({ type: "error", message: formatError(err) });
        }
      },
    );

    // ── Subscribe to session updates ──

    this.updateSubscription = this.acpClient.onSessionUpdate(
      (params: SessionNotification) => {
        if (params.sessionId !== this.activeSessionId) return;

        // Keep config options in sync
        if (params.update.sessionUpdate === "config_option_update") {
          this.acpClient.updateSessionConfigOptions(
            params.sessionId,
            params.update.configOptions,
          );
          this.sendConfigOptions(params.sessionId);
        }

        // Forward usage updates to the status bar
        if (params.update.sessionUpdate === "usage_update" && this.statusBar) {
          const u = params.update as any;
          this.statusBar.updateUsage({
            size: u.size ?? 0,
            used: u.used ?? 0,
            cost: u.cost ?? undefined,
          });
        }

        // Update session title
        if (params.update.sessionUpdate === "session_info_update") {
          const info = params.update as any;
          if (info.title) {
            this.sendSessionList();
          }
        }

        this.renderUpdateToWebview(params.update);
      },
    );

    // ── Cleanup on dispose ──

    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.activeSessionId = undefined;
      this.isPrompting = false;
      this.updateSubscription?.dispose();
      this.updateSubscription = undefined;
    });
  }

  /** Programmatically focus the view (used by the openChat command). */
  focus(): void {
    if (this.view) {
      this.view.show?.(true);
    }
  }

  // ── Webview message types ──

  private async handleWebviewMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.onReady();
        break;

      case "prompt":
        await this.onPrompt(msg.text as string);
        break;

      case "newSession":
        await this.onNewSession();
        break;

      case "switchSession":
        await this.onSwitchSession(msg.sessionId as string);
        break;

      case "setModel":
        await this.onSetModel(msg.modelId as string);
        break;

      case "setConfigOption":
        await this.onSetConfigOption(
          msg.configId as string,
          msg.value as string,
        );
        break;

      case "cancel":
        await this.onCancel();
        break;

      case "fileSearch":
        await this.onFileSearch(msg.query as string);
        break;

      default:
        log.warn(`Unknown webview message type: ${msg.type}`);
    }
  }

  // ── Handlers ──

  private async onReady(): Promise<void> {
    // Ensure the agent is running
    if (!this.acpClient.isConnected) {
      this.postToWebview({ type: "status", state: "loading" });
      try {
        await this.acpClient.start();
      } catch (err) {
        this.postToWebview({
          type: "error",
          message: `Failed to start agent: ${formatError(err)}`,
        });
        return;
      }
    }

    // Send initial state
    await this.sendSessionList();
    await this.sendModelList();

    // If there's already an active session, load its config options
    if (this.activeSessionId) {
      this.sendConfigOptions(this.activeSessionId);
    } else {
      // Auto-create a session
      await this.onNewSession();
    }

    this.postToWebview({ type: "status", state: "idle" });
  }

  private async onPrompt(text: string): Promise<void> {
    if (!text.trim() || this.isPrompting) return;

    // Ensure connected
    if (!this.acpClient.isConnected) {
      try {
        await this.acpClient.start();
      } catch (err) {
        this.postToWebview({
          type: "error",
          message: `Failed to start agent: ${formatError(err)}`,
        });
        return;
      }
    }

    // Ensure we have a session
    if (!this.activeSessionId) {
      await this.onNewSession();
      if (!this.activeSessionId) return;
    }

    this.isPrompting = true;
    this.postToWebview({ type: "status", state: "streaming" });

    // Resolve @file references and build content blocks
    const resourceBlocks = await this.resolveFileReferences(text);
    const contentBlocks: ContentBlock[] = [
      { type: "text", text },
      ...resourceBlocks,
    ];

    try {
      const result = await this.acpClient.prompt(this.activeSessionId, contentBlocks);
      log.info(`Prompt completed: stopReason=${result.stopReason}`);
    } catch (err) {
      const message = formatError(err);
      if (message !== "Cancelled") {
        this.postToWebview({ type: "error", message });
      }
    } finally {
      this.isPrompting = false;
      this.postToWebview({ type: "done" });
      this.postToWebview({ type: "status", state: "idle" });
    }
  }

  private async onNewSession(): Promise<void> {
    if (!this.acpClient.isConnected) {
      try {
        await this.acpClient.start();
      } catch (err) {
        this.postToWebview({
          type: "error",
          message: `Failed to start agent: ${formatError(err)}`,
        });
        return;
      }
    }

    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    try {
      const sessionId = await this.acpClient.newSession(cwd);
      this.activeSessionId = sessionId;
      log.info(`New session created: ${sessionId}`);

      // Apply default model from settings
      const resolvedModel = resolveDefaultModel();
      if (resolvedModel) {
        try {
          await this.acpClient.setModel(sessionId, resolvedModel);
        } catch {
          // non-fatal
        }
      }

      this.postToWebview({ type: "clear" });
      await this.sendSessionList();
      this.sendConfigOptions(sessionId);
      await this.sendModelList();
    } catch (err) {
      this.postToWebview({
        type: "error",
        message: `Failed to create session: ${formatError(err)}`,
      });
    }
  }

  private async onSwitchSession(sessionId: string): Promise<void> {
    if (sessionId === this.activeSessionId) return;

    try {
      await this.acpClient.loadSession(sessionId);
      this.activeSessionId = sessionId;
      this.postToWebview({ type: "clear" });
      await this.sendSessionList();
      this.sendConfigOptions(sessionId);
      await this.sendModelList();
      log.info(`Switched to session: ${sessionId}`);
    } catch (err) {
      this.postToWebview({
        type: "error",
        message: `Failed to load session: ${formatError(err)}`,
      });
    }
  }

  private async onSetModel(modelId: string): Promise<void> {
    if (!this.activeSessionId) return;

    try {
      await this.acpClient.setModel(this.activeSessionId, modelId);
      log.info(`Model set to: ${modelId}`);
    } catch (err) {
      this.postToWebview({
        type: "error",
        message: `Failed to set model: ${formatError(err)}`,
      });
    }
  }

  private async onSetConfigOption(
    configId: string,
    value: string,
  ): Promise<void> {
    if (!this.activeSessionId) return;

    try {
      await this.acpClient.setSessionConfigOption(this.activeSessionId, configId, value);
      log.info(`Config option ${configId} set to: ${value}`);
      this.sendConfigOptions(this.activeSessionId);
    } catch (err) {
      this.postToWebview({
        type: "error",
        message: `Failed to set ${configId}: ${formatError(err)}`,
      });
    }
  }

  private async onCancel(): Promise<void> {
    if (!this.activeSessionId || !this.isPrompting) return;

    try {
      await this.acpClient.cancel(this.activeSessionId);
      log.info(`Cancelled session: ${this.activeSessionId}`);
    } catch {
      // ignore cancel errors
    }
  }

  private async onFileSearch(query: string): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    const files: Array<{ name: string; path: string }> = [];

    if (!query || query.length === 0) {
      // Empty query: show recently opened editors first, then workspace files
      const seen = new Set<string>();

      // Gather open editor tabs
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input;
          if (input && typeof input === "object" && "uri" in input) {
            const uri = (input as { uri: vscode.Uri }).uri;
            if (uri.scheme !== "file") continue;
            const relativePath = workspaceRoot
              ? vscode.workspace.asRelativePath(uri, false)
              : uri.fsPath;
            if (seen.has(relativePath)) continue;
            seen.add(relativePath);
            files.push({
              name: uri.path.split("/").pop() ?? relativePath,
              path: relativePath,
            });
            if (files.length >= 20) break;
          }
        }
        if (files.length >= 20) break;
      }

      // Fill up with workspace files if fewer than 20 open editors
      if (files.length < 20) {
        const uris = await vscode.workspace.findFiles(
          "**/*",
          "**/node_modules/**",
          20 - files.length,
        );
        for (const uri of uris) {
          const relativePath = workspaceRoot
            ? vscode.workspace.asRelativePath(uri, false)
            : uri.fsPath;
          if (seen.has(relativePath)) continue;
          seen.add(relativePath);
          files.push({
            name: uri.path.split("/").pop() ?? relativePath,
            path: relativePath,
          });
        }
      }
    } else {
      // Query present: search by glob pattern
      const pattern = `**/*${query}*`;
      const uris = await vscode.workspace.findFiles(
        pattern,
        "**/node_modules/**",
        20,
      );
      for (const uri of uris) {
        const relativePath = workspaceRoot
          ? vscode.workspace.asRelativePath(uri, false)
          : uri.fsPath;
        files.push({
          name: uri.path.split("/").pop() ?? relativePath,
          path: relativePath,
        });
      }
    }

    this.postToWebview({ type: "fileSuggestions", files });
  }

  /** Maximum file size to embed inline (1 MB). */
  private static readonly MAX_EMBED_BYTES = 1024 * 1024;

  /**
   * Extract @file references from the prompt text, resolve them to workspace
   * files, read their content, and return resource content blocks.
   */
  private async resolveFileReferences(
    text: string,
  ): Promise<ContentBlock[]> {
    const mentions = [...text.matchAll(/@([\w.\/\\-]+)/g)];
    if (mentions.length === 0) return [];

    const resourceBlocks: ContentBlock[] = [];
    const seen = new Set<string>();

    for (const match of mentions) {
      const ref = match[1];
      if (seen.has(ref)) continue;
      seen.add(ref);

      const uris = await vscode.workspace.findFiles(
        `**/${ref}`,
        "**/node_modules/**",
        1,
      );
      if (uris.length === 0) continue;

      const uri = uris[0];
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > ChatViewProvider.MAX_EMBED_BYTES) {
          resourceBlocks.push({
            type: "resource_link",
            uri: uri.toString(),
            name: uri.path.split("/").pop() ?? ref,
          });
        } else {
          const raw = await vscode.workspace.fs.readFile(uri);
          resourceBlocks.push({
            type: "resource",
            resource: {
              uri: uri.toString(),
              text: Buffer.from(raw).toString("utf-8"),
            },
          });
        }
      } catch (err) {
        log.warn(
          `Failed to read @${ref}: ${formatError(err)}`,
        );
      }
    }

    return resourceBlocks;
  }

  // ── State senders ──

  private async sendSessionList(): Promise<void> {
    if (!this.acpClient.isConnected) return;

    try {
      const resp = (await this.acpClient.listSessions()) as {
        sessions?: Array<{
          sessionId: string;
          title?: string | null;
          cwd?: string;
          updatedAt?: string | null;
        }>;
      };

      const sessions = (resp.sessions ?? []).map((s) => ({
        id: s.sessionId,
        title: s.title || s.cwd || s.sessionId,
        updatedAt: s.updatedAt ?? undefined,
      }));

      this.postToWebview({
        type: "sessions",
        sessions,
        activeId: this.activeSessionId ?? "",
      });
    } catch (err) {
      log.warn(`Failed to list sessions: ${formatError(err)}`);
    }
  }

  private async sendModelList(): Promise<void> {
    const models = await fetchModelList(this.acpClient);
    this.postToWebview({
      type: "models",
      models,
      activeId: "",
    });
  }

  private sendConfigOptions(sessionId: string): void {
    const configOptions = this.acpClient.getSessionConfigOptions(sessionId);

    const options: Array<{
      configId: string;
      label: string;
      items: Array<{ value: string; label: string }>;
      currentValue: string;
    }> = [];

    for (const configId of ["mode", "reasoning_effort"]) {
      const items = selectOptionItems(configOptions, configId);
      if (items.length === 0) continue;

      options.push({
        configId,
        label: configId === "mode" ? "Mode" : "Effort",
        items: items.map((i) => ({ value: i.value, label: i.label })),
        currentValue: getSelectCurrentValue(configOptions, configId) ?? "",
      });
    }

    this.postToWebview({ type: "configOptions", options });
  }

  // ── Session update rendering ──

  private renderUpdateToWebview(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content;
        if (content.type === "text") {
          this.postToWebview({ type: "chunk", text: content.text });
        }
        break;
      }

      case "agent_thought_chunk": {
        const content = update.content;
        if (content.type === "text" && content.text.trim().length > 0) {
          this.postToWebview({ type: "thought", text: content.text });
        }
        break;
      }

      case "tool_call": {
        const status = update.status ?? "running";
        this.postToWebview({
          type: "toolProgress",
          toolCallId: (update as any).toolCallId ?? update.title,
          title: update.title ?? "Tool call",
          status,
        });
        break;
      }

      case "tool_call_update": {
        const status = update.status;
        const toolCallId =
          (update as any).toolCallId ?? (update as any).title ?? "";

        this.postToWebview({
          type: "toolProgress",
          toolCallId,
          title: (update as any).title ?? "Tool call",
          status: status ?? "running",
        });

        // Send tool output as collapsible content targeted at this tool
        if (
          (status === "completed" || status === "failed") &&
          update.content &&
          update.content.length > 0
        ) {
          for (const item of update.content) {
            if (item.type === "content" && item.content.type === "text") {
              this.postToWebview({
                type: "toolContent",
                toolCallId,
                content: item.content.text,
                contentType: "text",
              });
            } else if (item.type === "diff") {
              this.postToWebview({
                type: "toolContent",
                toolCallId,
                content: `${item.path}\n${item.oldText ?? ""}\u2192\n${item.newText ?? ""}`,
                contentType: "diff",
              });
            }
          }
        }
        break;
      }

      case "plan": {
        if (update.entries) {
          const lines = update.entries.map((entry) => {
            const check = entry.status === "completed" ? "x" : " ";
            return `- [${check}] ${entry.content}`;
          });
          this.postToWebview({ type: "chunk", text: `\n${lines.join("\n")}\n` });
        }
        break;
      }

      // Informational updates — no rendering needed
      case "user_message_chunk":
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
        break;

      default:
        break;
    }
  }

  // ── Helpers ──

  private postToWebview(msg: Record<string, unknown>): void {
    this.view?.webview.postMessage(msg);
  }
}

// ── Module-level helpers ──

interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

function resolveDefaultModel(): string | undefined {
  const config = vscode.workspace.getConfiguration("querymt");
  const defaultModel = config.get<string>("defaultModel");
  if (!defaultModel) return undefined;

  if (defaultModel.includes("/")) {
    return defaultModel;
  }

  const defaultProvider = config.get<string>("defaultProvider");
  return defaultProvider ? `${defaultProvider}/${defaultModel}` : defaultModel;
}
