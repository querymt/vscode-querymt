/**
 * TDD tests for:
 * - Item 7: followupProvider powered by available_commands_update
 * - Item 8: onDidReceiveFeedback forwarding + AcpClient.extNotification
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──

const {
  MockUri,
  mockGetConfiguration,
  mockCreateChatParticipant,
  capturedParticipant,
} = vi.hoisted(() => {
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

  const mockGetConfiguration = vi.fn();
  const mockCreateChatParticipant = vi.fn();
  // Store the participant object so we can inspect followupProvider and onDidReceiveFeedback
  const capturedParticipant: Record<string, unknown> = {
    iconPath: null,
    followupProvider: undefined,
    dispose: vi.fn(),
  };

  return { MockUri, mockGetConfiguration, mockCreateChatParticipant, capturedParticipant };
});

vi.mock("vscode", () => ({
  Uri: MockUri,
  Location: class {
    constructor(public uri: unknown, public range: unknown) {}
  },
  Position: class {
    constructor(public line: number, public character: number) {}
  },
  Range: class {
    constructor(public start: unknown, public end: unknown) {}
  },
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
    createChatParticipant: (...args: unknown[]) => {
      mockCreateChatParticipant(...args);
      return capturedParticipant;
    },
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

// ── Item 7: followupProvider ──

describe("followupProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedParticipant.followupProvider = undefined;
    capturedParticipant.iconPath = null;
    (capturedParticipant as any).onDidReceiveFeedback = vi.fn();
    mockGetConfiguration.mockReturnValue({ get: () => undefined });
  });

  it("sets a followupProvider on the participant", async () => {
    const acpClient = createMockAcpClient();
    const { registerChatParticipant } = await import("../src/chat-participant.js");

    registerChatParticipant(acpClient as any);

    expect(capturedParticipant.followupProvider).toBeDefined();
    expect(typeof (capturedParticipant.followupProvider as any).provideFollowups).toBe("function");
  });

  it("returns followups from stored available_commands_update", async () => {
    let sessionUpdateHandler: (params: any) => void;
    const acpClient = createMockAcpClient();

    acpClient.onSessionUpdate = vi.fn().mockImplementation((handler) => {
      sessionUpdateHandler = handler;
      return { dispose: vi.fn() };
    });

    // Make prompt fire an available_commands_update during execution
    acpClient.prompt = vi.fn().mockImplementation(async () => {
      sessionUpdateHandler!({
        sessionId: "test-session-id",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "explain_code", description: "Explain the selected code" },
            { name: "add_tests", description: "Add unit tests" },
          ],
        },
      });
      return { stopReason: "end_turn" };
    });

    const { registerChatParticipant } = await import("../src/chat-participant.js");
    registerChatParticipant(acpClient as any);

    const handler = mockCreateChatParticipant.mock.calls[0][1] as (...args: unknown[]) => Promise<unknown>;

    // Run a prompt to trigger the available_commands_update
    const result = await handler(
      createMockRequest("test"),
      { history: [] },
      createMockResponse(),
      createMockToken(),
    );

    // Now call provideFollowups with the result
    const provider = capturedParticipant.followupProvider as any;
    const followups = await provider.provideFollowups(
      result,
      { history: [] },
      createMockToken(),
    );

    expect(followups).toBeDefined();
    expect(followups.length).toBe(2);
    expect(followups[0]).toMatchObject({ prompt: "explain_code" });
    expect(followups[1]).toMatchObject({ prompt: "add_tests" });
  });

  it("returns empty array when no commands are stored", async () => {
    const acpClient = createMockAcpClient();
    const { registerChatParticipant } = await import("../src/chat-participant.js");
    registerChatParticipant(acpClient as any);

    const provider = capturedParticipant.followupProvider as any;
    const followups = await provider.provideFollowups(
      { metadata: { sessionId: "nonexistent" } },
      { history: [] },
      createMockToken(),
    );

    expect(followups).toEqual([]);
  });
});

// ── Item 8: onDidReceiveFeedback + AcpClient.extNotification ──

describe("AcpClient.extNotification", () => {
  it("should expose an extNotification method", async () => {
    const { AcpClient } = await import("../src/acp-client.js");
    const client = new AcpClient("/tmp/test-storage");
    expect(typeof client.extNotification).toBe("function");
  });

  it("should call connection.extNotification with method and params", async () => {
    const { AcpClient } = await import("../src/acp-client.js");
    const client = new AcpClient("/tmp/test-storage");

    const mockExtNotification = vi.fn().mockResolvedValue(undefined);
    const mockConnection = {
      signal: { aborted: false },
      extNotification: mockExtNotification,
    };
    // @ts-expect-error — accessing private field for test
    client.connection = mockConnection;

    await client.extNotification("querymt/feedback", { kind: "helpful" });

    expect(mockExtNotification).toHaveBeenCalledWith("querymt/feedback", {
      kind: "helpful",
    });
  });
});

describe("onDidReceiveFeedback", () => {
  let feedbackHandler: (feedback: any) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedParticipant.followupProvider = undefined;
    capturedParticipant.iconPath = null;
    // Mock onDidReceiveFeedback as an event registration function
    (capturedParticipant as any).onDidReceiveFeedback = vi.fn().mockImplementation((handler: any) => {
      feedbackHandler = handler;
      return { dispose: vi.fn() };
    });
    mockGetConfiguration.mockReturnValue({ get: () => undefined });
  });

  it("subscribes to onDidReceiveFeedback", async () => {
    const acpClient = createMockAcpClient();
    const { registerChatParticipant } = await import("../src/chat-participant.js");

    registerChatParticipant(acpClient as any);

    expect((capturedParticipant as any).onDidReceiveFeedback).toHaveBeenCalled();
  });

  it("sends helpful feedback as extNotification to the agent", async () => {
    const acpClient = createMockAcpClient();
    const { registerChatParticipant } = await import("../src/chat-participant.js");

    registerChatParticipant(acpClient as any);

    // Simulate feedback event
    feedbackHandler({
      result: { metadata: { sessionId: "session-abc" } },
      kind: 1, // ChatResultFeedbackKind.Helpful
    });

    // Allow async to settle
    await vi.waitFor(() => {
      expect(acpClient.extNotification).toHaveBeenCalledWith(
        "querymt/feedback",
        { sessionId: "session-abc", kind: "helpful" },
      );
    });
  });

  it("sends unhelpful feedback as extNotification to the agent", async () => {
    const acpClient = createMockAcpClient();
    const { registerChatParticipant } = await import("../src/chat-participant.js");

    registerChatParticipant(acpClient as any);

    feedbackHandler({
      result: { metadata: { sessionId: "session-def" } },
      kind: 0, // ChatResultFeedbackKind.Unhelpful
    });

    await vi.waitFor(() => {
      expect(acpClient.extNotification).toHaveBeenCalledWith(
        "querymt/feedback",
        { sessionId: "session-def", kind: "unhelpful" },
      );
    });
  });

  it("silently ignores feedback without sessionId in metadata", async () => {
    const acpClient = createMockAcpClient();
    const { registerChatParticipant } = await import("../src/chat-participant.js");

    registerChatParticipant(acpClient as any);

    feedbackHandler({
      result: {},
      kind: 1,
    });

    // Give it a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(acpClient.extNotification).not.toHaveBeenCalled();
  });
});
