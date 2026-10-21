# Production installation and configuration

The public release supports production only and includes production website, membership, and generation endpoints. New installations do not require `.env`, custom hostnames, or copied tokens.

## Installation and sign-in

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run install:codex
```

Call `get_service_status` in the current chat. If sign-in is required, call `start_login`, verify the account on the official page, and approve the connection. Keep calling `wait_for_login` with the same `login_id` until credentials are saved or the session ends. After saving, check status and balance, then continue the original request.

The fallback command is `npm.cmd run login`. `npm.cmd run login:status` reads the system credential store but does not validate the token against the backend. `npm.cmd run logout` deletes the saved credential and checks its removal; it does not sign out the website, revoke server-side tokens, or cancel tasks. Unconfirmed storage changes are reported as errors rather than success.

Cursor uses `npm.cmd run install:cursor` and does not require the Codex CLI. See the [Cursor guide](cursor.md) for global/project installation and backups.

## System credential storage and upgrades

Credentials use Windows Credential Manager, macOS Keychain, or Linux Secret Service, under service `com.topmediai.mcp` and account `production`. Each tool call reloads the saved credential. Once loaded, status reports `credential_source=system-store` and `credential_storage` names the store. Explicit `TOPMEDIAI_TOKEN` overrides still take precedence.

When upgrading from JSON credential files, reconnect the account. Old files are not read, migrated, or deleted automatically; the old directory now holds login-lock metadata only. Preserve task records and handle legacy secret files separately. Never copy credentials into plugin configuration or public release files.

Linux requires desktop D-Bus and a Secret Service provider. Locked, denied, missing, or timed-out stores do not fall back to plaintext. Resolve the system dialog/service issue, then check status or retry confirmation on the existing waiting login page. A terminal login outcome requires checking saved status before starting a new session. Never enter system passwords in chat.

Windows native storage has passed an isolated synthetic roundtrip. Full macOS/Linux client workflows remain unverified. Browser and MCP must run on the same computer; remote/container/cloud hosts require separate integration. Codex and Cursor under the same OS user share the production credential, so account changes affect subsequent calls in both clients without restarting them.

## Updating configuration

See `.env.example` for optional settings. Uploading requires authorization for the specific media and a dedicated local directory. For custom settings, set the relevant PowerShell environment variables, then run:

```powershell
npm.cmd run setup:plugin
```

Refresh the plugin package, reconnect MCP, and verify `get_service_status.server_version`. Installed configuration contains local paths and must not be committed or distributed. Credentials, media, task records, and logs must remain outside release files.

Configure `MCP_CLIENT_SOURCE` per client launch, not in a shared `.env`: Codex uses `5`, Claude Code `6`, Cursor `7`, and unknown clients omit the outbound identity header. Installers set their respective values; generic `setup:plugin` preserves an explicit value and otherwise writes an empty override. The original `TOPMEDIAI_SOURCE` payload channel is unchanged. See [Client identity](client-source.md).

Changing service addresses or accounts may select a different local task directory. Preserve original records and check the original task or official history for unknown submissions; do not automatically resubmit. The limited legacy gateway is enabled only by an explicit `TOPMEDIAI_PRODUCTION_GATEWAY_HOST`.

Local self-checks and mocked tests do not prove that real sign-in, generation, or billing has passed deployment acceptance. Live generation still requires a quote and compliance with user budgets and the current conversation's confirmation preferences.
