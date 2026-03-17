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
- The `coder_agent` binary installed and available on your PATH, or configured via settings

## Downloading the Agent Binary

The `coder_agent` binary can be downloaded from the latest release or from nightly builds:

- [Latest release](https://github.com/querymt/querymt/releases/latest)
- [Nightly builds](https://nightly.link/querymt/querymt/workflows/nightly/main?preview)

Download the artifact matching your operating system and architecture. After downloading, make the binary executable (macOS/Linux):

```bash
chmod +x coder_agent
```

### macOS Silicon releases

macOS Silicon users who download the `coder_agent` release binary need to clear the quarantine flag before running it:

```bash
xattr -dr com.apple.quarantine coder_agent
```

Once ready, either place the binary on your PATH or set the `querymt.binaryPath` setting to point to it.

## Setup

1. Install the extension
2. Ensure `coder_agent` is available:
   - Place it on your system PATH, or
   - Set `querymt.binaryPath` in VS Code settings
3. Open a workspace folder
4. The agent starts automatically (configurable via `querymt.autoStart`)
5. Type `@querymt` in the chat panel to begin

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `querymt.binaryPath` | `""` | Absolute path to `coder_agent`. If empty, searches bundled binary then PATH. |
| `querymt.defaultProvider` | `"anthropic"` | Default LLM provider (`anthropic`, `openai`, `llama_cpp`, `ollama`) |
| `querymt.defaultModel` | `"claude-sonnet-4-20250514"` | Default model identifier |
| `querymt.configFile` | `""` | Path to a QueryMT agent TOML config file |
| `querymt.autoStart` | `true` | Automatically start the agent when a workspace is opened |
| `querymt.maxRestarts` | `5` | Maximum automatic restart attempts after agent crashes |

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

The extension communicates with the `coder_agent` binary over stdio using the [Agent Client Protocol (ACP)](https://agentclientprotocol.com). The agent runs as a child process and exchanges JSON-RPC messages for session management, prompt processing, and tool execution.

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
