/**
 * Tests for webview slash command normalization and messaging.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";

function createMockDisposable() {
  return { dispose: vi.fn() };
}

const mockExtensionPath = "/tmp/querymt-test-ext";
mkdirSync(`${mockExtensionPath}/media`, { recursive: true });
writeFileSync(`${mockExtensionPath}/media/webview-chat.html`, "<html></html>");

function createMockWebviewView() {
  const messageHandlerRef: { current?: (msg: any) => Promise<void> | void } = {};
  const disposeHandlerRef: { current?: () => void } = {};

  return {
    webviewView: {
      webview: {
        options: undefined as any,
        html: "",
        onDidReceiveMessage: vi.fn((handler) => {
          messageHandlerRef.current = handler;
          return createMockDisposable();
        }),
      },
      onDidDispose: vi.fn((handler) => {
        disposeHandlerRef.current = handler;
        return createMockDisposable();
      }),
    },
    messageHandlerRef,
    disposeHandlerRef,
  };
}

vi.mock("vscode", () => ({
  Uri: {
    file: vi.fn((path: string) => ({ fsPath: path })),
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

describe("webview slash command helpers", () => {
  it("normalizes slash command names", async () => {
    const { normalizeSlashCommandName } = await import("../src/webview-chat.js");

    expect(normalizeSlashCommandName("review")).toBe("/review");
    expect(normalizeSlashCommandName("/plan")).toBe("/plan");
    expect(normalizeSlashCommandName("  test  ")).toBe("/test");
  });

  it("extracts direct and nested input hints", async () => {
    const { extractSlashCommandInputHint } = await import("../src/webview-chat.js");

    expect(extractSlashCommandInputHint({ hint: "query to search" })).toBe(
      "query to search",
    );
    expect(
      extractSlashCommandInputHint({
        unstructured: { hint: "files or scope" },
      }),
    ).toBe("files or scope");
    expect(extractSlashCommandInputHint({})).toBeUndefined();
  });

  it("normalizes ACP command payloads", async () => {
    const { normalizeSlashCommands } = await import("../src/webview-chat.js");

    expect(
      normalizeSlashCommands([
        {
          name: "review",
          description: "Review the current changes",
          input: { hint: "scope" },
        },
        {
          name: "/plan",
          description: "Create an implementation plan",
          input: { unstructured: { hint: "task to plan" } },
        },
        { name: 42, description: "invalid" },
      ]),
    ).toEqual([
      {
        name: "/review",
        description: "Review the current changes",
        inputHint: "scope",
      },
      {
        name: "/plan",
        description: "Create an implementation plan",
        inputHint: "task to plan",
      },
    ]);
  });
});

describe("ChatViewProvider command messaging", () => {
  it("includes the stopReason in done messages for completed prompts", async () => {
    const { ChatViewProvider } = await import("../src/webview-chat.js");

    const acpClient = {
      isConnected: true,
      onSessionUpdate: vi.fn(() => createMockDisposable()),
      prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    };

    const provider = new ChatViewProvider(
      { extensionPath: mockExtensionPath } as any,
      acpClient as any,
      undefined,
    );

    const postToWebview = vi.fn();
    (provider as any).postToWebview = postToWebview;
    (provider as any).activeSessionId = "session-1";
    (provider as any).resolveFileReferences = vi.fn().mockResolvedValue([]);

    await (provider as any).onPrompt("hello");

    expect(postToWebview).toHaveBeenNthCalledWith(2, {
      type: "done",
      stopReason: "end_turn",
    });
    expect(postToWebview).toHaveBeenNthCalledWith(3, {
      type: "status",
      state: "idle",
    });
  });

  it("posts a cancelled message when the prompt response stopReason is cancelled", async () => {
    const { ChatViewProvider } = await import("../src/webview-chat.js");

    const acpClient = {
      isConnected: true,
      onSessionUpdate: vi.fn(() => createMockDisposable()),
      prompt: vi.fn().mockResolvedValue({ stopReason: "cancelled" }),
    };

    const provider = new ChatViewProvider(
      { extensionPath: mockExtensionPath } as any,
      acpClient as any,
      undefined,
    );

    const postToWebview = vi.fn();
    (provider as any).postToWebview = postToWebview;
    (provider as any).activeSessionId = "session-1";
    (provider as any).resolveFileReferences = vi.fn().mockResolvedValue([]);

    await (provider as any).onPrompt("stop now");

    expect(acpClient.prompt).toHaveBeenCalledWith("session-1", [
      { type: "text", text: "stop now" },
    ]);
    expect(postToWebview).toHaveBeenNthCalledWith(1, {
      type: "status",
      state: "streaming",
    });
    expect(postToWebview).toHaveBeenCalledWith({ type: "cancelled" });
    expect(postToWebview).toHaveBeenNthCalledWith(3, {
      type: "done",
      stopReason: "cancelled",
    });
    expect(postToWebview).toHaveBeenNthCalledWith(4, {
      type: "status",
      state: "idle",
    });
  });

  it("registers the ACP session update subscription only once across multiple resolves", async () => {
    const { ChatViewProvider } = await import("../src/webview-chat.js");

    let sessionUpdateHandler: ((params: any) => void) | undefined;
    const acpClient = {
      onSessionUpdate: vi.fn((handler) => {
        sessionUpdateHandler = handler;
        return createMockDisposable();
      }),
    };

    const provider = new ChatViewProvider(
      { extensionPath: mockExtensionPath } as any,
      acpClient as any,
      undefined,
    );

    const first = createMockWebviewView();
    const second = createMockWebviewView();

    provider.resolveWebviewView(first.webviewView as any, {} as any, {} as any);
    provider.resolveWebviewView(second.webviewView as any, {} as any, {} as any);

    expect(acpClient.onSessionUpdate).toHaveBeenCalledTimes(1);
    expect(sessionUpdateHandler).toBeTypeOf("function");
  });

  it("disposes the previous webview message listener when the view is resolved again", async () => {
    const { ChatViewProvider } = await import("../src/webview-chat.js");

    const updateDisposable = createMockDisposable();
    const acpClient = {
      onSessionUpdate: vi.fn(() => updateDisposable),
    };

    const provider = new ChatViewProvider(
      { extensionPath: mockExtensionPath } as any,
      acpClient as any,
      undefined,
    );

    const first = createMockWebviewView();
    const second = createMockWebviewView();
    const firstDisposable = createMockDisposable();
    const secondDisposable = createMockDisposable();

    first.webviewView.webview.onDidReceiveMessage = vi.fn(() => firstDisposable);
    second.webviewView.webview.onDidReceiveMessage = vi.fn(() => secondDisposable);

    provider.resolveWebviewView(first.webviewView as any, {} as any, {} as any);
    provider.resolveWebviewView(second.webviewView as any, {} as any, {} as any);

    expect(firstDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(secondDisposable.dispose).not.toHaveBeenCalled();
    expect(updateDisposable.dispose).not.toHaveBeenCalled();
  });

  it("disposes the ACP update subscription when the provider is disposed", async () => {
    const { ChatViewProvider } = await import("../src/webview-chat.js");

    const updateDisposable = createMockDisposable();
    const acpClient = {
      onSessionUpdate: vi.fn(() => updateDisposable),
    };

    const provider = new ChatViewProvider(
      { extensionPath: mockExtensionPath } as any,
      acpClient as any,
      undefined,
    );

    provider.dispose();

    expect(updateDisposable.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent prompts before the first one reaches ACP prompt", async () => {
    const { ChatViewProvider } = await import("../src/webview-chat.js");

    let releaseStart: (() => void) | undefined;
    const acpClient = {
      isConnected: false,
      onSessionUpdate: vi.fn(() => createMockDisposable()),
      start: vi.fn(() => new Promise<void>((resolve) => {
        releaseStart = resolve;
      })),
      prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    };

    const provider = new ChatViewProvider(
      { extensionPath: mockExtensionPath } as any,
      acpClient as any,
      undefined,
    );

    const postToWebview = vi.fn();
    (provider as any).postToWebview = postToWebview;
    (provider as any).activeSessionId = "session-1";
    (provider as any).resolveFileReferences = vi.fn().mockResolvedValue([]);

    const firstPrompt = (provider as any).onPrompt("hello");
    const secondPrompt = (provider as any).onPrompt("hello again");

    expect(acpClient.start).toHaveBeenCalledTimes(1);
    expect(acpClient.prompt).not.toHaveBeenCalled();

    releaseStart?.();
    await Promise.all([firstPrompt, secondPrompt]);

    expect(acpClient.prompt).toHaveBeenCalledTimes(1);
    expect(acpClient.prompt).toHaveBeenCalledWith("session-1", [
      { type: "text", text: "hello" },
    ]);
    expect(postToWebview).toHaveBeenNthCalledWith(1, {
      type: "status",
      state: "streaming",
    });
  });

  it("clears before loading a switched session and keeps the target session active during replay", async () => {
    const { ChatViewProvider } = await import("../src/webview-chat.js");

    const acpClient = {
      onSessionUpdate: vi.fn(() => createMockDisposable()),
      loadSession: vi.fn(async () => {
        const sessionUpdateHandler = acpClient.onSessionUpdate.mock.calls[0]?.[0];
        sessionUpdateHandler?.({
          sessionId: "session-2",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "loaded reply" },
            messageId: "msg-1",
          },
        });
        return {};
      }),
    };

    const provider = new ChatViewProvider(
      { extensionPath: mockExtensionPath } as any,
      acpClient as any,
      undefined,
    );

    const postToWebview = vi.fn();
    (provider as any).postToWebview = postToWebview;
    (provider as any).activeSessionId = "session-1";
    (provider as any).sendSessionList = vi.fn().mockResolvedValue(undefined);
    (provider as any).sendConfigOptions = vi.fn();
    (provider as any).sendCommands = vi.fn();
    (provider as any).sendModelList = vi.fn().mockResolvedValue(undefined);

    await (provider as any).onSwitchSession("session-2");

    expect(postToWebview).toHaveBeenNthCalledWith(1, { type: "clear" });
    expect(postToWebview).toHaveBeenNthCalledWith(2, {
      type: "chunk",
      text: "loaded reply",
    });
    expect(acpClient.loadSession).toHaveBeenCalledWith("session-2");
    expect((provider as any).activeSessionId).toBe("session-2");
  });

  it("posts stored commands for the active session", async () => {
    const { ChatViewProvider } = await import("../src/webview-chat.js");

    const provider = new ChatViewProvider(
      { extensionPath: mockExtensionPath } as any,
      { onSessionUpdate: vi.fn(() => createMockDisposable()) } as any,
      undefined,
    );

    const postToWebview = vi.fn();
    (provider as any).postToWebview = postToWebview;
    (provider as any).sessionCommands.set("session-1", [
      { name: "/review", description: "Review code", inputHint: "scope" },
    ]);

    (provider as any).sendCommands("session-1");

    expect(postToWebview).toHaveBeenCalledWith({
      type: "commands",
      commands: [
        { name: "/review", description: "Review code", inputHint: "scope" },
      ],
    });
  });

  it("posts an empty command list when a session has none", async () => {
    const { ChatViewProvider } = await import("../src/webview-chat.js");

    const provider = new ChatViewProvider(
      { extensionPath: mockExtensionPath } as any,
      { onSessionUpdate: vi.fn(() => createMockDisposable()) } as any,
      undefined,
    );

    const postToWebview = vi.fn();
    (provider as any).postToWebview = postToWebview;

    (provider as any).sendCommands("missing-session");

    expect(postToWebview).toHaveBeenCalledWith({
      type: "commands",
      commands: [],
    });
  });
});
