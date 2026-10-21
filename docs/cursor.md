# Cursor installation and sign-in

Cursor uses the same local stdio MCP server, generation APIs, quotes, saved task records, browser sign-in, and media preview tools as Codex. This integration targets a local Cursor Agent. Remote SSH sessions, containers, and cloud agents require separate integration and acceptance testing.

## Installation

Requires Node.js >= 22.18 and Cursor. The Codex CLI is not required. Run from this repository's root; use `npm.cmd` in PowerShell:

```powershell
npm.cmd ci
npm.cmd run install:cursor
```

Production endpoints are built in. No `.env`, hostname, or copied token is required. The installer checks an independent MCP process for a protocol handshake, 35 tools, and credential-refresh status before changing Cursor configuration. This is not proof that the current chat has loaded those tools or that the backend account is valid.

The default installation merges `mcpServers.topmediai` into `~/.cursor/mcp.json` and installs the shared instructions at `~/.cursor/skills/topmediai-mcp/SKILL.md`. Other servers and top-level settings are preserved. On Windows, `~` is normally `%USERPROFILE%`.

For a project-only installation:

```powershell
npm.cmd run install:cursor -- --project './my-project'
```

This writes to that project's `.cursor/` without changing global settings. A project entry with the same server name takes precedence over a global entry; inspect both locations when troubleshooting. Generated launch commands use absolute paths to the local Node executable and this repository's compiled entry point. Reinstall after moving the repository, changing Node paths, or switching computers. Do not distribute machine-specific configuration as a portable team setup.

Changed existing configuration and skill files are backed up under the corresponding `.cursor/backups/topmediai-mcp/<installation-id>/`. Backups may include other services' secrets and must remain private. Repeating an unchanged installation neither rewrites files nor creates backups. Invalid JSON, comments, trailing commas, or non-object configuration cause an error without overwriting existing files. Skill backups stay outside `skills/` so they are not discovered as duplicate instructions.

## Account connection

1. Enable `topmediai` in Cursor's MCP settings and call `get_service_status` in an Agent chat.
2. If needed, call `start_login`, verify the account on the official `/mcp/connect` page, and approve the connection. Keep calling `wait_for_login` with the same `login_id` until saved or a terminal outcome.
3. After saving, call `get_service_status` and `get_balance` in the same chat and resume the original request. Login and local logout do not require restarting Cursor or MCP.
4. Use the shared skill for model selection, exact quotes, budgets, and conversation-scoped confirmation preferences. If the Cursor version does not discover skills, provide the installed `SKILL.md` as chat context.

Credentials are stored in Windows Credential Manager, macOS Keychain, or Linux Secret Service, under service `com.topmediai.mcp` and account `production`. Linux requires desktop D-Bus and a Secret Service provider. Windows native storage has been tested with isolated synthetic credentials; complete macOS/Linux client flows still require acceptance testing. System-store errors never fall back to plaintext. Enter system passwords only in operating-system dialogs, never in chat.

After upgrading from JSON storage, reconnect the account. Old JSON credentials are not read, migrated, or automatically deleted. Their former directory now holds metadata-only login locks. Handle old secret files separately and exclude them from releases.

Codex and Cursor running as the same OS user share the production credential and task state for matching settings. Account switches or `npm.cmd run logout` affect both clients' next calls; in-flight requests keep their original credential. Confirmation preferences remain separate per conversation. System storage is not isolation from all other processes running as the same user.

If tools are missing, check enablement, refresh/reconnect the server, and try a new chat. Reload the window only for a demonstrated client-loading problem. Cursor still controls its own tool permissions and organization policies; plugin instructions do not disable them.

## Media and references

Existing MCP Apps tools provide image, audio, and video previews where supported by the host. If a Cursor version lacks support or a card fails, deliver original links without regenerating. Video and audio playback start only after a user click. Synchronous TTS/STS may take up to about 300 seconds; the client's waiting timeout must cover this. A timeout does not authorize resubmission.

Reference uploads require authorization for the specific files and a dedicated directory. Video/audio validation also requires local FFmpeg/FFprobe. Set public overrides before installing, then reconnect MCP:

```powershell
$env:TOPMEDIAI_UPLOAD_ROOT = 'C:\path\to\references'
npm.cmd run install:cursor
```

The installer freezes production configuration, clears token/legacy-gateway overrides, and copies no private credentials. It does not rewrite Codex's `plugin/.mcp.json`. Uploaded URLs may be publicly accessible; see [Data and privacy](privacy.md).

## Optional local Cursor plugin package

Generate a separate local configuration:

```powershell
npm.cmd run setup:cursor
```

For local plugin testing, place the contents of `plugin/.cursor-plugin/`, `plugin/.cursor-mcp.json`, `plugin/skills/`, and `plugin/assets/` in the corresponding locations under `~/.cursor/plugins/local/topmediai-mcp/`. Reload and inspect plugin components according to the client's local-plugin workflow. Use either this approach or MCP configuration installation to avoid duplicate servers. Availability depends on the Cursor version and organization policy; this does not mean the plugin is published on Cursor Marketplace.

The generated configuration references this machine's compiled entry point. Regenerate it on another machine. Rebuild/reconnect after code updates and reinstall or recopy after skill changes. Actual Cursor chat sign-in, live generation, player interaction, and fullscreen remain client acceptance checks.

The installer pins `MCP_CLIENT_SOURCE=7` for the business HTTP identity header without changing the request-body channel. See [Client identity](client-source.md).
