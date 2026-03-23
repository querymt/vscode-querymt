# Changelog

All notable changes to the QueryMT VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.3] - 2026-03-23

### Added

- `Upgrade Agent` command (`querymt.upgradeAgent`) — checks for newer qmtcode
  releases on GitHub and upgrades the binary in-place with a progress
  notification, then restarts the agent automatically
- Automatic startup update check — 30 seconds after activation the extension
  queries the GitHub releases API and shows an unobtrusive notification when a
  newer version is available, with an "Upgrade Now" action button
- `querymt.checkForUpdates` setting (default `true`) to enable or disable the
  automatic startup check
- "Upgrade Agent" entry in the status bar menu and Manage Provider quickpick
- Binary source tracking (`BinarySource`) in `AcpClient` — the extension now
  knows whether qmtcode was resolved from a user setting, bundled binary, PATH,
  or a managed download, and tailors the upgrade flow accordingly
- When the binary comes from PATH, the extension bundle, or a custom setting,
  the upgrade command offers to download a managed copy that the extension will
  use going forward, rather than silently failing
- `readBinaryMetadata()` and `checkForUpdate()` exports in `binary-manager` for
  programmatic version comparison using semver

### Dependencies

- Added `semver` for robust version comparison (handles pre-release and nightly
  tags)

## [0.2.2] - 2026-03-23

### Added

- `Set Session Mode` command (`querymt.setMode`) and `/mode` slash command —
  change the agent mode (e.g. code, plan, architect) for the active chat session
  via QuickPick or inline in chat
- `Set Reasoning Effort` command (`querymt.setReasoningEffort`) and `/effort`
  slash command (aliases: `/reasoning`, `/reasoning-effort`) — adjust reasoning
  effort for the active session
- `Update Plugins` command (`querymt.updatePlugins`) — force-update all OCI
  provider plugins with a progress notification and per-plugin result summary
- Session config options (`configOptions`) fetched from `newSession` and
  `loadSession` responses and cached per session; kept in sync via
  `config_option_update` session events
- Chat participant declares `mode` and `effort` slash commands in `package.json`
- `Set Mode`, `Set Reasoning Effort`, and `Update Plugins` entries in the
  status bar menu and Manage Provider quickpick

### Changed

- `waitForRedirectCompletion` returns a typed result
  (`"connected" | "cancelled" | "timed_out"`) instead of `void`, enabling
  fallback to manual callback-URL/code paste on cancellation or timeout
- `promptAndCompleteDeviceFlow` renamed to `promptAndCompleteOAuthFlow` and now
  accepts a callback URL in addition to a plain authorization code
- `AcpClient.loadSession` return type tightened from `unknown` to
  `LoadSessionResponse`

## [0.2.1] - 2026-03-20

### Added

- OAuth sign-in support for Anthropic, Google, Codex, and Kimi providers --
  new commands `Sign In to Provider`, `Sign Out of Provider`, and
  `Show Auth Status` accessible from command palette, status bar menu, and
  Manage Provider quickpick
- Authentication section in README with API key examples, OAuth quickstart,
  full provider reference link, and troubleshooting guide
- Redirect-based OAuth flows (Anthropic, Codex) now complete automatically
  via the agent's callback server with a cancellable progress notification
- Device-code OAuth flows prompt immediately for code paste
- Rich QuickPick for auth status display with per-provider icons, descriptions,
  and contextual sign-in/sign-out actions

### Fixed

- `extMethod` responses that return `null` (e.g. unsupported agent build or
  protocol mismatch) no longer crash with `Cannot read properties of null` --
  all auth parsers now accept `unknown` and degrade gracefully
- `AcpClient.extMethod` return type narrowed from `Record<string, unknown>` to
  `unknown` to prevent unsafe property access on null/undefined responses

## [0.2.0] - 2026-03-19

### Added

- Model selection integration — the active VS Code language model is forwarded to
  the agent session via `setModel`, and tracked per session so switching models
  between requests works correctly
- `Refresh Models` command (`querymt.refreshModels`) to re-fetch available models
  from all providers, accessible from the command palette and the status bar menu
- Batch model metadata fetching via `_querymt/modelInfo` — the model picker now
  shows accurate token limits, capabilities, pricing, and modalities
- Duplicate model label disambiguation — models from different providers with the
  same base name are suffixed with the provider name in the picker
- Prompt blocks with references — chat requests now send structured `ContentBlock[]`
  including attached files, selections, and URIs instead of plain text
- Followup suggestions powered by agent-reported available commands
- User feedback forwarding — thumbs up/down is sent to the agent as a
  `_querymt/feedback` notification
- Status bar token usage display showing live `used/total` token counts and
  optional cost information from `usage_update` events
- Automatic download of the `qmtcode` binary from GitHub releases when no local
  binary is found, with progress notification
- `querymt.autoDownload` setting to enable/disable automatic binary downloads
- `querymt.channel` setting to choose between `stable` and `nightly` release
  channels
- New `binary-manager` module handling platform detection, release resolution,
  download, and extraction

### Changed

- Renamed agent binary from `coder_agent` to `qmtcode` throughout
- Binary discovery expanded to a 5-step priority chain: user setting, bundled
  binary, PATH lookup, previously downloaded binary, auto-download
- Error responses now return structured `errorDetails` metadata instead of
  returning void
- Elicitation method renamed from `querymt/elicit` to `_querymt/elicit`
- Improved error messages with `qmtcode` install instructions

## [0.1.1] - 2026-03-17

### Changed

- Improved user-facing setting descriptions and documentation

## [0.1.0] - 2026-03-13

### Added

- Initial release
- AI chat participant (`@querymt`) powered by the Agent Client Protocol
- Language model provider integration for Anthropic, OpenAI, llama.cpp, and Ollama
- Automatic agent lifecycle management with configurable restart limits
- Status bar indicator showing agent connection state
- Commands: Restart Agent, Show Agent Logs, Agent Status, Manage Provider
- Configurable binary path, default provider/model, and TOML config file support
