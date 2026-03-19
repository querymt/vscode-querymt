/**
 * TDD tests for usage_update display in the status bar.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreateStatusBarItem } = vi.hoisted(() => {
  const mockCreateStatusBarItem = vi.fn();
  return { mockCreateStatusBarItem };
});

vi.mock("vscode", () => ({
  window: {
    createStatusBarItem: (...args: unknown[]) => mockCreateStatusBarItem(...args),
  },
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class {
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

import { StatusBar } from "../src/status-bar.js";

describe("StatusBar.updateUsage", () => {
  let statusBar: StatusBar;
  let mockItem: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockItem = {
      text: "",
      tooltip: "",
      command: "",
      name: "",
      backgroundColor: undefined,
      show: vi.fn(),
      dispose: vi.fn(),
    };
    mockCreateStatusBarItem.mockReturnValue(mockItem);

    const mockAcpClient = {
      isConnected: true,
    };
    statusBar = new StatusBar(mockAcpClient as any);
  });

  it("exposes an updateUsage method", () => {
    expect(typeof statusBar.updateUsage).toBe("function");
  });

  it("shows token usage in the status bar tooltip", () => {
    statusBar.updateUsage({ size: 128000, used: 45000 });

    // toLocaleString may add commas (e.g., "45,000")
    expect(mockItem.tooltip).toContain("45");
    expect(mockItem.tooltip).toContain("128");
  });

  it("shows cost in the tooltip when present", () => {
    statusBar.updateUsage({
      size: 128000,
      used: 45000,
      cost: { amount: 0.042, currency: "USD" },
    });

    expect(mockItem.tooltip).toContain("0.04");
    expect(mockItem.tooltip).toContain("USD");
  });

  it("includes token count in the status bar text", () => {
    statusBar.updateUsage({ size: 128000, used: 45000 });

    // Status bar text should indicate token usage compactly
    expect(mockItem.text).toContain("45");
  });

  it("clears usage when called with zero values", () => {
    statusBar.updateUsage({ size: 128000, used: 45000 });
    statusBar.updateUsage({ size: 0, used: 0 });

    // Should revert to normal connected state
    expect(mockItem.text).not.toContain("45");
  });
});
