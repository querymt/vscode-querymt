/**
 * TDD tests for chat response improvements:
 * - Returning proper ChatResult from handler
 * - stream.anchor() for tool call locations
 * - stream.reference() for file modifications
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──

const {
  MockUri,
  MockLocation,
  MockPosition,
  MockRange,
  mockGetConfiguration,
  mockCreateChatParticipant,
} = vi.hoisted(() => {
  class MockPosition {
    constructor(public line: number, public character: number) {}
  }
  class MockRange {
    constructor(public start: MockPosition, public end: MockPosition) {}
  }
  class MockUri {
    readonly scheme = "file";
    readonly path: string;
    constructor(path: string) {
      this.path = path;
    }
    toString(): string {
      return `file://${this.path}`;
    }
    static file(path: string): MockUri {
      return new MockUri(path);
    }
  }
  class MockLocation {
    constructor(public uri: MockUri, public range: MockRange) {}
  }

  const mockGetConfiguration = vi.fn();
  const mockCreateChatParticipant = vi.fn();

  return {
    MockUri,
    MockLocation,
    MockPosition,
    MockRange,
    mockGetConfiguration,
    mockCreateChatParticipant,
  };
});

vi.mock("vscode", () => ({
  Uri: MockUri,
  Location: MockLocation,
  Position: MockPosition,
  Range: MockRange,
  workspace: {
    fs: {
      stat: vi.fn().mockResolvedValue({ type: 1, size: 0 }),
      readFile: vi.fn().mockResolvedValue(Buffer.from("")),
    },
    openTextDocument: vi.fn(),
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
    getConfiguration: (...args: unknown[]) => mockGetConfiguration(...args),
  },
  chat: {
    createChatParticipant: (...args: unknown[]) =>
      mockCreateChatParticipant(...args),
  },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
}));

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    time: () => vi.fn(),
  }),
}));

// ── Shared helpers ──

function createMockAcpClient(overrides: Record<string, unknown> = {}) {
  return {
    isConnected: true,
    start: vi.fn(),
    newSession: vi.fn().mockResolvedValue("test-session-id"),
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    cancel: vi.fn(),
    setModel: vi.fn().mockResolvedValue(undefined),
    onSessionUpdate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    setPermissionHandler: vi.fn(),
    setElicitationHandler: vi.fn(),
    extNotification: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockRequest(prompt: string) {
  return {
    prompt,
    references: [],
    toolReferences: [],
    model: { id: "test-model", vendor: "copilot" },
  };
}

function createMockResponse() {
  return {
    markdown: vi.fn(),
    progress: vi.fn(),
    anchor: vi.fn(),
    reference: vi.fn(),
    button: vi.fn(),
    filetree: vi.fn(),
    push: vi.fn(),
  };
}

function createMockToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: vi.fn(),
  };
}

async function setupAndGetHandler(acpClient: ReturnType<typeof createMockAcpClient>) {
  const { registerChatParticipant } = await import("../src/chat-participant.js");
  registerChatParticipant(acpClient as any);
  expect(mockCreateChatParticipant).toHaveBeenCalled();
  return mockCreateChatParticipant.mock.calls[0][1] as (
    ...args: unknown[]
  ) => Promise<unknown>;
}

// ── Item 2: Return proper ChatResult ──

describe("ChatResult return value", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateChatParticipant.mockReturnValue({
      iconPath: null,
      onDidReceiveFeedback: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      followupProvider: undefined,
      dispose: vi.fn(),
    });
    mockGetConfiguration.mockReturnValue({
      get: () => undefined,
    });
  });

  it("returns ChatResult with metadata on successful prompt", async () => {
    const acpClient = createMockAcpClient();
    const handler = await setupAndGetHandler(acpClient);

    const result = await handler(
      createMockRequest("hello"),
      { history: [] },
      createMockResponse(),
      createMockToken(),
    );

    expect(result).toBeDefined();
    expect(result).toHaveProperty("metadata");
    const metadata = (result as any).metadata;
    expect(metadata.sessionId).toBe("test-session-id");
    expect(metadata.stopReason).toBe("end_turn");
  });

  it("returns ChatResult with errorDetails on prompt failure", async () => {
    const acpClient = createMockAcpClient({
      prompt: vi.fn().mockRejectedValue(new Error("LLM rate limited")),
    });
    const handler = await setupAndGetHandler(acpClient);

    const result = await handler(
      createMockRequest("hello"),
      { history: [] },
      createMockResponse(),
      createMockToken(),
    );

    expect(result).toBeDefined();
    expect(result).toHaveProperty("errorDetails");
    expect((result as any).errorDetails.message).toContain("LLM rate limited");
  });

  it("returns ChatResult with errorDetails on session creation failure", async () => {
    const acpClient = createMockAcpClient({
      newSession: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    const handler = await setupAndGetHandler(acpClient);

    const result = await handler(
      createMockRequest("hello"),
      { history: [] },
      createMockResponse(),
      createMockToken(),
    );

    expect(result).toBeDefined();
    expect(result).toHaveProperty("errorDetails");
    expect((result as any).errorDetails.message).toContain("connection refused");
  });
});

// ── Item 3: stream.anchor() for tool call locations ──

describe("renderSessionUpdate — tool call anchors", () => {
  let sessionUpdateHandler: (params: any) => void;
  let mockStream: ReturnType<typeof createMockResponse>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateChatParticipant.mockReturnValue({
      iconPath: null,
      onDidReceiveFeedback: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      followupProvider: undefined,
      dispose: vi.fn(),
    });
    mockGetConfiguration.mockReturnValue({
      get: () => undefined,
    });
  });

  async function setupWithStreamCapture(
    updates: Array<{ sessionId: string; update: Record<string, unknown> }>,
  ) {
    const acpClient = createMockAcpClient();

    // Capture the sessionUpdate handler
    acpClient.onSessionUpdate = vi.fn().mockImplementation((handler) => {
      sessionUpdateHandler = handler;
      return { dispose: vi.fn() };
    });

    // Make prompt fire the session updates while the stream is active
    acpClient.prompt = vi.fn().mockImplementation(async () => {
      for (const u of updates) {
        sessionUpdateHandler(u);
      }
      return { stopReason: "end_turn" };
    });

    const handler = await setupAndGetHandler(acpClient);

    mockStream = createMockResponse();
    await handler(
      createMockRequest("test"),
      { history: [] },
      mockStream,
      createMockToken(),
    );

    return { acpClient, mockStream };
  }

  it("renders anchors for tool_call locations", async () => {
    await setupWithStreamCapture([
      {
        sessionId: "test-session-id",
        update: {
          sessionUpdate: "tool_call",
          title: "Edit file",
          status: "running",
          toolCallId: "tc-1",
          locations: [
            { path: "/workspace/src/main.ts", line: 42 },
            { path: "/workspace/src/utils.ts" },
          ],
        },
      },
    ]);

    expect(mockStream.anchor).toHaveBeenCalled();
  });

  it("does not call anchor when tool_call has no locations", async () => {
    await setupWithStreamCapture([
      {
        sessionId: "test-session-id",
        update: {
          sessionUpdate: "tool_call",
          title: "Run command",
          status: "running",
          toolCallId: "tc-2",
        },
      },
    ]);

    expect(mockStream.anchor).not.toHaveBeenCalled();
    // progress should still be called
    expect(mockStream.progress).toHaveBeenCalled();
  });

  it("renders anchors for tool_call_update locations", async () => {
    await setupWithStreamCapture([
      {
        sessionId: "test-session-id",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          locations: [{ path: "/workspace/src/main.ts", line: 10 }],
        },
      },
    ]);

    expect(mockStream.anchor).toHaveBeenCalled();
  });
});

// ── Item 4: stream.reference() for diffs ──

describe("renderSessionUpdate — file references for diffs", () => {
  let sessionUpdateHandler: (params: any) => void;
  let mockStream: ReturnType<typeof createMockResponse>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateChatParticipant.mockReturnValue({
      iconPath: null,
      onDidReceiveFeedback: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      followupProvider: undefined,
      dispose: vi.fn(),
    });
    mockGetConfiguration.mockReturnValue({
      get: () => undefined,
    });
  });

  let sessionUpdateHandler2: (params: any) => void;

  async function setupWithStreamCapture2(
    updates: Array<{ sessionId: string; update: Record<string, unknown> }>,
  ) {
    const acpClient = createMockAcpClient();

    acpClient.onSessionUpdate = vi.fn().mockImplementation((handler) => {
      sessionUpdateHandler2 = handler;
      return { dispose: vi.fn() };
    });

    acpClient.prompt = vi.fn().mockImplementation(async () => {
      for (const u of updates) {
        sessionUpdateHandler2(u);
      }
      return { stopReason: "end_turn" };
    });

    const handler = await setupAndGetHandler(acpClient);

    mockStream = createMockResponse();
    await handler(
      createMockRequest("test"),
      { history: [] },
      mockStream,
      createMockToken(),
    );

    return { acpClient, mockStream };
  }

  it("adds file reference when tool_call_update has diff content", async () => {
    await setupWithStreamCapture2([
      {
        sessionId: "test-session-id",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "/workspace/src/main.ts",
              oldText: "old code",
              newText: "new code",
            },
          ],
        },
      },
    ]);

    expect(mockStream.reference).toHaveBeenCalled();
  });

  it("does not add file reference when tool_call_update has no diff", async () => {
    await setupWithStreamCapture2([
      {
        sessionId: "test-session-id",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "some output" },
            },
          ],
        },
      },
    ]);

    expect(mockStream.reference).not.toHaveBeenCalled();
  });
});

// ── Filetree parsers ──

import {
  tryParseReadToolDirectory,
  tryParseLsDirectory,
} from "../src/chat-participant.js";

describe("tryParseReadToolDirectory", () => {
  it("parses a standard read_tool directory output", () => {
    const text = [
      "<path>/Users/wiking/vjepa2/app</path>",
      "<type>directory</type>",
      "<entries>",
      "main.py",
      "scaffold.py",
      "vjepa/",
      "vjepa_cute/",
      "(4 entries)",
      "</entries>",
    ].join("\n");

    const result = tryParseReadToolDirectory(text);
    expect(result).not.toBeNull();
    expect(result!.basePath).toBe("/Users/wiking/vjepa2/app");
    expect(result!.entries).toHaveLength(4);
    expect(result!.entries[0]).toEqual({ name: "main.py" });
    expect(result!.entries[1]).toEqual({ name: "scaffold.py" });
    expect(result!.entries[2]).toEqual({ name: "vjepa", children: [] });
    expect(result!.entries[3]).toEqual({ name: "vjepa_cute", children: [] });
  });

  it("returns null for file type read_tool output", () => {
    const text = [
      "<path>/workspace/src/main.ts</path>",
      "<type>file</type>",
      "<content>",
      "export function main() {}",
      "</content>",
    ].join("\n");

    expect(tryParseReadToolDirectory(text)).toBeNull();
  });

  it("returns null for non-XML text", () => {
    expect(tryParseReadToolDirectory("just some random text")).toBeNull();
  });
});

describe("tryParseLsDirectory", () => {
  it("parses a depth-prefix ls output", () => {
    const text = [
      "/Users/wiking/vjepa2/src/",
      "0 datasets/",
      "1 utils/",
      "2 video/",
      "0 hub/",
      "0 models/",
      "1 utils/",
      "0 utils/",
      "1 data_manager.py",
      "1 imagenet1k.py",
      "(9 entries)",
    ].join("\n");

    const result = tryParseLsDirectory(text);
    expect(result).not.toBeNull();
    expect(result!.basePath).toBe("/Users/wiking/vjepa2/src");

    // Top-level entries
    expect(result!.entries).toHaveLength(4);
    expect(result!.entries[0].name).toBe("datasets");
    expect(result!.entries[0].children).toBeDefined();

    // datasets -> utils -> video
    expect(result!.entries[0].children![0].name).toBe("utils");
    expect(result!.entries[0].children![0].children![0].name).toBe("video");

    // hub
    expect(result!.entries[1].name).toBe("hub");
    expect(result!.entries[1].children).toEqual([]);

    // models -> utils
    expect(result!.entries[2].name).toBe("models");
    expect(result!.entries[2].children![0].name).toBe("utils");

    // utils -> data_manager.py, imagenet1k.py
    expect(result!.entries[3].name).toBe("utils");
    expect(result!.entries[3].children).toHaveLength(2);
    expect(result!.entries[3].children![0]).toEqual({ name: "data_manager.py" });
    expect(result!.entries[3].children![1]).toEqual({ name: "imagenet1k.py" });
  });

  it("parses a flat single-level listing", () => {
    const text = [
      "/workspace/",
      "0 src/",
      "0 Cargo.toml",
      "0 README.md",
      "(3 entries)",
    ].join("\n");

    const result = tryParseLsDirectory(text);
    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(3);
    expect(result!.entries[0]).toEqual({ name: "src", children: [] });
    expect(result!.entries[1]).toEqual({ name: "Cargo.toml" });
    expect(result!.entries[2]).toEqual({ name: "README.md" });
  });

  it("returns null for non-ls text", () => {
    expect(tryParseLsDirectory("just some random text output")).toBeNull();
  });

  it("returns null for text that looks like code", () => {
    const text = "function hello() {\n  return 42;\n}";
    expect(tryParseLsDirectory(text)).toBeNull();
  });

  it("handles file entry with unexpected child at deeper depth without crashing", () => {
    // Edge case: a file at depth 0 followed by an entry at depth 1.
    // This shouldn't happen in normal ls output, but the parser must not crash.
    const text = [
      "/workspace/",
      "0 readme.txt",
      "1 orphan.txt",
      "(2 entries)",
    ].join("\n");

    // Should not throw
    const result = tryParseLsDirectory(text);
    expect(result).not.toBeNull();
    // orphan.txt should be nested under readme.txt (promoted to directory)
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].name).toBe("readme.txt");
    expect(result!.entries[0].children).toBeDefined();
    expect(result!.entries[0].children![0].name).toBe("orphan.txt");
  });

  it("does not crash on path-like first line followed by non-depth-prefix lines", () => {
    const text = [
      "/usr/local/bin/",
      "some random output that is not depth-prefixed",
      "another line",
    ].join("\n");

    // Should return null since lines don't match depth-prefix pattern
    expect(tryParseLsDirectory(text)).toBeNull();
  });

  it("handles empty listing", () => {
    const text = ["/workspace/project/", "(0 entries)"].join("\n");

    const result = tryParseLsDirectory(text);
    expect(result).not.toBeNull();
    expect(result!.basePath).toBe("/workspace/project");
    expect(result!.entries).toEqual([]);
  });
});

// ── Filetree rendering integration ──

describe("renderSessionUpdate — filetree rendering", () => {
  let sessionUpdateHandler: (params: any) => void;
  let mockStream: ReturnType<typeof createMockResponse>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateChatParticipant.mockReturnValue({
      iconPath: null,
      onDidReceiveFeedback: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      followupProvider: undefined,
      dispose: vi.fn(),
    });
    mockGetConfiguration.mockReturnValue({
      get: () => undefined,
    });
  });

  async function setupWithStreamCapture3(
    updates: Array<{ sessionId: string; update: Record<string, unknown> }>,
  ) {
    const acpClient = createMockAcpClient();

    acpClient.onSessionUpdate = vi.fn().mockImplementation((handler) => {
      sessionUpdateHandler = handler;
      return { dispose: vi.fn() };
    });

    acpClient.prompt = vi.fn().mockImplementation(async () => {
      for (const u of updates) {
        sessionUpdateHandler(u);
      }
      return { stopReason: "end_turn" };
    });

    const handler = await setupAndGetHandler(acpClient);
    mockStream = createMockResponse();
    await handler(
      createMockRequest("test"),
      { history: [] },
      mockStream,
      createMockToken(),
    );

    return { acpClient, mockStream };
  }

  it("renders ls directory output as filetree", async () => {
    const lsOutput = [
      "/workspace/src/",
      "0 components/",
      "0 main.ts",
      "(2 entries)",
    ].join("\n");

    await setupWithStreamCapture3([
      {
        sessionId: "test-session-id",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: lsOutput } },
          ],
        },
      },
    ]);

    expect(mockStream.filetree).toHaveBeenCalled();
    expect(mockStream.markdown).not.toHaveBeenCalledWith(
      expect.stringContaining("```"),
    );
  });

  it("renders read_tool directory output as filetree", async () => {
    const readToolOutput = [
      "<path>/workspace/src</path>",
      "<type>directory</type>",
      "<entries>",
      "main.ts",
      "utils/",
      "(2 entries)",
      "</entries>",
    ].join("\n");

    await setupWithStreamCapture3([
      {
        sessionId: "test-session-id",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: readToolOutput } },
          ],
        },
      },
    ]);

    expect(mockStream.filetree).toHaveBeenCalled();
  });

  it("renders non-directory text as markdown code block", async () => {
    await setupWithStreamCapture3([
      {
        sessionId: "test-session-id",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "regular output" } },
          ],
        },
      },
    ]);

    expect(mockStream.filetree).not.toHaveBeenCalled();
    expect(mockStream.markdown).toHaveBeenCalledWith(
      expect.stringContaining("regular output"),
    );
  });
});

// ── Item 3: Agent start failure returns ChatResult ──

describe("ChatResult on agent start failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateChatParticipant.mockReturnValue({
      iconPath: null,
      onDidReceiveFeedback: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      followupProvider: undefined,
      dispose: vi.fn(),
    });
    mockGetConfiguration.mockReturnValue({
      get: () => undefined,
    });
  });

  it("returns ChatResult with errorDetails when agent fails to start", async () => {
    const acpClient = createMockAcpClient({
      isConnected: false,
      start: vi.fn().mockRejectedValue(new Error("binary not found")),
    });
    const handler = await setupAndGetHandler(acpClient);

    const result = await handler(
      createMockRequest("hello"),
      { history: [] },
      createMockResponse(),
      createMockToken(),
    );

    expect(result).toBeDefined();
    expect(result).toHaveProperty("errorDetails");
    expect((result as any).errorDetails.message).toContain("binary not found");
  });
});

// ── Item 4: terminal content in tool_call_update ──

describe("renderSessionUpdate — terminal content", () => {
  let sessionUpdateHandler: (params: any) => void;
  let mockStream: ReturnType<typeof createMockResponse>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateChatParticipant.mockReturnValue({
      iconPath: null,
      onDidReceiveFeedback: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      followupProvider: undefined,
      dispose: vi.fn(),
    });
    mockGetConfiguration.mockReturnValue({
      get: () => undefined,
    });
  });

  async function setupWithStreamCapture4(
    updates: Array<{ sessionId: string; update: Record<string, unknown> }>,
  ) {
    const acpClient = createMockAcpClient();
    acpClient.onSessionUpdate = vi.fn().mockImplementation((handler) => {
      sessionUpdateHandler = handler;
      return { dispose: vi.fn() };
    });
    acpClient.prompt = vi.fn().mockImplementation(async () => {
      for (const u of updates) {
        sessionUpdateHandler(u);
      }
      return { stopReason: "end_turn" };
    });

    const handler = await setupAndGetHandler(acpClient);
    mockStream = createMockResponse();
    await handler(
      createMockRequest("test"),
      { history: [] },
      mockStream,
      createMockToken(),
    );
    return { acpClient, mockStream };
  }

  it("renders terminal content as a reference to the terminal", async () => {
    await setupWithStreamCapture4([
      {
        sessionId: "test-session-id",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          content: [
            { type: "terminal", terminalId: "term-abc" },
          ],
        },
      },
    ]);

    // Terminal content should produce some rendering (not be silently dropped)
    expect(mockStream.markdown).toHaveBeenCalled();
  });
});
