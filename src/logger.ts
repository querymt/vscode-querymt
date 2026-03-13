/**
 * Logging infrastructure for the QueryMT extension.
 *
 * Wraps VS Code's built-in LogOutputChannel. Provides scoped loggers
 * and an elapsed-time helper. Log level filtering is handled by VS Code.
 */

import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

/**
 * Initialise the global log channel.
 * Call once during extension activation.
 */
export function initLogger(): vscode.LogOutputChannel {
  channel = vscode.window.createOutputChannel("QueryMT", { log: true });
  return channel;
}

/**
 * Get the shared log channel (must call initLogger first).
 */
export function getChannel(): vscode.LogOutputChannel {
  if (!channel) {
    throw new Error("Logger not initialised — call initLogger() first");
  }
  return channel;
}

/**
 * Create a scoped logger. Every message is prefixed with `[scope]`.
 */
export function createLogger(scope: string): Logger {
  return new Logger(scope);
}

export class Logger {
  constructor(private readonly scope: string) {}

  trace(msg: string): void {
    channel?.trace(`[${this.scope}] ${msg}`);
  }

  debug(msg: string): void {
    channel?.debug(`[${this.scope}] ${msg}`);
  }

  info(msg: string): void {
    channel?.info(`[${this.scope}] ${msg}`);
  }

  warn(msg: string): void {
    channel?.warn(`[${this.scope}] ${msg}`);
  }

  error(msg: string, err?: unknown): void {
    if (err !== undefined) {
      channel?.error(`[${this.scope}] ${msg}: ${formatError(err)}`);
    } else {
      channel?.error(`[${this.scope}] ${msg}`);
    }
  }

  /**
   * Returns a function that, when called, logs the elapsed time since
   * creation. Useful for timing async operations.
   *
   * @example
   * const done = log.time("newSession");
   * await client.newSession(cwd);
   * done(); // logs "[chat] newSession completed in 142ms"
   */
  time(label: string): () => void {
    const start = performance.now();
    this.debug(`${label}...`);
    return () => {
      const elapsed = Math.round(performance.now() - start);
      this.debug(`${label} completed in ${elapsed}ms`);
    };
  }
}

/**
 * Format an unknown error value into a readable string.
 * Handles Error instances, plain objects, and primitives.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  if (typeof err === "object" && err !== null) {
    try {
      return JSON.stringify(err, null, 2);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
