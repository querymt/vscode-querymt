/**
 * QueryMT VS Code Extension — entry point.
 *
 * Registers three integration surfaces:
 *   1. @querymt chat participant
 *   2. Language Model Chat Provider (exposes QueryMT LLM providers to VS Code)
 *   3. Workspace query handler (provides VS Code language intelligence to the agent)
 *
 * Manages the lifecycle of the ACP client subprocess.
 */

import * as vscode from "vscode";
import { AcpClient } from "./acp-client.js";
import { initLogger, createLogger, formatError } from "./logger.js";
import { registerChatParticipant } from "./chat-participant.js";
import { QueryMTModelProvider } from "./model-provider.js";
import { handleWorkspaceQuery } from "./workspace-query.js";
import { StatusBar, registerStatusBarCommand } from "./status-bar.js";
import type { WorkspaceQueryParams } from "./types.js";

let acpClient: AcpClient | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const logChannel = initLogger();
  context.subscriptions.push(logChannel);
  const log = createLogger("extension");
  log.info("QueryMT extension activating...");

  // ── ACP Client ──

  acpClient = new AcpClient(context.globalStorageUri.fsPath);
  context.subscriptions.push(acpClient);

  // Register the workspace query handler for reverse-RPC from the agent.
  // When the agent sends an ext_method `_workspace/query`, the SDK strips the
  // `_` prefix and delivers it as `workspace/query` to our extMethod handler.
  acpClient.setExtMethodHandler(
    async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      if (method === "workspace/query") {
        const result = await handleWorkspaceQuery(
          params as unknown as WorkspaceQueryParams,
        );
        return result as unknown as Record<string, unknown>;
      }
      throw new Error(`Unknown extension method: ${method}`);
    },
  );

  // ── Status Bar ──

  const statusBar = new StatusBar(acpClient);
  context.subscriptions.push(statusBar);
  context.subscriptions.push(registerStatusBarCommand(acpClient, statusBar));

  // ── Chat Participant ──

  const chatDisposables = registerChatParticipant(acpClient, statusBar);
  for (const d of chatDisposables) {
    context.subscriptions.push(d);
  }

  // ── Language Model Chat Provider ──

  const modelProvider = new QueryMTModelProvider(acpClient);
  const modelProviderDisposable =
    vscode.lm.registerLanguageModelChatProvider("querymt", modelProvider);
  context.subscriptions.push(modelProviderDisposable);

  // ── Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand("querymt.restart", async () => {
      try {
        await acpClient?.restart();
        vscode.window.showInformationMessage("QueryMT agent restarted.");
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to restart QueryMT agent: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("querymt.showLogs", () => {
      logChannel.show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("querymt.manageProvider", async () => {
      const config = vscode.workspace.getConfiguration("querymt");
      const items: vscode.QuickPickItem[] = [
        {
          label: "Set Binary Path",
          description: config.get<string>("binaryPath") || "(using PATH)",
        },
        {
          label: "Set Default Provider",
          description: config.get<string>("defaultProvider") || "anthropic",
        },
        {
          label: "Set Default Model",
          description:
            config.get<string>("defaultModel") || "claude-sonnet-4-20250514",
        },
        {
          label: "Set Config File",
          description: config.get<string>("configFile") || "(none)",
        },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        title: "QueryMT: Manage Provider Settings",
      });

      if (!selected) return;

      switch (selected.label) {
        case "Set Binary Path": {
          const value = await vscode.window.showInputBox({
            prompt: "Path to qmtcode binary (leave empty to use auto-discovery)",
            value: config.get<string>("binaryPath") || "",
          });
          if (value !== undefined) {
            await config.update(
              "binaryPath",
              value || undefined,
              vscode.ConfigurationTarget.Global,
            );
          }
          break;
        }
        case "Set Default Provider": {
          const value = await vscode.window.showInputBox({
            prompt: "Default LLM provider (e.g., anthropic, openai, llama_cpp)",
            value: config.get<string>("defaultProvider") || "anthropic",
          });
          if (value !== undefined) {
            await config.update(
              "defaultProvider",
              value,
              vscode.ConfigurationTarget.Global,
            );
          }
          break;
        }
        case "Set Default Model": {
          const value = await vscode.window.showInputBox({
            prompt: "Default model identifier",
            value:
              config.get<string>("defaultModel") || "claude-sonnet-4-20250514",
          });
          if (value !== undefined) {
            await config.update(
              "defaultModel",
              value,
              vscode.ConfigurationTarget.Global,
            );
          }
          break;
        }
        case "Set Config File": {
          const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { "TOML Config": ["toml"] },
            title: "Select QueryMT agent config file",
          });
          if (uris && uris.length > 0) {
            await config.update(
              "configFile",
              uris[0].fsPath,
              vscode.ConfigurationTarget.Global,
            );
          }
          break;
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("querymt.refreshModels", async () => {
      if (!acpClient?.isConnected) {
        vscode.window.showWarningMessage(
          "QueryMT agent is not connected. Cannot refresh models.",
        );
        return;
      }
      try {
        await acpClient!.extMethod("_querymt/refreshModels", {});
        modelProvider.refreshModels();
        vscode.window.showInformationMessage("QueryMT model list refreshed.");
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to refresh models: ${formatError(err)}`,
        );
      }
    }),
  );

  // ── Auto-start the agent ──
  // The agent is started lazily when the first chat message arrives,
  // but we can also attempt to start it eagerly if autoStart is enabled.
  const autoStart = vscode.workspace
    .getConfiguration("querymt")
    .get<boolean>("autoStart", true);

  if (autoStart && vscode.workspace.workspaceFolders?.length) {
    statusBar.update("connecting");
    acpClient.start()
      .then(() => {
        statusBar.update("connected");
      })
      .catch((err) => {
        statusBar.update("error");
        log.error(`Agent auto-start failed (will retry on first use)`, err);
      });
  }

  log.info("QueryMT extension activated.");
}

export function deactivate(): void {
  acpClient?.dispose();
  acpClient = undefined;
}
