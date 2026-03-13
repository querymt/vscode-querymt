/**
 * Chat Participant — registers `@querymt` in VS Code's chat panel and maps
 * ACP session updates to VS Code's `ChatResponseStream`.
 */

import * as vscode from "vscode";
import type { AcpClient, ElicitationParams, ElicitationResponse } from "./acp-client.js";
import { createLogger } from "./logger.js";
import type {
  SessionNotification,
  SessionUpdate,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

const log = createLogger("chat");

/**
 * Register the `@querymt` chat participant and wire it to the ACP client.
 * Returns disposables that should be pushed to the extension context.
 */
export function registerChatParticipant(
  acpClient: AcpClient,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Map VS Code chat thread → ACP session ID
  const threadSessions = new Map<string, string>();

  // Active response streams keyed by session ID (for streaming updates)
  const activeStreams = new Map<
    string,
    { stream: vscode.ChatResponseStream; token: vscode.CancellationToken }
  >();

  // ── Chat request handler ──

  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult | void> => {
    const promptSnippet = request.prompt.slice(0, 80);
    log.info(`Handler entered: "${promptSnippet}"`);

    // Ensure the ACP agent is running
    if (!acpClient.isConnected) {
      log.info("Agent not connected, starting...");
      try {
        const done = log.time("acpClient.start");
        await acpClient.start();
        done();
      } catch (err) {
        log.error("Failed to start agent", err);
        response.markdown(
          `**Failed to start QueryMT agent:** ${err instanceof Error ? err.message : String(err)}\n\nPlease check that the \`coder_agent\` binary is installed and available on your PATH, or set \`querymt.binaryPath\` in settings.`,
        );
        return;
      }
    }

    // Determine the workspace cwd
    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    // Use a stable thread identifier. VS Code ChatContext doesn't expose a
    // thread ID directly, but the context.history array identity is stable
    // per conversation thread. We use the first history entry's participant
    // + timestamp as a rough key, or fall back to creating a new session
    // every time if there's no history.
    const threadKey = getThreadKey(context);
    log.debug(`Thread key: ${threadKey}`);

    let sessionId = threadSessions.get(threadKey);
    if (!sessionId) {
      try {
        const done = log.time("newSession");
        sessionId = await acpClient.newSession(cwd);
        done();
        log.info(`Session created: ${sessionId}`);
        threadSessions.set(threadKey, sessionId);
      } catch (err) {
        log.error("Failed to create session", err);
        response.markdown(
          `**Failed to create session:** ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    } else {
      log.debug(`Reusing session: ${sessionId}`);
    }

    // Register this stream as active so sessionUpdate events can stream to it
    activeStreams.set(sessionId, { stream: response, token });

    // Create a promise that rejects when the cancellation token fires,
    // so we can race it against the prompt call and actually unblock.
    const cancelledPromise = new Promise<never>((_, reject) => {
      token.onCancellationRequested(() => {
        log.info(`Cancellation requested for session ${sessionId}`);
        acpClient.cancel(sessionId!).catch(() => {
          // ignore cancel errors
        });
        reject(new Error("Cancelled"));
      });
    });

    try {
      const done = log.time("prompt");
      // Race the prompt against cancellation so the handler actually
      // unblocks when the user clicks "Cancel".
      const result = await Promise.race([
        acpClient.prompt(sessionId, request.prompt),
        cancelledPromise,
      ]);
      done();

      log.info(`Prompt completed: stopReason=${result.stopReason}`);
    } catch (err) {
      if (token.isCancellationRequested) {
        log.info("Prompt cancelled by user");
        response.markdown("*Cancelled.*");
      } else {
        log.error("Prompt failed", err);
        response.markdown(
          `**Error:** ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      activeStreams.delete(sessionId);
    }
  };

  // ── Register the participant ──

  const participant = vscode.chat.createChatParticipant(
    "querymt.agent",
    handler,
  );
  participant.iconPath = new vscode.ThemeIcon("hubot");
  disposables.push(participant);

  // ── Session update subscription ──

  const updateSub = acpClient.onSessionUpdate(
    (params: SessionNotification) => {
      log.trace(
        `sessionUpdate: session=${params.sessionId} type=${params.update.sessionUpdate}`,
      );
      const entry = activeStreams.get(params.sessionId);
      if (!entry) {
        log.debug(
          `sessionUpdate for unknown/inactive session ${params.sessionId} (type=${params.update.sessionUpdate})`,
        );
        return;
      }
      const { stream, token } = entry;
      if (token.isCancellationRequested) return;

      renderSessionUpdate(stream, params.update);
    },
  );
  disposables.push(updateSub);

  // ── Permission handler ──

  acpClient.setPermissionHandler(
    async (
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => {
      return handlePermissionRequest(params);
    },
  );

  // ── Elicitation handler ──

  acpClient.setElicitationHandler(
    async (params: ElicitationParams): Promise<ElicitationResponse> => {
      return handleElicitation(params);
    },
  );

  return disposables;
}

// ── Permission UI ──

/**
 * Handle a permission request from the agent with a rich QuickPick UI
 * that shows tool details, diff previews, and categorized options.
 */
async function handlePermissionRequest(
  params: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  const toolCall = params.toolCall;
  const title = toolCall.title ?? "Unknown action";

  // Build a description from tool call content (show diffs, file paths)
  let detail = "";
  if (toolCall.content && toolCall.content.length > 0) {
    for (const item of toolCall.content) {
      if (item.type === "diff") {
        detail += `File: ${item.path}\n`;
        // Show a compact summary of the diff
        const oldLines = (item.oldText ?? "").split("\n").length;
        const newLines = item.newText.split("\n").length;
        detail += `  ${oldLines} lines -> ${newLines} lines\n`;
      } else if (item.type === "terminal") {
        detail += `Terminal: ${item.terminalId}\n`;
      }
    }
  }

  // Show file locations if present
  if (toolCall.locations && toolCall.locations.length > 0) {
    for (const loc of toolCall.locations) {
      detail += `Location: ${loc.path}`;
      if (loc.line != null) {
        detail += `:${loc.line}`;
      }
      detail += "\n";
    }
  }

  // Build QuickPick items from permission options, grouped by kind
  const items: Array<vscode.QuickPickItem & { optionId: string }> = params.options.map((o) => {
    let iconPrefix: string;
    let description: string;
    switch (o.kind) {
      case "allow_once":
        iconPrefix = "$(check)";
        description = "Allow this action";
        break;
      case "allow_always":
        iconPrefix = "$(check-all)";
        description = "Allow this and future similar actions";
        break;
      case "reject_once":
        iconPrefix = "$(close)";
        description = "Deny this action";
        break;
      case "reject_always":
        iconPrefix = "$(circle-slash)";
        description = "Deny this and future similar actions";
        break;
      default:
        iconPrefix = "$(question)";
        description = "";
    }

    return {
      label: `${iconPrefix} ${o.name}`,
      description,
      optionId: o.optionId,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `QueryMT: ${title}`,
    placeHolder: detail.trim() || "Choose how to proceed",
    ignoreFocusOut: true,
  });

  if (!picked) {
    // User dismissed — find a reject option or use the last option
    const rejectOption =
      params.options.find((o) => o.kind === "reject_once") ??
      params.options.find((o) => o.kind === "reject_always") ??
      params.options[params.options.length - 1];
    return {
      outcome: { outcome: "selected", optionId: rejectOption.optionId },
    };
  }

  return {
    outcome: { outcome: "selected", optionId: picked.optionId },
  };
}

// ── Elicitation UI ──

/**
 * Handle an elicitation request from the agent. The agent sends a message
 * (question) and optionally a JSON schema describing the expected response.
 * We use VS Code QuickPick/InputBox to collect user input.
 */
async function handleElicitation(
  params: ElicitationParams,
): Promise<ElicitationResponse> {
  const schema = params.requestedSchema;

  // If the schema defines an enum or oneOf, present as QuickPick
  const properties = (schema?.properties ?? {}) as Record<string, SchemaProperty>;
  const propertyKeys = Object.keys(properties);

  // Simple case: single enum/oneOf property → QuickPick
  if (propertyKeys.length === 1) {
    const key = propertyKeys[0];
    const prop = properties[key];

    if (prop.enum && Array.isArray(prop.enum)) {
      const items: vscode.QuickPickItem[] = prop.enum.map((v: string) => ({
        label: String(v),
      }));

      const selected = await vscode.window.showQuickPick(items, {
        title: params.message,
        placeHolder: prop.description ?? "Select an option",
      });

      if (!selected) {
        return { action: "decline" };
      }

      return {
        action: "accept",
        content: { [key]: selected.label },
      };
    }

    // Single boolean property → Yes/No
    if (prop.type === "boolean") {
      const choice = await vscode.window.showQuickPick(
        [{ label: "Yes" }, { label: "No" }],
        { title: params.message, placeHolder: prop.description ?? "Yes or No?" },
      );

      if (!choice) {
        return { action: "decline" };
      }

      return {
        action: "accept",
        content: { [key]: choice.label === "Yes" },
      };
    }

    // Single string property → InputBox
    if (prop.type === "string") {
      const value = await vscode.window.showInputBox({
        title: params.message,
        prompt: prop.description ?? "Enter a value",
        value: prop.default as string | undefined,
      });

      if (value === undefined) {
        return { action: "decline" };
      }

      return {
        action: "accept",
        content: { [key]: value },
      };
    }
  }

  // Multi-property case: collect each field sequentially
  if (propertyKeys.length > 1) {
    const result: Record<string, unknown> = {};

    for (const key of propertyKeys) {
      const prop = properties[key];

      if (prop.enum && Array.isArray(prop.enum)) {
        const items: vscode.QuickPickItem[] = prop.enum.map((v: string) => ({
          label: String(v),
        }));
        const selected = await vscode.window.showQuickPick(items, {
          title: `${params.message} — ${prop.description ?? key}`,
        });
        if (!selected) {
          return { action: "decline" };
        }
        result[key] = selected.label;
      } else if (prop.type === "boolean") {
        const choice = await vscode.window.showQuickPick(
          [{ label: "Yes" }, { label: "No" }],
          { title: `${params.message} — ${prop.description ?? key}` },
        );
        if (!choice) {
          return { action: "decline" };
        }
        result[key] = choice.label === "Yes";
      } else {
        const value = await vscode.window.showInputBox({
          title: `${params.message} — ${prop.description ?? key}`,
          prompt: prop.description,
        });
        if (value === undefined) {
          return { action: "decline" };
        }
        result[key] = value;
      }
    }

    return { action: "accept", content: result };
  }

  // Fallback: simple text input
  const value = await vscode.window.showInputBox({
    title: "QueryMT Agent",
    prompt: params.message,
  });

  if (value === undefined) {
    return { action: "decline" };
  }

  return { action: "accept", content: { response: value } };
}

interface SchemaProperty {
  type?: string;
  enum?: string[];
  description?: string;
  default?: unknown;
}

// ── Session update rendering ──

function renderSessionUpdate(
  stream: vscode.ChatResponseStream,
  update: SessionUpdate,
): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = update.content;
      if (content.type === "text") {
        stream.markdown(content.text);
      }
      break;
    }

    case "agent_thought_chunk": {
      // Thoughts could be rendered differently; for now show as italic
      const content = update.content;
      if (content.type === "text" && content.text.trim().length > 0) {
        stream.markdown(`*${content.text}*`);
      }
      break;
    }

    case "tool_call": {
      const status = update.status ?? "running";
      if (status === "running") {
        stream.progress(`Running: ${update.title}`);
      } else {
        stream.markdown(`\n**Tool:** ${update.title} — ${status}\n`);
      }
      break;
    }

    case "tool_call_update": {
      const status = update.status;
      if (status === "completed" || status === "failed") {
        // Render tool call content if available
        if (update.content && update.content.length > 0) {
          for (const item of update.content) {
            if (item.type === "content" && item.content.type === "text") {
              stream.markdown(
                `\n\`\`\`\n${item.content.text}\n\`\`\`\n`,
              );
            } else if (item.type === "diff") {
              stream.markdown(
                `\n\`\`\`diff\n${item.oldText ?? ""}→\n${item.newText ?? ""}\n\`\`\`\n`,
              );
            }
          }
        }
      }
      break;
    }

    case "plan": {
      // Render plan entries as a checklist
      if (update.entries) {
        const lines = update.entries.map(
          (entry) => {
            const check = entry.status === "completed" ? "x" : " ";
            return `- [${check}] ${entry.content}`;
          },
        );
        stream.markdown(`\n${lines.join("\n")}\n`);
      }
      break;
    }

    case "user_message_chunk":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
      // These are informational; no rendering needed in chat
      break;

    default:
      // Unknown update type — ignore gracefully
      break;
  }
}

// ── Helpers ──

/**
 * Derive a stable key for the chat thread from the context.
 * VS Code doesn't expose a thread ID, so we use a hash of the history length
 * and the first history entry's text.
 */
function getThreadKey(context: vscode.ChatContext): string {
  if (context.history.length === 0) {
    return `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  // Use a combination of the first entry's content as an identifier
  const first = context.history[0];
  if (first instanceof vscode.ChatRequestTurn) {
    return `thread-${first.prompt.slice(0, 50)}-${context.history.length}`;
  }
  return `thread-history-${context.history.length}`;
}


