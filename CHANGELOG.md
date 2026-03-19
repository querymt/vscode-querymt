# Changelog

All notable changes to the QueryMT VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
