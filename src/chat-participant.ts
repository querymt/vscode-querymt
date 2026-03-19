/**
 * Chat Participant — registers `@querymt` in VS Code's chat panel and maps
 * ACP session updates to VS Code's `ChatResponseStream`.
 */

import * as vscode from "vscode";
import type { AcpClient, ElicitationParams, ElicitationResponse } from "./acp-client.js";
import type { StatusBar } from "./status-bar.js";
import { createLogger } from "./logger.js";
import type {
  ContentBlock,
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
  statusBar?: StatusBar,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Map VS Code chat thread → ACP session ID
  const threadSessions = new Map<string, string>();

  // Active response streams keyed by session ID (for streaming updates)
  const activeStreams = new Map<
    string,
    { stream: vscode.ChatResponseStream; token: vscode.CancellationToken }
  >();

  // Available commands per session (for followup suggestions)
  const sessionCommands = new Map<
    string,
    Array<{ name: string; description: string }>
  >();

  // Last model set per session (to avoid redundant setModel calls)
  const sessionModels = new Map<string, string>();

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
        const msg = err instanceof Error ? err.message : String(err);
        response.markdown(
          `**Failed to start QueryMT agent:** ${msg}\n\nThe \`qmtcode\` binary could not be found or downloaded automatically. Install it with \`curl -sSf https://query.mt/install.sh | sh\`, or set \`querymt.binaryPath\` in settings.`,
        );
        return { errorDetails: { message: msg } };
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

        // Apply model on new session
        const resolvedModel = resolveModel(request);
        if (resolvedModel) {
          try {
            await acpClient.setModel(sessionId, resolvedModel);
            sessionModels.set(sessionId, resolvedModel);
            log.info(`Model set to: ${resolvedModel}`);
          } catch (err) {
            log.warn(
              `Failed to set model "${resolvedModel}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        log.error("Failed to create session", err);
        const msg = err instanceof Error ? err.message : String(err);
        response.markdown(`**Failed to create session:** ${msg}`);
        return { errorDetails: { message: msg } };
      }
    } else {
      log.debug(`Reusing session: ${sessionId}`);

      // Check if model changed since last request on this session
      const resolvedModel = resolveModel(request);
      const currentModel = sessionModels.get(sessionId);
      if (resolvedModel && resolvedModel !== currentModel) {
        try {
          await acpClient.setModel(sessionId, resolvedModel);
          sessionModels.set(sessionId, resolvedModel);
          log.info(`Model updated to: ${resolvedModel}`);
        } catch (err) {
          log.warn(
            `Failed to update model "${resolvedModel}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
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
      // Build content blocks from the user's text + any attached references
      const promptBlocks = await buildPromptBlocks(request);
      log.debug(
        `Prompt blocks: ${promptBlocks.length} (${promptBlocks.map((b) => b.type).join(", ")})`,
      );

      const done = log.time("prompt");
      // Race the prompt against cancellation so the handler actually
      // unblocks when the user clicks "Cancel".
      const result = await Promise.race([
        acpClient.prompt(sessionId, promptBlocks),
        cancelledPromise,
      ]);
      done();

      log.info(`Prompt completed: stopReason=${result.stopReason}`);
      return { metadata: { sessionId, stopReason: result.stopReason } };
    } catch (err) {
      if (token.isCancellationRequested) {
        log.info("Prompt cancelled by user");
        response.markdown("*Cancelled.*");
        return { errorDetails: { message: "Cancelled" } };
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Prompt failed", err);
        response.markdown(`**Error:** ${msg}`);
        return { errorDetails: { message: msg } };
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

      // Capture available commands for followup suggestions
      if (params.update.sessionUpdate === "available_commands_update") {
        const cmds = (params.update as any).availableCommands as
          | Array<{ name: string; description: string }>
          | undefined;
        if (cmds) {
          sessionCommands.set(params.sessionId, cmds);
        }
      }

      // Forward usage updates to the status bar
      if (params.update.sessionUpdate === "usage_update" && statusBar) {
        const u = params.update as any;
        statusBar.updateUsage({
          size: u.size ?? 0,
          used: u.used ?? 0,
          cost: u.cost ?? undefined,
        });
      }

      renderSessionUpdate(stream, params.update);
    },
  );
  disposables.push(updateSub);

  // ── Followup provider ──

  participant.followupProvider = {
    provideFollowups(
      result: vscode.ChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken,
    ): vscode.ChatFollowup[] {
      const sessionId = (result.metadata as any)?.sessionId as
        | string
        | undefined;
      if (!sessionId) return [];
      const commands = sessionCommands.get(sessionId);
      if (!commands || commands.length === 0) return [];
      return commands.map((cmd) => ({
        prompt: cmd.name,
        label: cmd.description,
      }));
    },
  };

  // ── Feedback handler ──

  const feedbackSub = participant.onDidReceiveFeedback((feedback) => {
    const sessionId = (feedback.result.metadata as any)?.sessionId as
      | string
      | undefined;
    if (!sessionId) return;
    const kind = feedback.kind === 1 ? "helpful" : "unhelpful";
    acpClient.extNotification("_querymt/feedback", { sessionId, kind }).catch((err) => {
      log.warn(`Failed to send feedback: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  disposables.push(feedbackSub);

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
      // Render clickable file:line anchors for affected locations
      renderLocationAnchors(stream, update.locations);
      break;
    }

    case "tool_call_update": {
      const status = update.status;
      // Render clickable file:line anchors for affected locations
      renderLocationAnchors(stream, update.locations);
      if (status === "completed" || status === "failed") {
        // Render tool call content if available
        if (update.content && update.content.length > 0) {
          for (const item of update.content) {
            if (item.type === "content" && item.content.type === "text") {
              const dirListing =
                tryParseReadToolDirectory(item.content.text) ??
                tryParseLsDirectory(item.content.text);
              if (dirListing) {
                stream.filetree(
                  dirListing.entries,
                  vscode.Uri.file(dirListing.basePath),
                );
              } else {
                stream.markdown(
                  `\n\`\`\`\n${item.content.text}\n\`\`\`\n`,
                );
              }
            } else if (item.type === "diff") {
              // Add file reference to the sidebar
              stream.reference(vscode.Uri.file(item.path));
              stream.markdown(
                `\n\`\`\`diff\n${item.oldText ?? ""}→\n${item.newText ?? ""}\n\`\`\`\n`,
              );
            } else if (item.type === "terminal") {
              stream.markdown(
                `\n*Terminal: \`${(item as any).terminalId}\`*\n`,
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
 * Resolve which model to use for a request.
 *
 * Precedence: request.model (querymt vendor) > settings > agent default (undefined).
 * Returns `"provider/model"` format — the canonical ModelEntry.id from the agent.
 */
function resolveModel(request: vscode.ChatRequest): string | undefined {
  if (request.model?.vendor === "querymt") {
    // model.id is already "provider/model" (the canonical ModelEntry.id)
    return request.model.id;
  }

  const config = vscode.workspace.getConfiguration("querymt");
  const defaultModel = config.get<string>("defaultModel");
  if (!defaultModel) return undefined;

  if (defaultModel.includes("/")) {
    // Already in provider/model format — use as-is
    return defaultModel;
  }

  const defaultProvider = config.get<string>("defaultProvider");
  return defaultProvider ? `${defaultProvider}/${defaultModel}` : defaultModel;
}

/**
 * Render clickable file:line anchors for tool call locations.
 */
function renderLocationAnchors(
  stream: vscode.ChatResponseStream,
  locations?: Array<{ path: string; line?: number | null }> | null,
): void {
  if (!locations || locations.length === 0) return;
  for (const loc of locations) {
    const uri = vscode.Uri.file(loc.path);
    if (loc.line != null) {
      const pos = new vscode.Position(loc.line, 0);
      stream.anchor(new vscode.Location(uri, new vscode.Range(pos, pos)));
    } else {
      stream.anchor(uri);
    }
  }
}

// ── Directory listing parsers ──

interface DirectoryListing {
  basePath: string;
  entries: Array<{ name: string; children?: Array<{ name: string; children?: any[] }> }>;
}

/**
 * Try to parse read_tool directory output (XML-like format).
 *
 * Matches output like:
 * ```
 * <path>/workspace/src</path>
 * <type>directory</type>
 * <entries>
 * main.ts
 * utils/
 * (2 entries)
 * </entries>
 * ```
 */
export function tryParseReadToolDirectory(text: string): DirectoryListing | null {
  const typeMatch = text.match(/<type>(.*?)<\/type>/);
  if (typeMatch?.[1] !== "directory") return null;

  const pathMatch = text.match(/<path>(.*?)<\/path>/);
  const entriesMatch = text.match(/<entries>([\s\S]*?)<\/entries>/);
  if (!pathMatch || !entriesMatch) return null;

  const basePath = pathMatch[1];
  const entryLines = entriesMatch[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\(\d+ entries.*\)$/.test(l));

  const entries = entryLines.map((line) => {
    const isDir = line.endsWith("/");
    const name = isDir ? line.slice(0, -1) : line;
    return isDir ? { name, children: [] } : { name };
  });

  return { basePath, entries };
}

/**
 * Try to parse depth-prefix ls output.
 *
 * Matches output like:
 * ```
 * /workspace/src/
 * 0 components/
 * 1 Button.tsx
 * 0 main.ts
 * (3 entries)
 * ```
 *
 * Each entry line is `N name` where N is the 0-based depth.
 * Directories have a trailing `/`.
 */
export function tryParseLsDirectory(text: string): DirectoryListing | null {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length < 1) return null;

  // First line must be an absolute path ending with /
  const firstLine = lines[0];
  if (!firstLine.startsWith("/") || !firstLine.endsWith("/")) return null;

  const basePath = firstLine.replace(/\/+$/, "");

  // Remaining lines should be depth-prefixed entries or the footer
  const entryLines = lines
    .slice(1)
    .filter((l) => !/^\(\d+ entries.*\)$/.test(l));

  // Validate that at least some lines match the depth-prefix pattern
  // (or list is empty, which is valid)
  const depthPattern = /^(\d+) (.+)$/;
  if (entryLines.length > 0 && !entryLines.some((l) => depthPattern.test(l))) {
    return null;
  }

  type TreeNode = { name: string; children?: TreeNode[] };
  const roots: TreeNode[] = [];
  const stack: Array<{ depth: number; node: TreeNode }> = [];

  for (const line of entryLines) {
    const match = line.match(depthPattern);
    if (!match) continue;

    const depth = parseInt(match[1], 10);
    const raw = match[2];
    const isDir = raw.endsWith("/");
    const name = isDir ? raw.slice(0, -1) : raw;
    const node: TreeNode = isDir ? { name, children: [] } : { name };

    // Pop stack back to parent level
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      const parent = stack[stack.length - 1].node;
      if (!parent.children) {
        parent.children = []; // promote to directory if needed
      }
      parent.children.push(node);
    }

    stack.push({ depth, node });
  }

  return { basePath, entries: roots };
}

/** Size limit for embedding file content inline (1 MB). */
export const MAX_EMBED_BYTES = 1024 * 1024;

/**
 * Build an array of ACP ContentBlock objects from a VS Code ChatRequest.
 *
 * The user's text prompt becomes a `text` block. Any attached references
 * (files, selections, etc.) are read and included as `resource` blocks so
 * the agent receives the content directly without needing extra round-trips.
 */
export async function buildPromptBlocks(
  request: vscode.ChatRequest,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [{ type: "text", text: request.prompt }];

  for (const ref of request.references) {
    try {
      // Include modelDescription as context text before the reference content
      if (ref.modelDescription) {
        blocks.push({ type: "text", text: ref.modelDescription });
      }

      if (ref.value instanceof vscode.Uri) {
        const stat = await vscode.workspace.fs.stat(ref.value);
        if (stat.size > MAX_EMBED_BYTES) {
          // Too large to embed — send as a resource link instead
          blocks.push({
            type: "resource_link",
            uri: ref.value.toString(),
            name: ref.value.path.split("/").pop() ?? ref.value.toString(),
          });
          continue;
        }
        const raw = await vscode.workspace.fs.readFile(ref.value);
        blocks.push({
          type: "resource",
          resource: {
            uri: ref.value.toString(),
            text: Buffer.from(raw).toString("utf-8"),
          },
        });
      } else if (ref.value instanceof vscode.Location) {
        const doc = await vscode.workspace.openTextDocument(ref.value.uri);
        const text = doc.getText(ref.value.range);
        blocks.push({
          type: "resource",
          resource: {
            uri: ref.value.uri.toString(),
            text,
          },
        });
      } else if (typeof ref.value === "string") {
        // Plain string reference — include as text context
        blocks.push({ type: "text", text: ref.value });
      }
    } catch (err) {
      log.warn(
        `Failed to read reference ${ref.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Fall back to a resource link so the agent can try to read it itself
      if (ref.value instanceof vscode.Uri) {
        blocks.push({
          type: "resource_link",
          uri: ref.value.toString(),
          name: ref.value.path.split("/").pop() ?? ref.value.toString(),
        });
      }
    }
  }

  // Include tool reference names as informational context
  if (request.toolReferences && request.toolReferences.length > 0) {
    const names = request.toolReferences.map((t) => `#${t.name}`).join(", ");
    blocks.push({
      type: "text",
      text: `The user referenced the following VS Code tools: ${names}. These are VS Code-specific tools that may provide additional context.`,
    });
  }

  return blocks;
}

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


