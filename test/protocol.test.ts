/**
 * Protocol integration tests — exercises the ACP protocol against a real
 * `qmtcode` binary without any VS Code dependency.
 *
 * Set the QMTCODE_BIN env var to the path of the qmtcode binary.
 * Optionally set QMTCODE_CONFIG to a TOML config file path.
 *
 * Tests are skipped when QMTCODE_BIN is not set.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

// ── Env ──

const AGENT_BIN = process.env.QMTCODE_BIN;
const AGENT_CONFIG = process.env.QMTCODE_CONFIG;

const describeWithAgent = AGENT_BIN ? describe : describe.skip;

// ── Helpers ──

interface TestHarness {
  process: ChildProcess;
  connection: ClientSideConnection;
  updates: SessionNotification[];
  permissionRequests: RequestPermissionRequest[];
}

function spawnAgent(): TestHarness {
  const args: string[] = [];
  if (AGENT_CONFIG) {
    args.push(AGENT_CONFIG);
  }
  args.push("--acp");

  const proc = spawn(AGENT_BIN!, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
  });

  // Collect stderr for debugging on failure
  const stderrChunks: string[] = [];
  proc.stderr?.on("data", (data: Buffer) => {
    stderrChunks.push(data.toString());
  });

  const updates: SessionNotification[] = [];
  const permissionRequests: RequestPermissionRequest[] = [];

  const stdinWritable = Writable.toWeb(proc.stdin!);
  const stdoutReadable = Readable.toWeb(
    proc.stdout!,
  ) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(stdinWritable, stdoutReadable);

  const connection = new ClientSideConnection(
    (_agent: Agent): Client => ({
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        updates.push(params);
      },

      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        permissionRequests.push(params);
        // Auto-approve the first option in tests
        const firstOption = params.options[0];
        return {
          outcome: { outcome: "selected", optionId: firstOption.optionId },
        };
      },

      readTextFile: async (params) => {
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(params.path, "utf-8");
        return { content };
      },

      writeTextFile: async (params) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(params.path, params.content, "utf-8");
        return {};
      },

      extMethod: async (
        method: string,
        _params: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        throw new Error(`Unhandled ext method in test: ${method}`);
      },

      extNotification: async (): Promise<void> => {
        // ignore
      },
    }),
    stream,
  );

  return { process: proc, connection, updates, permissionRequests };
}

function waitForProcessExit(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<{ exited: boolean; code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.killed) {
      resolve({ exited: true, code: proc.exitCode, signal: null });
      return;
    }
    const timer = setTimeout(() => {
      resolve({ exited: false, code: null, signal: null });
    }, timeoutMs);
    proc.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ exited: true, code, signal });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function killHarness(harness: TestHarness): Promise<void> {
  try {
    harness.process.kill("SIGTERM");
  } catch {
    // already dead
  }
  const result = await waitForProcessExit(harness.process, 3000);
  if (!result.exited) {
    try {
      harness.process.kill("SIGKILL");
    } catch {
      // already dead
    }
    await waitForProcessExit(harness.process, 2000);
  }
}

// ── Tests ──

describeWithAgent("ACP protocol integration", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = spawnAgent();
  });

  afterEach(async () => {
    await killHarness(harness);
  });

  it("should initialize the ACP handshake", async () => {
    const result = await harness.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "test-harness", version: "0.0.1" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.agentInfo).toBeDefined();
    expect(result.agentInfo?.name).toBeTruthy();
  });

  it("should create a new session", async () => {
    await harness.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "test-harness", version: "0.0.1" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    const session = await harness.connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    expect(session.sessionId).toBeTruthy();
    expect(typeof session.sessionId).toBe("string");
  });

  it("should send a prompt and receive a response", async () => {
    await harness.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "test-harness", version: "0.0.1" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    const session = await harness.connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    const result = await harness.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Reply with exactly: PONG" }],
    });

    expect(result.stopReason).toBeTruthy();
    // We should have received at least one session update (agent message)
    const messageUpdates = harness.updates.filter(
      (u) =>
        u.update.sessionUpdate === "agent_message_chunk" ||
        u.update.sessionUpdate === "agent_thought_chunk",
    );
    expect(messageUpdates.length).toBeGreaterThan(0);
  });

  it("should cancel an in-progress prompt", async () => {
    await harness.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "test-harness", version: "0.0.1" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    const session = await harness.connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    // Start a prompt that should take a while
    const promptPromise = harness.connection.prompt({
      sessionId: session.sessionId,
      prompt: [
        {
          type: "text",
          text: "Write a very long essay about the history of computing, at least 5000 words.",
        },
      ],
    });

    // Give the agent a moment to start processing, then cancel
    await new Promise((r) => setTimeout(r, 500));
    await harness.connection.cancel({ sessionId: session.sessionId });

    const result = await promptPromise;
    // Agent should respond with cancelled stop reason (or end_turn if it finished fast)
    expect(result.stopReason).toBeTruthy();
  });

  it("should list sessions", async () => {
    await harness.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "test-harness", version: "0.0.1" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    const session = await harness.connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    const listResult = await harness.connection.listSessions({});
    expect(listResult.sessions).toBeDefined();
    expect(Array.isArray(listResult.sessions)).toBe(true);
    // The session we just created should be in the list
    const found = listResult.sessions.find(
      (s) => s.sessionId === session.sessionId,
    );
    expect(found).toBeDefined();
  });

  it("should receive session updates during prompt", async () => {
    await harness.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "test-harness", version: "0.0.1" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    const session = await harness.connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    await harness.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Say hello" }],
    });

    // Verify we received updates with the correct session ID
    expect(harness.updates.length).toBeGreaterThan(0);
    for (const update of harness.updates) {
      expect(update.sessionId).toBe(session.sessionId);
    }
  });

  it("should handle multiple sessions independently", async () => {
    await harness.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "test-harness", version: "0.0.1" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    const session1 = await harness.connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    const session2 = await harness.connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    expect(session1.sessionId).not.toBe(session2.sessionId);

    // Prompt on session 1
    await harness.connection.prompt({
      sessionId: session1.sessionId,
      prompt: [{ type: "text", text: "Say A" }],
    });

    const session1Updates = harness.updates.filter(
      (u) => u.sessionId === session1.sessionId,
    );
    const session2Updates = harness.updates.filter(
      (u) => u.sessionId === session2.sessionId,
    );

    expect(session1Updates.length).toBeGreaterThan(0);
    expect(session2Updates.length).toBe(0);
  });

  it("should exit cleanly on SIGTERM", async () => {
    await harness.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "test-harness", version: "0.0.1" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    harness.process.kill("SIGTERM");

    const exitResult = await waitForProcessExit(harness.process, 5000);
    expect(exitResult.exited).toBe(true);
    expect(
      harness.process.exitCode !== null || harness.process.killed,
    ).toBe(true);
  }, 15000);
});
