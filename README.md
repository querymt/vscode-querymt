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

## Authentication

The extension supports two authentication methods: **API keys** (environment variables or config file) and **OAuth** (browser-based sign-in for supported providers).

### API Key Setup

Set the appropriate environment variable for your provider before launching VS Code:

macOS / Linux:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
```

Windows PowerShell:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
$env:OPENAI_API_KEY = "sk-..."
```

You can also set keys in a TOML config file (see `querymt.configFile` setting):

```toml
[agent]
provider = "anthropic"
model = "claude-sonnet-4-20250514"
api_key = "${ANTHROPIC_API_KEY}"
```

Common provider environment variables:

| Provider | Environment Variable |
|----------|---------------------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Codex | `CODEX_API_KEY` |

### OAuth Sign-In

The following providers support OAuth-based authentication directly from VS Code:

- **Anthropic** -- Claude models via Anthropic Max
- **Google** -- Gemini models
- **Codex** -- Codex models
- **Kimi** -- Kimi models (`kimi-oauth`)

To sign in:

1. Run **QueryMT: Sign In to Provider** from the command palette (or status bar menu)
2. Select a provider from the list
3. Your browser opens the authorization page
4. After authorizing, the extension detects completion automatically (redirect-based providers) or prompts you to paste a code (device-based providers)

Credentials are stored securely by the agent in the system keyring -- the extension never stores tokens itself.

To check status or sign out, use **QueryMT: Show Auth Status** or **QueryMT: Sign Out of Provider**.

### Full Provider Reference

For the complete list of supported providers, authentication methods, and model configuration options, see the [Available Providers](https://docs.query.mt/latest/core/available-providers) documentation.

### Auth Troubleshooting

**"No auth-enabled providers found"**
The agent has no configured providers that support OAuth. Ensure your agent config includes at least one OAuth-capable provider (anthropic, google, kimi-oauth, codex). Restart the agent after changing configuration.

**API key not recognized**
- Verify the environment variable is set in the shell that launched VS Code (run `echo $ANTHROPIC_API_KEY` or equivalent).
- If using a TOML config file, check that `querymt.configFile` points to the correct path.
- VS Code may need to be restarted after setting environment variables.

**OAuth token expired**
Run **QueryMT: Sign In to Provider** again. The agent will refresh or re-authenticate as needed.

**Sign-in times out**
The extension polls for up to 2 minutes after opening the browser. If the authorization page takes longer, run **QueryMT: Show Auth Status** to check the current state, then retry sign-in.

**Provider/model mismatch**
Ensure `querymt.defaultProvider` and `querymt.defaultModel` correspond to a valid combination. For example, `anthropic` with `claude-sonnet-4-20250514`, not `openai` with a Claude model.

**Agent not connected**
All auth commands require a running agent. Check the status bar indicator, and run **QueryMT: Restart Agent** or **QueryMT: Show Agent Logs** to diagnose.

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
- **QueryMT: Sign In to Provider** -- Start OAuth sign-in for supported providers
- **QueryMT: Sign Out of Provider** -- Remove OAuth credentials
- **QueryMT: Show Auth Status** -- View authentication state for all providers
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
