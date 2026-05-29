/**
 * Tests for Language Model provider startup behavior.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetConfiguration, mockEventEmitter } = vi.hoisted(() => {
  const mockGetConfiguration = vi.fn();

  class MockEventEmitter<T> {
    fire = vi.fn<(event?: T) => void>();
    dispose = vi.fn();
    event = vi.fn();
  }

  return {
    mockGetConfiguration,
    mockEventEmitter: MockEventEmitter,
  };
});

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (...args: unknown[]) => mockGetConfiguration(...args),
  },
  EventEmitter: mockEventEmitter,
  LanguageModelTextPart: class {
    constructor(public value: string) {}
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
  formatError: (err: unknown) => String(err),
}));

describe("QueryMTModelProvider startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setAutoStart(value: boolean) {
    mockGetConfiguration.mockReturnValue({
      get: vi.fn().mockImplementation((key: string, fallback?: boolean) => {
        if (key === "autoStart") {
          return value;
        }
        return fallback;
      }),
    });
  }

  it("starts the agent before listing models when autoStart is enabled", async () => {
    setAutoStart(true);
    const acpClient = {
      isConnected: false,
      ensureStarted: vi.fn().mockImplementation(async () => {
        acpClient.isConnected = true;
      }),
      extMethod: vi.fn().mockResolvedValue({
        models: [
          {
            id: "claude-sonnet-4-20250514",
            label: "Claude Sonnet 4",
            source: "preset",
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
          },
        ],
      }),
    };

    const { QueryMTModelProvider } = await import("../src/model-provider.js");
    const provider = new QueryMTModelProvider(acpClient as any);

    const result = await provider.provideLanguageModelChatInformation(
      {} as any,
      { isCancellationRequested: false } as any,
    );

    expect(acpClient.ensureStarted).toHaveBeenCalledTimes(1);
    expect(acpClient.extMethod).toHaveBeenCalledWith("_querymt/models", {});
    expect(result).toHaveLength(1);
    expect(result[0]?.modelId).toBe("claude-sonnet-4-20250514");
  });

  it("returns no models without starting when autoStart is disabled", async () => {
    setAutoStart(false);
    const acpClient = {
      isConnected: false,
      ensureStarted: vi.fn(),
      extMethod: vi.fn(),
    };

    const { QueryMTModelProvider } = await import("../src/model-provider.js");
    const provider = new QueryMTModelProvider(acpClient as any);

    const result = await provider.provideLanguageModelChatInformation(
      {} as any,
      { isCancellationRequested: false } as any,
    );

    expect(acpClient.ensureStarted).not.toHaveBeenCalled();
    expect(acpClient.extMethod).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("returns no models when startup fails", async () => {
    setAutoStart(true);
    const acpClient = {
      isConnected: false,
      ensureStarted: vi.fn().mockRejectedValue(new Error("boom")),
      extMethod: vi.fn(),
    };

    const { QueryMTModelProvider } = await import("../src/model-provider.js");
    const provider = new QueryMTModelProvider(acpClient as any);

    const result = await provider.provideLanguageModelChatInformation(
      {} as any,
      { isCancellationRequested: false } as any,
    );

    expect(acpClient.ensureStarted).toHaveBeenCalledTimes(1);
    expect(acpClient.extMethod).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("fires model refresh notifications", async () => {
    setAutoStart(true);
    const acpClient = {
      isConnected: true,
      ensureStarted: vi.fn(),
      extMethod: vi.fn(),
    };

    const { QueryMTModelProvider } = await import("../src/model-provider.js");
    const provider = new QueryMTModelProvider(acpClient as any);

    provider.refreshModels();

    expect((provider as any)._onDidChange.fire).toHaveBeenCalledTimes(1);
  });
});
