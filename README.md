# Synapse

Synapse is an extensible desktop coding agent built with Electron, React, and TypeScript. It combines workspace-aware conversations, model-aware context management, reviewable file changes, built-in tools, and optional MCP extensions in one local application.

> Status: pre-release. The repository is under active end-to-end validation and is not yet a stable production release.

## What is included

- Conversation-scoped agent runs, task boundaries, queueing, interruption, retry, Fork, and Withdraw flows.
- Model catalogs with provider-specific context windows, reasoning levels, speed tiers, multimodal capabilities, and request usage tracking.
- Background Prompt Compression (BPC) and hard compaction with per-conversation state and recovery.
- Built-in workspace search, file reading and editing, patch application, command execution, memory, web reading, and web search.
- Aggregated Diff review with file, hunk, and inline-block acceptance or rejection.
- Markdown, PDF, Word, PowerPoint, spreadsheet, code, and image viewing inside the desktop workspace.
- Optional external MCP servers. Core coding flows do not require an external MCP process.

## Requirements

- Windows 10 or Windows 11
- Node.js 22 or newer
- npm 10 or newer

## Development

```powershell
npm install
npm run electron:dev
```

To verify a cold start without external MCP auto-start:

```powershell
$env:SYNAPSE_DISABLE_EXTERNAL_MCP = '1'
npm run electron:dev
```

Web-only development is available with `npm run dev`. Electron is required for secure credential storage, local file access, background tasks, and native Provider integrations.

## Build

```powershell
npm run build
npm run electron:build
npm run electron:pack
```

`electron:pack` regenerates the application icon, builds the renderer and main process, and produces the Windows installer under `release/`.

## Verification

The `scripts/` directory contains focused integration checks for BPC generation, scheduler isolation, Diff review, history truncation, Provider runtime behavior, OAuth state, request retry, model capabilities, built-in tools, and secret boundaries. Run the scripts relevant to a change before relying on a UI-only result.

Examples:

```powershell
npm run test:bpc
npm run test:diff-review
npm run test:provider-runtime
npm run test:ai-client-retry
npm run test:secret-boundary
```

The `test:openai-codex-live` and `test:windsurf-live` commands are opt-in maintainer diagnostics. They use credentials that are already authorized in the operating system's secure storage, make real Provider requests, and may consume account quota. They are not part of the default build or anonymous source-review path and refuse to run unless `SYNAPSE_ALLOW_LIVE_PROVIDER_TESTS=1` is explicitly set; never place credentials in the repository, command arguments, screenshots, or test reports.

## Anonymous source handoff

The anonymous handoff must use a separate Git repository with the neutral local identity `Synapse Project` and a GitHub noreply email. The exporter refuses a dirty source worktree, copies only Git-tracked files from the public allowlist into a sibling staging directory, audits the staged repository, and transactionally replaces the target only after the source and target manifests match.

```powershell
git status --short
npm run submission:export -- --target C:\path\to\separate-anonymous-repository --replace
npm run submission:audit -- C:\path\to\separate-anonymous-repository
```

The audit target is mandatory. It checks the current file manifest, private-path and secret markers, media metadata, Git remotes, refs, commit identities, messages, historical paths, and historical text blobs. Build the installer from the audited anonymous repository rather than copying an existing `release/` directory.

## Final ZIP delivery

Create the final delivery ZIP from the audited anonymous repository, not from a runtime worktree. The final package includes anonymous source files, `README.txt`, the demonstration video, `THIRD_PARTY_NOTICES.md`, `LICENSE`, and `FINAL_DELIVERY_MANIFEST.json`; it must not include installers, credentials, profiles, `node_modules`, build output, release output, or private absolute paths.

```powershell
npm run submission:final-export -- C:\path\to\final-delivery --from C:\path\to\separate-anonymous-repository --readme C:\path\to\README.txt --video C:\path\to\demo.mp4 --replace
npm run submission:final-audit -- C:\path\to\final-delivery.zip
```

`submission:final-export` writes `FINAL_DELIVERY_MANIFEST.json`, audits every normalized relative path, byte size, SHA256, README supplement, and video supplement, then writes a deterministic ZIP beside the directory as `<final-delivery>.zip` unless `--zip <file.zip>` is supplied. The command prints the final ZIP SHA256 and verifies the ZIP again after extracting it to a temporary directory.

## Security and privacy

- API keys and OAuth credentials are stored by the Electron main process through the operating system's secure storage.
- Renderer state and exported settings contain credential metadata only, not reusable secrets.
- External MCP servers are optional and may be disabled for isolated startup.
- Real accounts, cookies, local paths, conversation databases, and private logs must not be committed.

## License

Synapse source code is released under the MIT License. Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
