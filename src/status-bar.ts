/**
 * Status Bar — shows the QueryMT agent connection state in the VS Code
 * status bar. Clicking it opens a context menu with quick actions.
 */

import * as vscode from "vscode";
import type { AcpClient } from "./acp-client.js";

export type AgentState = "disconnected" | "connecting" | "connected" | "error";

export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private acpClient: AcpClient;
  private currentState: AgentState = "disconnected";
  private lastUsage:
    | { size: number; used: number; cost?: { amount: number; currency: string } | null }
    | undefined;

  constructor(acpClient: AcpClient) {
    this.acpClient = acpClient;

    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = "querymt.statusBarMenu";
    this.item.name = "QueryMT Agent Status";
    this.update("disconnected");
    this.item.show();

    // Poll connection state every 3 seconds
    this.pollTimer = setInterval(() => {
      const newState: AgentState = this.acpClient.isConnected
        ? "connected"
        : "disconnected";
      if (newState !== this.currentState) {
        this.update(newState);
      }
    }, 3000);
  }

  update(state: AgentState): void {
    this.currentState = state;
    this.lastUsage = undefined; // clear usage on state change
    switch (state) {
      case "disconnected":
        this.item.text = "$(circle-slash) QueryMT";
        this.item.tooltip = "QueryMT agent: disconnected";
        this.item.backgroundColor = undefined;
        break;
      case "connecting":
        this.item.text = "$(sync~spin) QueryMT";
        this.item.tooltip = "QueryMT agent: connecting...";
        this.item.backgroundColor = undefined;
        break;
      case "connected":
        this.item.text = "$(check) QueryMT";
        this.item.tooltip = "QueryMT agent: connected";
        this.item.backgroundColor = undefined;
        break;
      case "error":
        this.item.text = "$(error) QueryMT";
        this.item.tooltip = "QueryMT agent: error (click for options)";
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        break;
    }
  }

  /** Update the status bar with token usage information. */
  updateUsage(usage: {
    size: number;
    used: number;
    cost?: { amount: number; currency: string } | null;
  }): void {
    this.lastUsage = usage;

    if (usage.used === 0 && usage.size === 0) {
      // Reset to normal connected state
      this.update(this.currentState);
      return;
    }

    // Format token count compactly: 45000 → "45k"
    const usedK = Math.round(usage.used / 1000);
    const sizeK = Math.round(usage.size / 1000);
    this.item.text = `$(check) QueryMT ${usedK}k/${sizeK}k`;

    let tooltip = `QueryMT agent: connected\nTokens: ${usage.used.toLocaleString()} / ${usage.size.toLocaleString()}`;
    if (usage.cost) {
      tooltip += `\nCost: ${usage.cost.amount.toFixed(2)} ${usage.cost.currency}`;
    }
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.item.dispose();
  }
}

/**
 * Register the status bar menu command.
 */
export function registerStatusBarCommand(
  acpClient: AcpClient,
  statusBar: StatusBar,
): vscode.Disposable {
  return vscode.commands.registerCommand("querymt.statusBarMenu", async () => {
    const isConnected = acpClient.isConnected;

    const items: vscode.QuickPickItem[] = [
      {
        label: isConnected ? "$(check) Connected" : "$(circle-slash) Disconnected",
        description: "Agent status",
        kind: vscode.QuickPickItemKind.Separator,
      },
      {
        label: "$(refresh) Restart Agent",
        description: "Restart the QueryMT agent process",
      },
      {
        label: "$(output) Show Logs",
        description: "Open the QueryMT output channel",
      },
      {
        label: "$(gear) Manage Provider",
        description: "Configure binary path, model, provider",
      },
      {
        label: "$(key) Sign In to Provider",
        description: "Start OAuth sign-in for supported providers",
      },
      {
        label: "$(sign-out) Sign Out of Provider",
        description: "Disconnect OAuth credentials",
      },
      {
        label: "$(shield) Show Auth Status",
        description: "List authentication status for providers",
      },
      {
        label: "$(sync) Refresh Models",
        description: "Re-fetch available models from all providers",
      },
    ];

    const selected = await vscode.window.showQuickPick(items, {
      title: "QueryMT Agent",
      placeHolder: "Select an action",
    });

    if (!selected) return;

    if (selected.label.includes("Restart Agent")) {
      await vscode.commands.executeCommand("querymt.restart");
    } else if (selected.label.includes("Show Logs")) {
      await vscode.commands.executeCommand("querymt.showLogs");
    } else if (selected.label.includes("Manage Provider")) {
      await vscode.commands.executeCommand("querymt.manageProvider");
    } else if (selected.label.includes("Sign In to Provider")) {
      await vscode.commands.executeCommand("querymt.signInProvider");
    } else if (selected.label.includes("Sign Out of Provider")) {
      await vscode.commands.executeCommand("querymt.signOutProvider");
    } else if (selected.label.includes("Show Auth Status")) {
      await vscode.commands.executeCommand("querymt.authStatus");
    } else if (selected.label.includes("Refresh Models")) {
      await vscode.commands.executeCommand("querymt.refreshModels");
    }
  });
}
