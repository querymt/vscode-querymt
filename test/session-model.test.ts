/**
 * TDD tests for model/provider propagation.
 *
 * Verifies that:
 * 1. AcpClient exposes a setModel() method that delegates to the ACP SDK
 * 2. Model precedence: request.model (querymt vendor) > defaultModel setting > agent default
 * 3. setModel failures don't block the prompt
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──

const {
  MockUri,
  MockChatRequestTurn,
  mockGetConfiguration,
  mockCreateChatParticipant,
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

  class MockChatRequestTurn {
    constructor(public prompt: string) {}
  }

  const mockGetConfiguration = vi.fn();
  const mockCreateChatParticipant = vi.fn();

  return { MockUri, MockChatRequestTurn, mockGetConfiguration, mockCreateChatParticipant };
});

vi.mock("vscode", () => ({
  Uri: MockUri,
  Location: class {
    constructor(public uri: unknown, public range: unknown) {}
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
    createChatParticipant: (...args: unknown[]) =>
      mockCreateChatParticipant(...args),
  },
  ChatRequestTurn: MockChatRequestTurn,
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  CancellationTokenSource: class {
    token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
    cancel() {}
    dispose() {}
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

// ── Tests for AcpClient.setModel ──

describe("AcpClient.setModel", () => {
  it("should expose a setModel method", async () => {
    // We import AcpClient dynamically to get the mocked version
    const { AcpClient } = await import("../src/acp-client.js");
    const client = new AcpClient("/tmp/test-storage");

    expect(typeof client.setModel).toBe("function");
  });

  it("should call connection.unstable_setSessionModel with sessionId and modelId", async () => {
    const { AcpClient } = await import("../src/acp-client.js");
    const client = new AcpClient("/tmp/test-storage");

    // We need to inject a mock connection. Since `connection` is private,
    // we'll test through the public interface by checking that setModel
    // calls the underlying SDK method. We use Object.defineProperty to
    // inject a mock connection.
    const mockSetSessionModel = vi.fn().mockResolvedValue({});
    const mockConnection = {
      signal: { aborted: false },
      unstable_setSessionModel: mockSetSessionModel,
    };
    // @ts-expect-error — accessing private field for test
    client.connection = mockConnection;

    await client.setModel("session-123", "claude-sonnet-4-20250514");

    expect(mockSetSessionModel).toHaveBeenCalledWith({
      sessionId: "session-123",
      modelId: "claude-sonnet-4-20250514",
    });
  });

  it("should not throw if setModel is called and connection supports it", async () => {
    const { AcpClient } = await import("../src/acp-client.js");
    const client = new AcpClient("/tmp/test-storage");

    const mockSetSessionModel = vi.fn().mockResolvedValue({});
    const mockConnection = {
      signal: { aborted: false },
      unstable_setSessionModel: mockSetSessionModel,
    };
    // @ts-expect-error — accessing private field for test
    client.connection = mockConnection;

    await expect(
      client.setModel("session-456", "gpt-4o"),
    ).resolves.not.toThrow();
  });
});

// ── Tests for model propagation in chat participant ──

describe("chat participant model propagation", () => {
  let capturedHandler: (...args: unknown[]) => Promise<unknown>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Capture the chat request handler when registerChatParticipant is called
    mockCreateChatParticipant.mockReturnValue({
      iconPath: null,
      followupProvider: undefined,
      onDidReceiveFeedback: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      dispose: vi.fn(),
    });
  });

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

  function createMockRequest(
    prompt: string,
    model?: { id: string; vendor: string; name?: string; family?: string },
  ) {
    return {
      prompt,
      references: [],
      toolReferences: [],
      model: model ?? { id: "default-copilot-model", vendor: "copilot", name: "Copilot", family: "gpt-4o" },
    };
  }

  function createMockResponse() {
    return {
      markdown: vi.fn(),
      progress: vi.fn(),
    };
  }

  function createMockToken() {
    return {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(),
    };
  }

  async function setupAndGetHandler(acpClient: ReturnType<typeof createMockAcpClient>) {
    const { registerChatParticipant } = await import(
      "../src/chat-participant.js"
    );

    registerChatParticipant(acpClient as any);

    // The handler is passed as the second arg to createChatParticipant
    expect(mockCreateChatParticipant).toHaveBeenCalled();
    return mockCreateChatParticipant.mock.calls[0][1] as (
      ...args: unknown[]
    ) => Promise<unknown>;
  }

  // ── Precedence tests ──

  it("request.model with vendor 'querymt' sends provider/model format", async () => {
    const acpClient = createMockAcpClient();

    mockGetConfiguration.mockReturnValue({
      get: (key: string) => {
        if (key === "defaultModel") return "gpt-4o"; // lower precedence
        return undefined;
      },
    });

    const handler = await setupAndGetHandler(acpClient);

    await handler(
      createMockRequest("hello", {
        id: "claude-sonnet-4-20250514",
        vendor: "querymt",
        name: "Claude Sonnet",
        family: "anthropic", // family = provider name from agent
      }),
      { history: [] },
      createMockResponse(),
      createMockToken(),
    );

    expect(acpClient.newSession).toHaveBeenCalled();
    // Should send "provider/model" format using family as provider
    expect(acpClient.setModel).toHaveBeenCalledWith(
      "test-session-id",
      "anthropic/claude-sonnet-4-20250514",
    );
  });

  it("non-querymt vendor falls back to defaultProvider/defaultModel", async () => {
    const acpClient = createMockAcpClient();

    mockGetConfiguration.mockReturnValue({
      get: (key: string) => {
        if (key === "defaultModel") return "gpt-4o";
        if (key === "defaultProvider") return "openai";
        return undefined;
      },
    });

    const handler = await setupAndGetHandler(acpClient);

    await handler(
      createMockRequest("hello", {
        id: "copilot-gpt-4o",
        vendor: "copilot",
      }),
      { history: [] },
      createMockResponse(),
      createMockToken(),
    );

    expect(acpClient.newSession).toHaveBeenCalled();
    // Should combine defaultProvider/defaultModel
    expect(acpClient.setModel).toHaveBeenCalledWith(
      "test-session-id",
      "openai/gpt-4o",
    );
  });

  it("defaultModel with slash used as-is (provider already included)", async () => {
    const acpClient = createMockAcpClient();

    mockGetConfiguration.mockReturnValue({
      get: (key: string) => {
        if (key === "defaultModel") return "openrouter/gpt-4o";
        if (key === "defaultProvider") return "openai"; // should be ignored
        return undefined;
      },
    });

    const handler = await setupAndGetHandler(acpClient);

    await handler(
      createMockRequest("hello"), // default mock model has vendor "copilot"
      { history: [] },
      createMockResponse(),
      createMockToken(),
    );

    // Model already contains /, send as-is regardless of defaultProvider
    expect(acpClient.setModel).toHaveBeenCalledWith(
      "test-session-id",
      "openrouter/gpt-4o",
    );
  });

  it("defaultModel without slash and no defaultProvider sends model only", async () => {
    const acpClient = createMockAcpClient();

    mockGetConfiguration.mockReturnValue({
      get: (key: string) => {
        if (key === "defaultModel") return "deepseek-v3";
        if (key === "defaultProvider") return "";
        return undefined;
      },
    });

    const handler = await setupAndGetHandler(acpClient);

    await handler(
      createMockRequest("hello"),
      { history: [] },
      createMockResponse(),
      createMockToken(),
    );

    // No provider, just model name — agent uses current session provider
    expect(acpClient.setModel).toHaveBeenCalledWith(
      "test-session-id",
      "deepseek-v3",
    );
  });

  it("no defaultModel + non-querymt vendor → no setModel call (agent default)", async () => {
    const acpClient = createMockAcpClient();

    mockGetConfiguration.mockReturnValue({
      get: (key: string) => {
        if (key === "defaultModel") return "";
        return undefined;
      },
    });

    const handler = await setupAndGetHandler(acpClient);

    await handler(
      createMockRequest("hello", {
        id: "copilot-gpt-4o",
        vendor: "copilot",
      }),
      { history: [] },
      createMockResponse(),
      createMockToken(),
    );

    expect(acpClient.newSession).toHaveBeenCalled();
    expect(acpClient.setModel).not.toHaveBeenCalled();
  });

  it("should still send the prompt even if setModel fails", async () => {
    const acpClient = createMockAcpClient({
      setModel: vi.fn().mockRejectedValue(new Error("model not supported")),
    });

    mockGetConfiguration.mockReturnValue({
      get: (key: string) => {
        if (key === "defaultModel") return "nonexistent-model";
        return undefined;
      },
    });

    const handler = await setupAndGetHandler(acpClient);

    await handler(
      createMockRequest("hello"),
      { history: [] },
      createMockResponse(),
      createMockToken(),
    );

    // setModel was attempted
    expect(acpClient.setModel).toHaveBeenCalled();
    // prompt was still sent despite setModel failure
    expect(acpClient.prompt).toHaveBeenCalled();
  });

  // ── Item 5: Model change mid-conversation ──

  it("calls setModel on session reuse when querymt model changes", async () => {
    const acpClient = createMockAcpClient();

    mockGetConfiguration.mockReturnValue({
      get: () => undefined,
    });

    const handler = await setupAndGetHandler(acpClient);

    // Use a shared context so getThreadKey returns the same key for both calls.
    // getThreadKey uses first.prompt.slice(0,50) + history.length.
    const sharedContext = {
      history: [new MockChatRequestTurn("shared-thread")],
    };

    // First message — creates session with model A
    await handler(
      createMockRequest("first", {
        id: "claude-sonnet-4-20250514",
        vendor: "querymt",
        family: "anthropic",
      }),
      sharedContext,
      createMockResponse(),
      createMockToken(),
    );

    expect(acpClient.setModel).toHaveBeenCalledWith(
      "test-session-id",
      "anthropic/claude-sonnet-4-20250514",
    );
    acpClient.setModel.mockClear();
    acpClient.newSession.mockClear();

    // Second message — same thread but user switched to model B
    await handler(
      createMockRequest("second", {
        id: "gpt-4o",
        vendor: "querymt",
        family: "openai",
      }),
      sharedContext,
      createMockResponse(),
      createMockToken(),
    );

    // Should NOT have created a new session (reuse)
    expect(acpClient.newSession).not.toHaveBeenCalled();
    // But SHOULD have called setModel with the new model
    expect(acpClient.setModel).toHaveBeenCalledWith(
      "test-session-id",
      "openai/gpt-4o",
    );
  });

  it("does not call setModel on session reuse when model is unchanged", async () => {
    const acpClient = createMockAcpClient();

    mockGetConfiguration.mockReturnValue({
      get: () => undefined,
    });

    const handler = await setupAndGetHandler(acpClient);

    const sharedContext = {
      history: [new MockChatRequestTurn("shared-thread-2")],
    };

    // First message
    await handler(
      createMockRequest("first", {
        id: "claude-sonnet-4-20250514",
        vendor: "querymt",
        family: "anthropic",
      }),
      sharedContext,
      createMockResponse(),
      createMockToken(),
    );

    acpClient.setModel.mockClear();

    // Second message — same model
    await handler(
      createMockRequest("second", {
        id: "claude-sonnet-4-20250514",
        vendor: "querymt",
        family: "anthropic",
      }),
      sharedContext,
      createMockResponse(),
      createMockToken(),
    );

    // Same model — should NOT call setModel again
    expect(acpClient.setModel).not.toHaveBeenCalled();
  });
});
