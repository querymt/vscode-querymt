/**
 * ACP stdio client — manages the `coder_agent --acp` subprocess and provides
 * a typed wrapper around `@agentclientprotocol/sdk`'s `ClientSideConnection`.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Writable, Readable } from "node:stream";
import * as vscode from "vscode";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
} from "@agentclientprotocol/sdk";
import { createLogger, formatError } from "./logger.js";
import type { WorkspaceQueryParams, WorkspaceQueryResponse } from "./types.js";

// ── Event types ──

export type SessionUpdateHandler = (params: SessionNotification) => void;
export type PermissionHandler = (
  params: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>;
export type ExtMethodHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface ElicitationParams {
  elicitationId: string;
  message: string;
  requestedSchema: Record<string, unknown>;
  source: string;
}

export interface ElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export type ElicitationHandler = (
  params: ElicitationParams,
) => Promise<ElicitationResponse>;

// ── AcpClient ──

export class AcpClient implements vscode.Disposable {
  private process: ChildProcess | undefined;
  private connection: ClientSideConnection | undefined;
  private disposables: vscode.Disposable[] = [];
  private readonly log = createLogger("acp");

  // Event handlers registered by other modules (chat participant, etc.)
  private sessionUpdateHandlers: SessionUpdateHandler[] = [];
  private permissionHandler: PermissionHandler | undefined;
  private elicitationHandler: ElicitationHandler | undefined;
  private extMethodHandler: ExtMethodHandler | undefined;

  private restartCount = 0;
  private disposed = false;

  // ── Lifecycle ──

  async start(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.log.info("Starting ACP agent subprocess...");
    const binaryPath = this.resolveBinaryPath();
    this.log.info(`Binary: ${binaryPath}`);

    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    const configFile = vscode.workspace
      .getConfiguration("querymt")
      .get<string>("configFile");
    const args: string[] = [];
    if (configFile) {
      args.push(configFile);
    }
    args.push("--acp");

    this.process = spawn(binaryPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });

    // Pipe stderr to the output channel for debugging
    this.process.stderr?.on("data", (data: Buffer) => {
      this.log.debug(`[agent stderr] ${data.toString().trimEnd()}`);
    });

    this.process.on("exit", (code, signal) => {
      this.log.warn(`Agent process exited (code=${code}, signal=${signal})`);
      this.connection = undefined;
      this.process = undefined;
      if (!this.disposed) {
        this.maybeRestart();
      }
    });

    this.process.on("error", (err) => {
      this.log.error(`Agent process error`, err);
    });

    // Build the ACP ndJsonStream from child process stdio
    const stdinWritable = Writable.toWeb(this.process.stdin!);
    const stdoutReadable = Readable.toWeb(
      this.process.stdout!,
    ) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(stdinWritable, stdoutReadable);

    // Create the ClientSideConnection with our Client implementation
    this.connection = new ClientSideConnection(
      (_agent: Agent) => this.createClientHandler(),
      stream,
    );

    // Monitor connection closure
    this.connection.signal.addEventListener("abort", () => {
      this.log.info("ACP connection closed");
    });

    // Initialize the ACP handshake
    const initResult = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "vscode-querymt", version: "0.1.0" },
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });

    this.log.info(
      `ACP initialized (protocol v${initResult.protocolVersion}, agent: ${initResult.agentInfo?.name ?? "unknown"})`,
    );
    this.restartCount = 0;
  }

  /**
   * Resolve the coder_agent binary path using the following priority:
   * 1. User-configured `querymt.binaryPath` setting
   * 2. Bundled binary in the extension directory (platform-specific)
   * 3. Binary on PATH
   * Throws if no binary can be found.
   */
  private resolveBinaryPath(): string {
    // 1. User setting
    const configured = vscode.workspace
      .getConfiguration("querymt")
      .get<string>("binaryPath");
    if (configured && configured.length > 0) {
      if (existsSync(configured)) {
        return configured;
      }
      this.log.warn(`Configured binary path not found: ${configured}, falling back to discovery`);
    }

    // 2. Bundled binary (platform-specific subdirectory)
    const extensionPath = vscode.extensions.getExtension("querymt.vscode-querymt")?.extensionPath;
    if (extensionPath) {
      const platformBinary = getBundledBinaryName();
      const bundledPath = join(extensionPath, "bin", platformBinary);
      if (existsSync(bundledPath)) {
        this.log.debug(`Using bundled binary: ${bundledPath}`);
        return bundledPath;
      }
    }

    // 3. Check PATH using `which` (Unix) or `where` (Windows)
    const pathBinary = findOnPath("coder_agent");
    if (pathBinary) {
      this.log.debug(`Using binary from PATH: ${pathBinary}`);
      return pathBinary;
    }

    // No binary found — will fail at spawn, but give a clear error
    throw new Error(
      "Could not find the coder_agent binary. " +
      "Install it and ensure it is on your PATH, or set querymt.binaryPath in settings.",
    );
  }

  private maybeRestart(): void {
    const maxRestarts = vscode.workspace
      .getConfiguration("querymt")
      .get<number>("maxRestarts", 5);
    if (this.restartCount >= maxRestarts) {
      this.log.error(
        `Max restart attempts (${maxRestarts}) reached. Not restarting.`,
      );
      vscode.window.showErrorMessage(
        "QueryMT agent crashed too many times. Use 'QueryMT: Restart Agent' to try again.",
      );
      return;
    }
    this.restartCount++;
    const delay = Math.min(1000 * Math.pow(2, this.restartCount - 1), 30000);
    this.log.info(`Restarting agent in ${delay}ms (attempt ${this.restartCount})...`);
    setTimeout(() => {
      if (!this.disposed) {
        this.start().catch((err) => {
          this.log.error(`Restart failed`, err);
        });
      }
    }, delay);
  }

  async restart(): Promise<void> {
    this.restartCount = 0;
    this.kill();
    await this.start();
  }

  private kill(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      // Force-kill after 5s
      const proc = this.process;
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already exited
        }
      }, 5000);
      this.process = undefined;
      this.connection = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.kill();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // ── Accessors ──

  get isConnected(): boolean {
    return this.connection !== undefined && !this.connection.signal.aborted;
  }

  /** Expose the underlying connection for direct use where needed. */
  get agent(): Agent | undefined {
    return this.connection;
  }

  // ── Outgoing requests (extension → agent) ──

  async newSession(cwd: string): Promise<string> {
    this.ensureConnected();
    const resp = await this.connection!.newSession({ cwd, mcpServers: [] });
    return resp.sessionId;
  }

  async prompt(
    sessionId: string,
    text: string,
  ): Promise<{ stopReason: string }> {
    this.ensureConnected();
    const resp = await this.connection!.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    });
    return { stopReason: resp.stopReason };
  }

  async cancel(sessionId: string): Promise<void> {
    this.ensureConnected();
    await this.connection!.cancel({ sessionId });
  }

  async listSessions(): Promise<unknown> {
    this.ensureConnected();
    return this.connection!.listSessions({});
  }

  async loadSession(sessionId: string): Promise<unknown> {
    this.ensureConnected();
    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    return this.connection!.loadSession({ sessionId, cwd, mcpServers: [] });
  }

  /**
   * Send a custom extension method to the agent (client → agent).
   */
  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.ensureConnected();
    return this.connection!.extMethod(method, params);
  }

  // ── Event registration ──

  onSessionUpdate(handler: SessionUpdateHandler): vscode.Disposable {
    this.sessionUpdateHandlers.push(handler);
    return new vscode.Disposable(() => {
      const idx = this.sessionUpdateHandlers.indexOf(handler);
      if (idx >= 0) {
        this.sessionUpdateHandlers.splice(idx, 1);
      }
    });
  }

  setPermissionHandler(handler: PermissionHandler): void {
    this.permissionHandler = handler;
  }

  setElicitationHandler(handler: ElicitationHandler): void {
    this.elicitationHandler = handler;
  }

  /**
   * Register a handler for extension methods sent by the agent (agent → client).
   * This covers `_workspace/query` and any future custom reverse-RPC methods.
   */
  setExtMethodHandler(handler: ExtMethodHandler): void {
    this.extMethodHandler = handler;
  }

  // ── Client handler (implements ACP Client interface) ──

  private createClientHandler(): Client {
    return {
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        for (const handler of this.sessionUpdateHandlers) {
          try {
            handler(params);
          } catch (err) {
            this.log.error(`sessionUpdate handler error`, err);
          }
        }
      },

      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        if (this.permissionHandler) {
          return this.permissionHandler(params);
        }
        // Default: auto-approve the first option
        const firstOption = params.options[0];
        return {
          outcome: {
            outcome: "selected",
            optionId: firstOption.optionId,
          },
        };
      },

      writeTextFile: async (
        params: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> => {
        const uri = vscode.Uri.parse(params.path);
        const content = Buffer.from(params.content, "utf-8");
        await vscode.workspace.fs.writeFile(uri, content);
        return {};
      },

      readTextFile: async (
        params: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> => {
        const uri = vscode.Uri.file(params.path);
        const content = await vscode.workspace.fs.readFile(uri);
        return { content: Buffer.from(content).toString("utf-8") };
      },

      extMethod: async (
        method: string,
        params: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        this.log.debug(`Received ext method from agent: ${method}`);

        // Route elicitation requests to the dedicated handler
        if (method === "querymt/elicit" && this.elicitationHandler) {
          const result = await this.elicitationHandler(
            params as unknown as ElicitationParams,
          );
          return result as unknown as Record<string, unknown>;
        }

        if (this.extMethodHandler) {
          return this.extMethodHandler(method, params);
        }
        throw new Error(`Unhandled extension method: ${method}`);
      },

      extNotification: async (
        method: string,
        params: Record<string, unknown>,
      ): Promise<void> => {
        this.log.debug(`Received ext notification from agent: ${method}`);
        // Currently no ext notifications are handled; log and ignore
      },
    };
  }

  // ── Helpers ──

  private ensureConnected(): void {
    if (!this.isConnected) {
      throw new Error("ACP agent is not connected");
    }
  }

}

// ── Module-level helpers ──

/**
 * Get the expected bundled binary name for the current platform.
 */
function getBundledBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  const ext = platform === "win32" ? ".exe" : "";
  let os: string;
  switch (platform) {
    case "darwin":
      os = "darwin";
      break;
    case "linux":
      os = "linux";
      break;
    case "win32":
      os = "windows";
      break;
    default:
      os = platform;
  }

  let cpu: string;
  switch (arch) {
    case "x64":
      cpu = "amd64";
      break;
    case "arm64":
      cpu = "arm64";
      break;
    default:
      cpu = arch;
  }

  return `coder_agent-${os}-${cpu}${ext}`;
}

/**
 * Find a binary on PATH. Returns the absolute path or undefined.
 */
function findOnPath(name: string): string | undefined {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = execFileSync(cmd, [name], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const path = result.trim().split("\n")[0]?.trim();
    return path && path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
}
