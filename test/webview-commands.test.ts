/**
 * Tests for webview slash command normalization and messaging.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({}));

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
  it("posts stored commands for the active session", async () => {
    const { ChatViewProvider } = await import("../src/webview-chat.js");

    const provider = new ChatViewProvider(
      { extensionPath: "/tmp/ext" } as any,
      {} as any,
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
      { extensionPath: "/tmp/ext" } as any,
      {} as any,
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
