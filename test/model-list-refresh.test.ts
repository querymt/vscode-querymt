/**
 * Tests for model-list metadata parsing and webview retry behavior.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
    getConfiguration: vi.fn(() => ({
      get: vi.fn(),
    })),
  },
  extensions: {
    getExtension: vi.fn(() => undefined),
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

describe("fetchModelListWithMeta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses models and refresh metadata", async () => {
    const { fetchModelListWithMeta } = await import("../src/config-options.js");

    const result = await fetchModelListWithMeta({
      isConnected: true,
      extMethod: vi.fn().mockResolvedValue({
        models: [
          {
            id: "claude-sonnet-4-20250514",
            label: "Claude Sonnet 4",
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
          },
        ],
        meta: {
          refresh_in_progress: true,
          stale: false,
        },
      }),
    } as any);

    expect(result).toEqual({
      models: [
        {
          id: "claude-sonnet-4-20250514",
          label: "Claude Sonnet 4",
          provider: "anthropic",
        },
      ],
      refreshInProgress: true,
      stale: false,
    });
  });

  it("returns stale empty result on failure", async () => {
    const { fetchModelListWithMeta } = await import("../src/config-options.js");

    const result = await fetchModelListWithMeta({
      isConnected: true,
      extMethod: vi.fn().mockRejectedValue(new Error("boom")),
    } as any);

    expect(result).toEqual({
      models: [],
      refreshInProgress: false,
      stale: true,
    });
  });
});

describe("ChatViewProvider model-list retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it("posts loading state and retries when refresh is in progress", async () => {
    const { ChatViewProvider } = await import("../src/webview-chat.js");
    const acpClient = {
      isConnected: true,
      extMethod: vi
        .fn()
        .mockResolvedValueOnce({
          models: [],
          meta: { refresh_in_progress: true, stale: true },
        })
        .mockResolvedValueOnce({
          models: [
            {
              id: "gpt-4o",
              label: "GPT-4o",
              provider: "openai",
              model: "gpt-4o",
            },
          ],
          meta: { refresh_in_progress: false, stale: false },
        }),
    };

    const provider = new ChatViewProvider(
      { extensionPath: "/tmp/ext" } as any,
      acpClient as any,
      undefined,
    );

    const postToWebview = vi.fn();
    (provider as any).postToWebview = postToWebview;

    await (provider as any).sendModelList();

    expect(postToWebview).toHaveBeenCalledWith({
      type: "models",
      models: [],
      activeId: "",
      loading: true,
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(postToWebview).toHaveBeenLastCalledWith({
      type: "models",
      models: [
        {
          id: "gpt-4o",
          label: "GPT-4o",
          provider: "openai",
        },
      ],
      activeId: "",
      loading: false,
    });
  });

  it("retries once after the initial empty snapshot trigger case", async () => {
    const { ChatViewProvider } = await import("../src/webview-chat.js");
    const acpClient = {
      isConnected: true,
      extMethod: vi
        .fn()
        .mockResolvedValueOnce({
          models: [],
          meta: { refresh_in_progress: false, stale: true },
        })
        .mockResolvedValueOnce({
          models: [
            {
              id: "claude-sonnet-4-20250514",
              label: "Claude Sonnet 4",
              provider: "anthropic",
              model: "claude-sonnet-4-20250514",
            },
          ],
          meta: { refresh_in_progress: false, stale: false },
        }),
    };

    const provider = new ChatViewProvider(
      { extensionPath: "/tmp/ext" } as any,
      acpClient as any,
      undefined,
    );

    const postToWebview = vi.fn();
    (provider as any).postToWebview = postToWebview;

    await (provider as any).sendModelList();
    await vi.advanceTimersByTimeAsync(500);

    expect(acpClient.extMethod).toHaveBeenCalledTimes(2);
    expect(postToWebview).toHaveBeenLastCalledWith({
      type: "models",
      models: [
        {
          id: "claude-sonnet-4-20250514",
          label: "Claude Sonnet 4",
          provider: "anthropic",
        },
      ],
      activeId: "",
      loading: false,
    });
  });
});
