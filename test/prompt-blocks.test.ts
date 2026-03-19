/**
 * Unit tests for buildPromptBlocks — verifies that VS Code chat references
 * (attached files, selections, strings) are correctly converted to ACP
 * ContentBlock objects (EmbeddedResource, ResourceLink, Text).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vscode mock ──
// vi.mock factories are hoisted above imports, so all values they reference
// must be created via vi.hoisted() which is hoisted even higher.

const {
  MockUri,
  MockLocation,
  mockStat,
  mockReadFile,
  mockOpenTextDocument,
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
    static parse(s: string): MockUri {
      return new MockUri(s.replace(/^file:\/\//, ""));
    }
  }

  class MockLocation {
    constructor(
      public readonly uri: MockUri,
      public readonly range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      },
    ) {}
  }

  // Use inline vi-compatible fn stubs (vi is available inside vi.hoisted)
  const mockStat = vi.fn();
  const mockReadFile = vi.fn();
  const mockOpenTextDocument = vi.fn();

  return { MockUri, MockLocation, mockStat, mockReadFile, mockOpenTextDocument };
});

vi.mock("vscode", () => ({
  Uri: MockUri,
  Location: MockLocation,
  workspace: {
    fs: {
      stat: (...args: unknown[]) => mockStat(...args),
      readFile: (...args: unknown[]) => mockReadFile(...args),
    },
    openTextDocument: (...args: unknown[]) => mockOpenTextDocument(...args),
  },
}));

// ── logger mock (chat-participant.ts imports createLogger) ──
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

// Now safe to import the function under test
import { buildPromptBlocks, MAX_EMBED_BYTES } from "../src/chat-participant.js";

// ── Helpers ──

/** Minimal fake ChatRequest with the fields buildPromptBlocks uses. */
function fakeRequest(
  prompt: string,
  references: Array<{ id: string; value: unknown; modelDescription?: string }> = [],
  toolReferences: Array<{ name: string }> = [],
) {
  return { prompt, references, toolReferences } as Parameters<typeof buildPromptBlocks>[0];
}

// ── Tests ──

describe("buildPromptBlocks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a single text block when there are no references", async () => {
    const blocks = await buildPromptBlocks(fakeRequest("summarize this code"));

    expect(blocks).toEqual([{ type: "text", text: "summarize this code" }]);
  });

  it("embeds a file Uri reference as an EmbeddedResource", async () => {
    const uri = MockUri.file("/workspace/src/main.ts");
    const fileContent = "export function main() {}";

    mockStat.mockResolvedValue({ type: 1, size: fileContent.length });
    mockReadFile.mockResolvedValue(Buffer.from(fileContent, "utf-8"));

    const blocks = await buildPromptBlocks(
      fakeRequest("explain this", [{ id: "file:main.ts", value: uri }]),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "explain this" });
    expect(blocks[1]).toEqual({
      type: "resource",
      resource: {
        uri: uri.toString(),
        text: fileContent,
      },
    });
  });

  it("embeds multiple file references", async () => {
    const uri1 = MockUri.file("/workspace/a.ts");
    const uri2 = MockUri.file("/workspace/b.ts");

    mockStat.mockResolvedValue({ type: 1, size: 10 });
    mockReadFile
      .mockResolvedValueOnce(Buffer.from("file-a-content", "utf-8"))
      .mockResolvedValueOnce(Buffer.from("file-b-content", "utf-8"));

    const blocks = await buildPromptBlocks(
      fakeRequest("compare these", [
        { id: "file:a.ts", value: uri1 },
        { id: "file:b.ts", value: uri2 },
      ]),
    );

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "text", text: "compare these" });
    expect(blocks[1]).toEqual({
      type: "resource",
      resource: { uri: uri1.toString(), text: "file-a-content" },
    });
    expect(blocks[2]).toEqual({
      type: "resource",
      resource: { uri: uri2.toString(), text: "file-b-content" },
    });
  });

  it("embeds a Location reference with only the selected range text", async () => {
    const uri = MockUri.file("/workspace/src/utils.ts");
    const location = new MockLocation(uri, {
      start: { line: 5, character: 0 },
      end: { line: 10, character: 0 },
    });

    const selectedText = "function helper() {\n  return 42;\n}";
    mockOpenTextDocument.mockResolvedValue({
      getText: (range: unknown) => {
        // Verify range is passed through
        expect(range).toBe(location.range);
        return selectedText;
      },
    });

    const blocks = await buildPromptBlocks(
      fakeRequest("what does this do", [{ id: "selection", value: location }]),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "what does this do" });
    expect(blocks[1]).toEqual({
      type: "resource",
      resource: {
        uri: uri.toString(),
        text: selectedText,
      },
    });

    expect(mockOpenTextDocument).toHaveBeenCalledWith(uri);
  });

  it("includes a string reference as an additional text block", async () => {
    const blocks = await buildPromptBlocks(
      fakeRequest("help me with this", [
        { id: "copypaste", value: "some pasted code snippet" },
      ]),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "help me with this" });
    expect(blocks[1]).toEqual({ type: "text", text: "some pasted code snippet" });
  });

  it("falls back to resource_link for files exceeding MAX_EMBED_BYTES", async () => {
    const uri = MockUri.file("/workspace/huge-file.bin");

    mockStat.mockResolvedValue({ type: 1, size: MAX_EMBED_BYTES + 1 });

    const blocks = await buildPromptBlocks(
      fakeRequest("analyze", [{ id: "file:huge", value: uri }]),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "analyze" });
    expect(blocks[1]).toEqual({
      type: "resource_link",
      uri: uri.toString(),
      name: "huge-file.bin",
    });

    // Should NOT have tried to read the file content
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("falls back to resource_link when file read throws an error", async () => {
    const uri = MockUri.file("/workspace/broken.ts");

    mockStat.mockResolvedValue({ type: 1, size: 100 });
    mockReadFile.mockRejectedValue(new Error("ENOENT: file not found"));

    const blocks = await buildPromptBlocks(
      fakeRequest("read this", [{ id: "file:broken", value: uri }]),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "read this" });
    expect(blocks[1]).toEqual({
      type: "resource_link",
      uri: uri.toString(),
      name: "broken.ts",
    });
  });

  it("falls back to resource_link when stat throws an error", async () => {
    const uri = MockUri.file("/workspace/gone.ts");

    mockStat.mockRejectedValue(new Error("ENOENT"));

    const blocks = await buildPromptBlocks(
      fakeRequest("read", [{ id: "file:gone", value: uri }]),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "read" });
    expect(blocks[1]).toEqual({
      type: "resource_link",
      uri: uri.toString(),
      name: "gone.ts",
    });
  });

  it("handles mixed reference types in a single prompt", async () => {
    const fileUri = MockUri.file("/workspace/src/index.ts");
    const location = new MockLocation(
      MockUri.file("/workspace/src/helper.ts"),
      { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } },
    );
    const stringRef = "inline context from user";

    mockStat.mockResolvedValue({ type: 1, size: 50 });
    mockReadFile.mockResolvedValue(Buffer.from("index content", "utf-8"));
    mockOpenTextDocument.mockResolvedValue({
      getText: () => "helper content",
    });

    const blocks = await buildPromptBlocks(
      fakeRequest("do something", [
        { id: "file:index", value: fileUri },
        { id: "selection:helper", value: location },
        { id: "string:ctx", value: stringRef },
      ]),
    );

    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ type: "text", text: "do something" });
    expect(blocks[1]).toEqual({
      type: "resource",
      resource: { uri: fileUri.toString(), text: "index content" },
    });
    expect(blocks[2]).toEqual({
      type: "resource",
      resource: { uri: location.uri.toString(), text: "helper content" },
    });
    expect(blocks[3]).toEqual({ type: "text", text: "inline context from user" });
  });

  it("ignores references with unknown value types", async () => {
    const blocks = await buildPromptBlocks(
      fakeRequest("test", [{ id: "unknown", value: 42 }]),
    );

    // Should only have the text block, unknown ref silently skipped
    expect(blocks).toEqual([{ type: "text", text: "test" }]);
  });

  it("extracts the filename from uri path for resource_link name", async () => {
    const uri = MockUri.file("/deeply/nested/path/to/component.tsx");

    mockStat.mockResolvedValue({ type: 1, size: MAX_EMBED_BYTES + 1 });

    const blocks = await buildPromptBlocks(
      fakeRequest("check", [{ id: "file:component", value: uri }]),
    );

    expect(blocks[1]).toMatchObject({
      type: "resource_link",
      name: "component.tsx",
    });
  });

  it("embeds a file at exactly MAX_EMBED_BYTES (boundary)", async () => {
    const uri = MockUri.file("/workspace/edge.ts");
    const content = "x".repeat(MAX_EMBED_BYTES);

    mockStat.mockResolvedValue({ type: 1, size: MAX_EMBED_BYTES });
    mockReadFile.mockResolvedValue(Buffer.from(content, "utf-8"));

    const blocks = await buildPromptBlocks(
      fakeRequest("check boundary", [{ id: "file:edge", value: uri }]),
    );

    // Exactly at the limit should still embed (not >)
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ type: "resource" });
  });

  // ── Item 5: modelDescription ──

  it("includes modelDescription as text block before the resource block", async () => {
    const uri = MockUri.file("/workspace/src/main.ts");

    mockStat.mockResolvedValue({ type: 1, size: 50 });
    mockReadFile.mockResolvedValue(Buffer.from("file content", "utf-8"));

    const blocks = await buildPromptBlocks(
      fakeRequest("explain", [
        {
          id: "file:main",
          value: uri,
          modelDescription: "Contents of the main entry point",
        },
      ]),
    );

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "text", text: "explain" });
    // modelDescription should appear as text before the resource
    expect(blocks[1]).toEqual({
      type: "text",
      text: "Contents of the main entry point",
    });
    expect(blocks[2]).toMatchObject({ type: "resource" });
  });

  it("does not add modelDescription text block when not present", async () => {
    const uri = MockUri.file("/workspace/src/main.ts");

    mockStat.mockResolvedValue({ type: 1, size: 50 });
    mockReadFile.mockResolvedValue(Buffer.from("file content", "utf-8"));

    const blocks = await buildPromptBlocks(
      fakeRequest("explain", [{ id: "file:main", value: uri }]),
    );

    // Should be just prompt text + resource, no extra text block
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "explain" });
    expect(blocks[1]).toMatchObject({ type: "resource" });
  });

  // ── Item 6: toolReferences ──

  it("includes tool reference names as context text", async () => {
    const blocks = await buildPromptBlocks(
      fakeRequest(
        "help me",
        [],
        [{ name: "terminalSelection" }, { name: "codebase" }],
      ),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "help me" });
    expect(blocks[1]).toMatchObject({ type: "text" });
    expect((blocks[1] as any).text).toContain("terminalSelection");
    expect((blocks[1] as any).text).toContain("codebase");
  });

  it("does not add tool reference text when toolReferences is empty", async () => {
    const blocks = await buildPromptBlocks(
      fakeRequest("help me", [], []),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "text", text: "help me" });
  });
});
