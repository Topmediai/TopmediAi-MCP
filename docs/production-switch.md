# Production installation and configuration

The public release supports production only and includes production website, membership, and generation endpoints. New installations do not require `.env`, custom hostnames, or copied tokens.

## Installation and sign-in

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run install:codex
```

Call `get_service_status` in the current chat. If sign-in is required, call `start_login`, verify the account on the official page, and approve the connection. Keep calling `wait_for_login` with the same `login_id` until credentials are saved or the session ends. After saving, check status and balance, then continue the original request.

The fallback command is `npm.cmd run login`. `npm.cmd run login:status` only checks locally saved credentials. `npm.cmd run logout` clears them locally; it does not sign out the website or revoke server-side tokens.

## Updating configuration

See `.env.example` for optional settings. Uploading requires authorization for the specific media and a dedicated local directory. For custom settings, set the relevant PowerShell environment variables, then run:

```powershell
npm.cmd run setup:plugin
```

Refresh the plugin package, reconnect MCP, and verify `get_service_status.server_version`. Installed configuration contains local paths and must not be committed or distributed. Credentials, media, task records, and logs must remain outside release files.

Changing service addresses or accounts may select a different local task directory. Preserve original records and check the original task or official history for unknown submissions; do not automatically resubmit. The limited legacy gateway is enabled only by an explicit `TOPMEDIAI_PRODUCTION_GATEWAY_HOST`.

Local self-checks and mocked tests do not prove that real sign-in, generation, or billing has passed deployment acceptance. Live generation still requires a quote and compliance with user budgets and the current conversation's confirmation preferences.
