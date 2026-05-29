/**
 * Tests for AcpClient startup coordination.
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
}));

describe("AcpClient.ensureStarted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns immediately when already connected", async () => {
    const { AcpClient } = await import("../src/acp-client.js");
    const client = new AcpClient("/tmp/test-storage");

    const startSpy = vi.spyOn(client, "start").mockResolvedValue();
    (client as any).connection = { signal: { aborted: false } };

    await client.ensureStarted();

    expect(startSpy).not.toHaveBeenCalled();
  });

  it("coalesces concurrent startup requests", async () => {
    const { AcpClient } = await import("../src/acp-client.js");
    const client = new AcpClient("/tmp/test-storage");

    let resolveStart: (() => void) | undefined;
    const startSpy = vi.spyOn(client, "start").mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveStart = resolve;
      }),
    );

    const first = client.ensureStarted();
    const second = client.ensureStarted();
    const third = client.ensureStarted();

    expect(startSpy).toHaveBeenCalledTimes(1);
    resolveStart?.();
    await Promise.all([first, second, third]);
    expect((client as any).startPromise).toBeUndefined();
  });

  it("clears startPromise after a failed startup so retries work", async () => {
    const { AcpClient } = await import("../src/acp-client.js");
    const client = new AcpClient("/tmp/test-storage");

    const startSpy = vi.spyOn(client, "start")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce();

    await expect(client.ensureStarted()).rejects.toThrow("boom");
    expect((client as any).startPromise).toBeUndefined();

    await client.ensureStarted();
    expect(startSpy).toHaveBeenCalledTimes(2);
  });
});
