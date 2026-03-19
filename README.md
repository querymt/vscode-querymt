# QueryMT for VS Code

AI coding agent powered by QueryMT, integrated directly into VS Code's chat panel.

For detailed documentation on the agent, including configuration and usage, see the [QueryMT Agent Documentation](https://docs.query.mt/latest/agent/).

## Features

### Chat Participant (`@querymt`)

Type `@querymt` in the VS Code chat panel to interact with the QueryMT agent. It can:

- Answer questions about your codebase
- Write and edit code across files
- Run shell commands
- Analyze build errors and fix them
- Use VS Code language intelligence (diagnostics, references, definitions, symbols)

### Language Model Provider

QueryMT exposes its configured LLM providers (Anthropic, OpenAI, local llama.cpp, Ollama) in VS Code's model picker. Other extensions can use these models through the standard VS Code Language Model API.

### Workspace Intelligence

The agent has access to VS Code's language server features:

- **Diagnostics** -- see errors and warnings from all language servers
- **Go to Definition** -- navigate to symbol definitions
- **Find References** -- find all usages of a symbol
- **Document Symbols** -- list all symbols in a file
- **Workspace Symbols** -- search symbols across the project
- **Hover** -- get type information and documentation
- **Type Definition** -- navigate to type definitions

## Requirements

- VS Code 1.99.0 or later
- Network access on first run if `qmtcode` needs to be auto-downloaded

## Setup

1. Install the extension
2. Open a workspace folder
3. The extension starts the agent automatically (configurable via `querymt.autoStart`)
4. If `qmtcode` is missing, the extension auto-downloads the correct binary for your platform
5. Type `@querymt` in the chat panel to begin

## Manual Installation (optional)

If you prefer to manage binaries yourself, install `qmt` and `qmtcode` manually:

macOS / Linux:

```bash
curl -sSf https://query.mt/install.sh | sh
```

Nightly channel:

```bash
curl -sSf https://query.mt/install.sh | sh -s -- --nightly
```

Windows PowerShell:

```powershell
irm https://query.mt/install.ps1 | iex
```

Windows nightly channel:

```powershell
$env:QMT_CHANNEL='nightly'; irm https://query.mt/install.ps1 | iex
```

You can also set `querymt.binaryPath` to point to a specific binary.

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `querymt.binaryPath` | `""` | Absolute path to `qmtcode`. If empty, extension auto-discovers and can auto-download. |
| `querymt.defaultProvider` | `"anthropic"` | Default LLM provider (`anthropic`, `openai`, `llama_cpp`, `ollama`) |
| `querymt.defaultModel` | `"claude-sonnet-4-20250514"` | Default model identifier |
| `querymt.configFile` | `""` | Path to a QueryMT agent TOML config file |
| `querymt.autoStart` | `true` | Automatically start the agent when a workspace is opened |
| `querymt.maxRestarts` | `5` | Maximum automatic restart attempts after agent crashes |
| `querymt.autoDownload` | `true` | Automatically download `qmtcode` when not found locally |
| `querymt.channel` | `"stable"` | Release channel for auto-download (`stable` or `nightly`) |

## Commands

- **QueryMT: Restart Agent** -- Restart the agent process
- **QueryMT: Show Agent Logs** -- Open the output channel with agent logs
- **QueryMT: Manage Provider** -- Configure provider settings
- **QueryMT: Agent Status** -- Quick actions from the status bar

## Status Bar

The status bar shows the current agent connection state:

- `$(check) QueryMT` -- Connected and ready
- `$(sync~spin) QueryMT` -- Connecting...
- `$(circle-slash) QueryMT` -- Disconnected
- `$(error) QueryMT` -- Error (click for recovery options)

Click the status bar item for quick access to restart, logs, and settings.

## Architecture

The extension communicates with the `qmtcode` binary over stdio using the [Agent Client Protocol (ACP)](https://agentclientprotocol.com). The agent runs as a child process and exchanges JSON-RPC messages for session management, prompt processing, and tool execution.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run watch

# Type check
npm run lint

# Package VSIX
npm run package
```
