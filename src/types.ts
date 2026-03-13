/**
 * Shared TypeScript types for the QueryMT VS Code extension.
 */

// ── Workspace Query (agent → client reverse RPC) ──

export interface WorkspaceQueryParams {
  action:
    | "diagnostics"
    | "references"
    | "definition"
    | "document_symbols"
    | "workspace_symbols"
    | "hover"
    | "type_definition";
  /** file:// URI, required for most actions */
  uri?: string;
  /** 0-based line number */
  line?: number;
  /** 0-based character offset */
  character?: number;
  /** Search string, required for workspace_symbols */
  query?: string;
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface LocationInfo {
  uri: string;
  range: Range;
}

export interface DiagnosticInfo {
  uri: string;
  range: Range;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  code?: string | number;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  range: Range;
  uri?: string;
  children?: SymbolInfo[];
}

// Possible response shapes from workspace query
export interface DiagnosticsResponse {
  diagnostics: DiagnosticInfo[];
}

export interface LocationsResponse {
  locations: LocationInfo[];
}

export interface SymbolsResponse {
  symbols: SymbolInfo[];
}

export interface HoverResponse {
  contents: string;
}

export type WorkspaceQueryResponse =
  | DiagnosticsResponse
  | LocationsResponse
  | SymbolsResponse
  | HoverResponse;
