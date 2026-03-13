/**
 * Workspace Query Handler — handles `_workspace/query` reverse-RPC requests
 * from the agent. Translates them into VS Code language API calls (diagnostics,
 * references, definitions, symbols, hover, type definitions).
 */

import * as vscode from "vscode";
import type {
  WorkspaceQueryParams,
  WorkspaceQueryResponse,
  DiagnosticInfo,
  LocationInfo,
  SymbolInfo,
  Position,
  Range,
} from "./types.js";

/**
 * Handle a _workspace/query request from the agent.
 * Returns the query response or throws on unknown action.
 */
export async function handleWorkspaceQuery(
  params: WorkspaceQueryParams,
): Promise<WorkspaceQueryResponse> {
  switch (params.action) {
    case "diagnostics":
      return handleDiagnostics(params);
    case "references":
      return handleReferences(params);
    case "definition":
      return handleDefinition(params);
    case "document_symbols":
      return handleDocumentSymbols(params);
    case "workspace_symbols":
      return handleWorkspaceSymbols(params);
    case "hover":
      return handleHover(params);
    case "type_definition":
      return handleTypeDefinition(params);
    default:
      throw new Error(
        `Unknown workspace query action: ${(params as WorkspaceQueryParams).action}`,
      );
  }
}

// ── Diagnostics ──

async function handleDiagnostics(
  params: WorkspaceQueryParams,
): Promise<WorkspaceQueryResponse> {
  const uri = vscode.Uri.parse(params.uri!);
  const diags = vscode.languages.getDiagnostics(uri);
  return {
    diagnostics: diags.map(
      (d): DiagnosticInfo => ({
        uri: params.uri!,
        range: serializeRange(d.range),
        severity: severityToString(d.severity),
        message: d.message,
        source: d.source,
        code:
          typeof d.code === "object"
            ? d.code?.value?.toString()
            : d.code?.toString(),
      }),
    ),
  };
}

// ── References ──

async function handleReferences(
  params: WorkspaceQueryParams,
): Promise<WorkspaceQueryResponse> {
  const locations = await vscode.commands.executeCommand<vscode.Location[]>(
    "vscode.executeReferenceProvider",
    vscode.Uri.parse(params.uri!),
    new vscode.Position(params.line!, params.character!),
  );
  return { locations: (locations ?? []).map(serializeLocation) };
}

// ── Definition ──

async function handleDefinition(
  params: WorkspaceQueryParams,
): Promise<WorkspaceQueryResponse> {
  const result = await vscode.commands.executeCommand<
    vscode.Location[] | vscode.LocationLink[]
  >(
    "vscode.executeDefinitionProvider",
    vscode.Uri.parse(params.uri!),
    new vscode.Position(params.line!, params.character!),
  );
  const locations = normalizeLocations(result);
  return { locations };
}

// ── Document Symbols ──

async function handleDocumentSymbols(
  params: WorkspaceQueryParams,
): Promise<WorkspaceQueryResponse> {
  const symbols = await vscode.commands.executeCommand<
    vscode.DocumentSymbol[]
  >("vscode.executeDocumentSymbolProvider", vscode.Uri.parse(params.uri!));
  return { symbols: (symbols ?? []).map(serializeDocumentSymbol) };
}

// ── Workspace Symbols ──

async function handleWorkspaceSymbols(
  params: WorkspaceQueryParams,
): Promise<WorkspaceQueryResponse> {
  const symbols = await vscode.commands.executeCommand<
    vscode.SymbolInformation[]
  >("vscode.executeWorkspaceSymbolProvider", params.query!);
  return {
    symbols: (symbols ?? []).map(
      (s): SymbolInfo => ({
        name: s.name,
        kind: vscode.SymbolKind[s.kind] ?? "unknown",
        uri: s.location.uri.toString(),
        range: serializeRange(s.location.range),
      }),
    ),
  };
}

// ── Hover ──

async function handleHover(
  params: WorkspaceQueryParams,
): Promise<WorkspaceQueryResponse> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    vscode.Uri.parse(params.uri!),
    new vscode.Position(params.line!, params.character!),
  );
  const contents = (hovers ?? [])
    .flatMap((h) => h.contents)
    .map((c) => {
      if (typeof c === "string") return c;
      if (c instanceof vscode.MarkdownString) return c.value;
      // MarkedString { language, value }
      return (c as { language: string; value: string }).value;
    })
    .join("\n\n");
  return { contents };
}

// ── Type Definition ──

async function handleTypeDefinition(
  params: WorkspaceQueryParams,
): Promise<WorkspaceQueryResponse> {
  const result = await vscode.commands.executeCommand<
    vscode.Location[] | vscode.LocationLink[]
  >(
    "vscode.executeTypeDefinitionProvider",
    vscode.Uri.parse(params.uri!),
    new vscode.Position(params.line!, params.character!),
  );
  const locations = normalizeLocations(result);
  return { locations };
}

// ── Serialization helpers ──

function serializeRange(range: vscode.Range): Range {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function serializeLocation(loc: vscode.Location): LocationInfo {
  return {
    uri: loc.uri.toString(),
    range: serializeRange(loc.range),
  };
}

function serializeDocumentSymbol(sym: vscode.DocumentSymbol): SymbolInfo {
  return {
    name: sym.name,
    kind: vscode.SymbolKind[sym.kind] ?? "unknown",
    range: serializeRange(sym.range),
    children:
      sym.children.length > 0
        ? sym.children.map(serializeDocumentSymbol)
        : undefined,
  };
}

function severityToString(
  severity: vscode.DiagnosticSeverity,
): "error" | "warning" | "info" | "hint" {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
  }
}

/**
 * Normalize the result of definition/typeDefinition providers which can return
 * either Location[] or LocationLink[].
 */
function normalizeLocations(
  result: vscode.Location[] | vscode.LocationLink[] | null | undefined,
): LocationInfo[] {
  if (!result) return [];
  return result.map((item) => {
    if ("uri" in item && "range" in item) {
      // vscode.Location
      return serializeLocation(item as vscode.Location);
    }
    // vscode.LocationLink
    const link = item as vscode.LocationLink;
    return {
      uri: link.targetUri.toString(),
      range: serializeRange(link.targetRange),
    };
  });
}
