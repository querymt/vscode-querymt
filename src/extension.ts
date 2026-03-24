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
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { AcpClient } from "./acp-client.js";
import { initLogger, createLogger, formatError } from "./logger.js";
import { registerChatParticipant } from "./chat-participant.js";
import { QueryMTModelProvider } from "./model-provider.js";
import { handleWorkspaceQuery } from "./workspace-query.js";
import { StatusBar, registerStatusBarCommand } from "./status-bar.js";
import { ChatViewProvider } from "./webview-chat.js";
import {
  checkForUpdate,
  ensureDownloadedBinary,
  type ReleaseChannel,
} from "./binary-manager.js";
import type { WorkspaceQueryParams } from "./types.js";

let acpClient: AcpClient | undefined;

const SUPPORTED_OAUTH_PROVIDERS = new Set([
  "anthropic",
  "google",
  "kimi-oauth",
  "codex",
]);

type OAuthStatus = "not_authenticated" | "expired" | "connected";

interface AuthProviderStatus {
  provider: string;
  display_name?: string;
  oauth_status?: OAuthStatus;
  supports_oauth?: boolean;
  has_stored_api_key?: boolean;
  has_env_api_key?: boolean;
  env_var_name?: string;
  preferred_method?: string;
}

interface StartFlowResult {
  flow_id: string;
  provider: string;
  authorization_url?: string;
  flow_kind?: string;
}

interface CompleteOrLogoutResult {
  provider?: string;
  success?: boolean;
  message?: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseAuthStatuses(payload: unknown): AuthProviderStatus[] {
  const obj = asObject(payload);
  if (!obj) {
    return [];
  }
  const providers = obj.providers;
  if (!Array.isArray(providers)) {
    return [];
  }
  return providers
    .map((p) => asObject(p))
    .filter((p): p is Record<string, unknown> => !!p)
    .filter((p) => typeof p.provider === "string")
    .map((p) => ({
      provider: p.provider as string,
      display_name:
        typeof p.display_name === "string" ? p.display_name : undefined,
      oauth_status:
        typeof p.oauth_status === "string"
          ? (p.oauth_status as OAuthStatus)
          : undefined,
      supports_oauth:
        typeof p.supports_oauth === "boolean" ? p.supports_oauth : undefined,
      has_stored_api_key:
        typeof p.has_stored_api_key === "boolean"
          ? p.has_stored_api_key
          : undefined,
      has_env_api_key:
        typeof p.has_env_api_key === "boolean" ? p.has_env_api_key : undefined,
      env_var_name:
        typeof p.env_var_name === "string" ? p.env_var_name : undefined,
      preferred_method:
        typeof p.preferred_method === "string" ? p.preferred_method : undefined,
    }));
}

function parseStartFlowResult(payload: unknown): StartFlowResult {
  const p = asObject(payload);
  if (!p) {
    return { flow_id: "", provider: "" };
  }
  return {
    flow_id: typeof p.flow_id === "string" ? p.flow_id : "",
    provider: typeof p.provider === "string" ? p.provider : "",
    authorization_url:
      typeof p.authorization_url === "string"
        ? p.authorization_url
        : undefined,
    flow_kind: typeof p.flow_kind === "string" ? p.flow_kind : undefined,
  };
}

function parseCompleteOrLogoutResult(
  payload: unknown,
): CompleteOrLogoutResult {
  const p = asObject(payload);
  if (!p) {
    return {};
  }
  return {
    provider: typeof p.provider === "string" ? p.provider : undefined,
    success: typeof p.success === "boolean" ? p.success : undefined,
    message: typeof p.message === "string" ? p.message : undefined,
  };
}

async function fetchAuthStatuses(client: AcpClient): Promise<AuthProviderStatus[]> {
  const payload = await client.extMethod("_querymt/auth/status", {});
  return parseAuthStatuses(payload);
}

async function pickOAuthProvider(client: AcpClient): Promise<AuthProviderStatus | undefined> {
  const statuses = await fetchAuthStatuses(client);
  const oauthProviders = statuses
    .filter((s) => s.supports_oauth)
    .filter((s) => SUPPORTED_OAUTH_PROVIDERS.has(s.provider));

  if (oauthProviders.length === 0) {
    vscode.window.showWarningMessage(
      "No supported OAuth providers are available in the current agent configuration.",
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    oauthProviders.map((s) => ({
      label: s.display_name || s.provider,
      detail: s.provider,
      description: `oauth: ${s.oauth_status || "unknown"}`,
      status: s,
    })),
    {
      title: "QueryMT: Select OAuth Provider",
      placeHolder: "Choose a provider",
    },
  );

  return picked?.status;
}

async function waitForRedirectCompletion(
  client: AcpClient,
  provider: string,
): Promise<"connected" | "cancelled" | "timed_out"> {
  const POLL_INTERVAL_MS = 2000;
  const MAX_POLLS = 60; // 2 minutes

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Waiting for ${provider} sign-in to complete...`,
      cancellable: true,
    },
    async (_progress, token) => {
      for (let i = 0; i < MAX_POLLS; i++) {
        if (token.isCancellationRequested) {
          return "cancelled";
        }

        const statuses = await fetchAuthStatuses(client);
        const match = statuses.find((s) => s.provider === provider);
        if (match?.oauth_status === "connected") {
          vscode.window.showInformationMessage(
            `Successfully authenticated with ${match.display_name || provider}.`,
          );
          return "connected";
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      return "timed_out";
    },
  );
}

async function promptAndCompleteOAuthFlow(
  client: AcpClient,
  flowId: string,
  provider: string,
): Promise<boolean> {
  const response = await vscode.window.showInputBox({
    prompt:
      "Paste the callback URL, authorization code, or device code to complete sign-in",
    placeHolder: "callback URL or code",
    ignoreFocusOut: true,
  });
  if (response === undefined || response.trim().length === 0) {
    vscode.window.showInformationMessage(
      `Sign-in for ${provider} cancelled.`,
    );
    return false;
  }

  const payload = await client.extMethod("_querymt/auth/complete", {
    flow_id: flowId,
    response,
  });
  const result = parseCompleteOrLogoutResult(payload);
  if (result.success) {
    vscode.window.showInformationMessage(
      result.message || `Successfully authenticated with ${provider}.`,
    );
    return true;
  }

  vscode.window.showErrorMessage(
    result.message || `Failed to complete sign-in for ${provider}.`,
  );
  return false;
}

function authStatusIcon(s: AuthProviderStatus): string {
  if (s.supports_oauth) {
    switch (s.oauth_status) {
      case "connected":
        return "$(pass-filled)";
      case "expired":
        return "$(warning)";
      case "not_authenticated":
        return "$(circle-slash)";
      default:
        return "$(question)";
    }
  }
  if (s.has_env_api_key || s.has_stored_api_key) {
    return "$(key)";
  }
  return "$(circle-slash)";
}

function authStatusDescription(s: AuthProviderStatus): string {
  const parts: string[] = [];
  if (s.supports_oauth) {
    switch (s.oauth_status) {
      case "connected":
        parts.push("OAuth connected");
        break;
      case "expired":
        parts.push("OAuth expired");
        break;
      case "not_authenticated":
        parts.push("OAuth not authenticated");
        break;
      default:
        parts.push("OAuth unknown");
    }
  }
  if (s.has_env_api_key) {
    parts.push(`env: ${s.env_var_name || "set"}`);
  } else if (s.has_stored_api_key) {
    parts.push("API key stored");
  } else if (!s.supports_oauth) {
    parts.push("no credentials");
  }
  return parts.join(" | ");
}

function authStatusDetail(s: AuthProviderStatus): string | undefined {
  const parts: string[] = [];
  if (s.env_var_name) {
    parts.push(`env var: ${s.env_var_name}`);
  }
  if (s.preferred_method) {
    parts.push(`preferred: ${s.preferred_method}`);
  }
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

function getSelectConfigOptions(
  options: SessionConfigOption[],
  configId: string,
): Array<{ label: string; value: string; description?: string }> {
  let config: SessionConfigOption | undefined;
  for (const option of options) {
    if (option.id === configId && option.type === "select") {
      config = option;
      break;
    }
  }
  if (!config || config.type !== "select") {
    return [];
  }

  const result: Array<{ label: string; value: string; description?: string }> = [];
  for (const optionOrGroup of config.options) {
    if ("options" in optionOrGroup) {
      for (const grouped of optionOrGroup.options) {
        result.push({
          label: grouped.name,
          value: grouped.value,
          description: grouped.description ?? undefined,
        });
      }
    } else {
      result.push({
        label: optionOrGroup.name,
        value: optionOrGroup.value,
        description: optionOrGroup.description ?? undefined,
      });
    }
  }

  return result;
}

async function pickAndSetSessionSelectOption(
  client: AcpClient,
  configId: string,
  label: string,
): Promise<void> {
  const sessionId = client.getLastActiveSessionId();
  if (!sessionId) {
    vscode.window.showInformationMessage(
      `No active QueryMT session. Start a chat first, then set ${label.toLowerCase()}.`,
    );
    return;
  }

  const options = getSelectConfigOptions(
    client.getSessionConfigOptions(sessionId),
    configId,
  );
  if (options.length === 0) {
    vscode.window.showWarningMessage(
      `${label} is not available for the active session.`,
    );
    return;
  }

  const selected = await vscode.window.showQuickPick(
    options.map((o) => ({
      label: o.label,
      description: o.description,
      detail: o.value,
      value: o.value,
    })),
    {
      title: `QueryMT: Set ${label}`,
      placeHolder: `Select ${label.toLowerCase()} for the active chat session`,
      ignoreFocusOut: true,
    },
  );

  if (!selected) {
    return;
  }

  await client.setSessionConfigOption(sessionId, configId, selected.value);
  vscode.window.showInformationMessage(
    `${label} set to ${selected.label}.`,
  );
}

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

  // ── Chat Participant (VS Code only — not available in VSCodium) ──

  const hasChatApi =
    typeof vscode.chat?.createChatParticipant === "function";
  if (hasChatApi) {
    const chatDisposables = registerChatParticipant(acpClient, statusBar);
    for (const d of chatDisposables) {
      context.subscriptions.push(d);
    }
  } else {
    log.info(
      "Chat participant API not available — using webview chat panel",
    );
  }

  // ── Language Model Chat Provider (VS Code only) ──

  const hasLmApi =
    typeof vscode.lm?.registerLanguageModelChatProvider === "function";
  let modelProvider: QueryMTModelProvider | undefined;
  if (hasLmApi) {
    modelProvider = new QueryMTModelProvider(acpClient);
    const modelProviderDisposable =
      vscode.lm.registerLanguageModelChatProvider("querymt", modelProvider);
    context.subscriptions.push(modelProviderDisposable);
  } else {
    log.info("Language model provider API not available — skipping");
  }

  // ── Webview Chat View (works everywhere — sidebar, panel, secondary sidebar) ──

  const chatViewProvider = new ChatViewProvider(context, acpClient!, statusBar);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewId,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("querymt.openChat", () => {
      vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    }),
  );

  // If the chat participant API is not available, auto-open the webview
  // on first activation so users have an immediate entrypoint.
  if (!hasChatApi) {
    vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

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
    vscode.commands.registerCommand("querymt.setMode", async () => {
      if (!acpClient?.isConnected) {
        vscode.window.showWarningMessage(
          "QueryMT agent is not connected. Start a chat request first.",
        );
        return;
      }
      try {
        await pickAndSetSessionSelectOption(acpClient, "mode", "Mode");
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to set mode: ${formatError(err)}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("querymt.setReasoningEffort", async () => {
      if (!acpClient?.isConnected) {
        vscode.window.showWarningMessage(
          "QueryMT agent is not connected. Start a chat request first.",
        );
        return;
      }
      try {
        await pickAndSetSessionSelectOption(
          acpClient,
          "reasoning_effort",
          "Reasoning Effort",
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to set reasoning effort: ${formatError(err)}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("querymt.signInProvider", async () => {
      if (!acpClient?.isConnected) {
        vscode.window.showWarningMessage(
          "QueryMT agent is not connected. Cannot start sign-in.",
        );
        return;
      }

      try {
        const providerStatus = await pickOAuthProvider(acpClient);
        if (!providerStatus) {
          return;
        }

        const startPayload = await acpClient.extMethod("_querymt/auth/start", {
          provider: providerStatus.provider,
        });
        const start = parseStartFlowResult(startPayload);
        if (!start.flow_id) {
          vscode.window.showErrorMessage(
            `Sign-in for ${providerStatus.provider} failed: missing flow id in response.`,
          );
          return;
        }

        const providerName = start.provider || providerStatus.provider;

        if (start.authorization_url) {
          const action = await vscode.window.showInformationMessage(
            `Sign-in started for ${providerName}. Open authorization URL now?`,
            "Open",
            "Copy URL",
            "Skip",
          );
          if (action === "Open") {
            await vscode.env.openExternal(vscode.Uri.parse(start.authorization_url));
          } else if (action === "Copy URL") {
            await vscode.env.clipboard.writeText(start.authorization_url);
          }
        }

        if (start.flow_kind === "redirect_code") {
          const redirectAction = await vscode.window.showInformationMessage(
            `Complete ${providerName} sign-in automatically, or paste callback URL/code manually?`,
            "Wait for Automatic Completion",
            "Paste Callback URL or Code",
          );

          if (redirectAction === "Paste Callback URL or Code") {
            await promptAndCompleteOAuthFlow(acpClient, start.flow_id, providerName);
            return;
          }

          const completion = await waitForRedirectCompletion(acpClient, providerName);
          if (completion === "connected") {
            return;
          }

          if (completion === "cancelled") {
            const cancelledAction = await vscode.window.showInformationMessage(
              `Automatic sign-in for ${providerName} was cancelled. Paste callback URL/code instead?`,
              "Paste Callback URL or Code",
              "Cancel",
            );
            if (cancelledAction === "Paste Callback URL or Code") {
              await promptAndCompleteOAuthFlow(acpClient, start.flow_id, providerName);
            }
            return;
          }

          const timedOutAction = await vscode.window.showWarningMessage(
            `Automatic sign-in for ${providerName} timed out. Paste callback URL/code instead?`,
            "Paste Callback URL or Code",
            "Cancel",
          );
          if (timedOutAction === "Paste Callback URL or Code") {
            await promptAndCompleteOAuthFlow(acpClient, start.flow_id, providerName);
          }
        } else {
          // Device/poll flow — user must paste a code.
          await promptAndCompleteOAuthFlow(acpClient, start.flow_id, providerName);
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to start sign-in: ${formatError(err)}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("querymt.signOutProvider", async () => {
      if (!acpClient?.isConnected) {
        vscode.window.showWarningMessage(
          "QueryMT agent is not connected. Cannot sign out.",
        );
        return;
      }

      try {
        const providerStatus = await pickOAuthProvider(acpClient);
        if (!providerStatus) {
          return;
        }

        const confirmed = await vscode.window.showWarningMessage(
          `Sign out from ${providerStatus.provider}?`,
          { modal: true },
          "Sign Out",
        );
        if (confirmed !== "Sign Out") {
          return;
        }

        const payload = await acpClient.extMethod("_querymt/auth/logout", {
          provider: providerStatus.provider,
        });
        const result = parseCompleteOrLogoutResult(payload);
        if (result.success) {
          vscode.window.showInformationMessage(
            result.message || `Signed out from ${providerStatus.provider}.`,
          );
          return;
        }

        vscode.window.showErrorMessage(
          result.message || `Failed to sign out from ${providerStatus.provider}.`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to sign out: ${formatError(err)}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("querymt.authStatus", async () => {
      if (!acpClient?.isConnected) {
        vscode.window.showWarningMessage(
          "QueryMT agent is not connected. Cannot fetch auth status.",
        );
        return;
      }

      try {
        const statuses = await fetchAuthStatuses(acpClient);
        if (statuses.length === 0) {
          vscode.window.showInformationMessage("No auth-enabled providers found.");
          return;
        }

        const items = statuses.map((s) => ({
          label: `${authStatusIcon(s)} ${s.display_name || s.provider}`,
          description: authStatusDescription(s),
          detail: authStatusDetail(s),
          status: s,
        }));

        const selected = await vscode.window.showQuickPick(items, {
          title: "QueryMT: Provider Auth Status",
          placeHolder: "Select a provider for actions",
        });

        if (!selected) return;

        const s = selected.status;
        if (
          s.supports_oauth &&
          SUPPORTED_OAUTH_PROVIDERS.has(s.provider) &&
          s.oauth_status !== "connected"
        ) {
          const action = await vscode.window.showInformationMessage(
            `${s.display_name || s.provider} is not authenticated. Sign in now?`,
            "Sign In",
            "Cancel",
          );
          if (action === "Sign In") {
            await vscode.commands.executeCommand("querymt.signInProvider");
          }
        } else if (
          s.supports_oauth &&
          SUPPORTED_OAUTH_PROVIDERS.has(s.provider) &&
          s.oauth_status === "connected"
        ) {
          const action = await vscode.window.showInformationMessage(
            `${s.display_name || s.provider} is connected via OAuth.`,
            "Sign Out",
            "OK",
          );
          if (action === "Sign Out") {
            await vscode.commands.executeCommand("querymt.signOutProvider");
          }
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to fetch auth status: ${formatError(err)}`,
        );
      }
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
        {
          label: "Sign In to Provider",
          description: "OAuth login for supported providers",
        },
        {
          label: "Sign Out of Provider",
          description: "Remove OAuth credentials from agent storage",
        },
        {
          label: "Show Auth Status",
          description: "List provider authentication states",
        },
        {
          label: "Update Plugins",
          description: "Force-update all OCI provider plugins",
        },
        {
          label: "Upgrade Agent",
          description: "Check for and install qmtcode updates",
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
        case "Sign In to Provider": {
          await vscode.commands.executeCommand("querymt.signInProvider");
          break;
        }
        case "Sign Out of Provider": {
          await vscode.commands.executeCommand("querymt.signOutProvider");
          break;
        }
        case "Show Auth Status": {
          await vscode.commands.executeCommand("querymt.authStatus");
          break;
        }
        case "Update Plugins": {
          await vscode.commands.executeCommand("querymt.updatePlugins");
          break;
        }
        case "Upgrade Agent": {
          await vscode.commands.executeCommand("querymt.upgradeAgent");
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
        modelProvider?.refreshModels();
        vscode.window.showInformationMessage("QueryMT model list refreshed.");
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to refresh models: ${formatError(err)}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("querymt.updatePlugins", async () => {
      if (!acpClient?.isConnected) {
        vscode.window.showWarningMessage(
          "QueryMT agent is not connected. Cannot update plugins.",
        );
        return;
      }
      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "QueryMT: Updating plugins...",
            cancellable: false,
          },
          async () => {
            return acpClient!.extMethod("_querymt/updatePlugins", {});
          },
        );

        const obj = asObject(result);
        const results = Array.isArray(obj?.results) ? obj!.results : [];
        const succeeded = results.filter((r: unknown) => asObject(r)?.success === true).length;
        const failed = results.filter((r: unknown) => asObject(r)?.success !== true).length;

        if (failed === 0) {
          vscode.window.showInformationMessage(
            `Plugin update complete: ${succeeded} plugin(s) updated.`,
          );
        } else {
          const failedNames = results
            .map((r: unknown) => asObject(r))
            .filter((r): r is Record<string, unknown> => !!r && r.success !== true)
            .map((r) => `${r.plugin_name}: ${r.message || "unknown error"}`)
            .join("; ");
          vscode.window.showWarningMessage(
            `Plugin update: ${succeeded} succeeded, ${failed} failed. ${failedNames}`,
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to update plugins: ${formatError(err)}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("querymt.upgradeAgent", async () => {
      const config = vscode.workspace.getConfiguration("querymt");
      const channelSetting = config.get<string>("channel", "stable");
      const channel: ReleaseChannel = channelSetting === "nightly" ? "nightly" : "stable";
      const source = acpClient?.binarySource;

      // If the binary comes from PATH, bundled, or a user-configured path,
      // warn the user and offer to download a managed copy instead.
      if (source === "path" || source === "bundled" || source === "setting") {
        const sourceLabel =
          source === "path"
            ? "PATH"
            : source === "bundled"
              ? "the extension bundle"
              : "a custom setting";

        const choice = await vscode.window.showInformationMessage(
          `qmtcode is currently loaded from ${sourceLabel}. You can download a managed copy that the extension will use going forward, or update via your package manager.`,
          "Download Managed Copy",
          "Cancel",
        );
        if (choice !== "Download Managed Copy") {
          return;
        }

        // Proceed directly to download (skip version comparison — we're
        // switching from an externally-managed binary to a managed one).
        try {
          acpClient?.stop();
          statusBar.update("connecting");

          const downloadedPath = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "QueryMT: Upgrading Agent",
              cancellable: false,
            },
            async (progress) => {
              return ensureDownloadedBinary(
                context.globalStorageUri.fsPath,
                channel,
                progress,
                log,
              );
            },
          );

          log.info(`Upgrade downloaded binary to: ${downloadedPath}`);
          await acpClient?.start();
          statusBar.update("connected");
          vscode.window.showInformationMessage(
            "qmtcode managed copy downloaded and agent restarted.",
          );
        } catch (err) {
          statusBar.update("error");
          vscode.window.showErrorMessage(
            `Failed to download qmtcode: ${formatError(err)}`,
          );
        }
        return;
      }

      // For downloaded/auto-downloaded binaries, check if there's a newer version.
      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "QueryMT: Checking for updates...",
            cancellable: false,
          },
          async () => {
            return checkForUpdate(
              context.globalStorageUri.fsPath,
              channel,
              acpClient?.resolvedBinaryPath,
              log,
            );
          },
        );

        if (!result.updateAvailable) {
          vscode.window.showInformationMessage(
            `qmtcode is up to date (${result.currentVersion}).`,
          );
          return;
        }

        const confirm = await vscode.window.showInformationMessage(
          `A new version of qmtcode is available: ${result.latestVersion} (current: ${result.currentVersion}). Upgrade now?`,
          "Upgrade",
          "Cancel",
        );
        if (confirm !== "Upgrade") {
          return;
        }

        acpClient?.stop();
        statusBar.update("connecting");

        const downloadedPath = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `QueryMT: Upgrading to ${result.latestVersion}...`,
            cancellable: false,
          },
          async (progress) => {
            return ensureDownloadedBinary(
              context.globalStorageUri.fsPath,
              channel,
              progress,
              log,
            );
          },
        );

        log.info(`Upgraded qmtcode to ${result.latestVersion}: ${downloadedPath}`);
        await acpClient?.start();
        statusBar.update("connected");
        vscode.window.showInformationMessage(
          `qmtcode upgraded to ${result.latestVersion}. Agent restarted.`,
        );
      } catch (err) {
        statusBar.update("error");
        vscode.window.showErrorMessage(
          `Failed to upgrade qmtcode: ${formatError(err)}`,
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

  // ── Startup update check ──
  const checkForUpdatesEnabled = vscode.workspace
    .getConfiguration("querymt")
    .get<boolean>("checkForUpdates", true);

  if (checkForUpdatesEnabled) {
    setTimeout(async () => {
      try {
        const channelSetting = vscode.workspace
          .getConfiguration("querymt")
          .get<string>("channel", "stable");
        const channel: ReleaseChannel = channelSetting === "nightly" ? "nightly" : "stable";

        const result = await checkForUpdate(
          context.globalStorageUri.fsPath,
          channel,
          acpClient?.resolvedBinaryPath,
          log,
        );

        if (result.updateAvailable) {
          const action = await vscode.window.showInformationMessage(
            `A new version of qmtcode is available: ${result.latestVersion} (current: ${result.currentVersion}).`,
            "Upgrade Now",
            "Dismiss",
          );
          if (action === "Upgrade Now") {
            await vscode.commands.executeCommand("querymt.upgradeAgent");
          }
        }
      } catch (err) {
        log.debug(`Startup update check failed: ${formatError(err)}`);
        // Silent — don't bother the user if the check fails
      }
    }, 30_000);
  }

  log.info("QueryMT extension activated.");
}

export function deactivate(): void {
  acpClient?.dispose();
  acpClient = undefined;
}
