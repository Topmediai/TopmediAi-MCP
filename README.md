# TopMediAi-MCP

**English** · [日本語](docs/i18n/README.ja.md) · [한국어](docs/i18n/README.ko.md) · [Deutsch](docs/i18n/README.de.md) · [Français](docs/i18n/README.fr.md) · [Español](docs/i18n/README.es.md) · [Italiano](docs/i18n/README.it.md) · [繁體中文](docs/i18n/README.zh-TW.md)

A local TypeScript stdio MCP server and Codex plugin for TopMediai. Version **1.0.0** supports image generation, image-to-image, music, video, mixed-media reference video, text-to-speech (TTS), and speech-to-speech (STS). It includes model catalogs, cost estimates, budget validation, task recovery, and image/audio/video previews. Denoising, voice cloning, and music videos are not available.

Generation uses the signed-in account's entitlements. Query the model catalog and obtain an exact quote before submitting, then apply the user's budget and the current conversation's confirmation preferences. Uploading reference files requires permission for external storage; uploaded URLs may be publicly accessible. See [Data and privacy](docs/privacy.md).

## Installation and sign-in

Requires Node.js >= 22.18, the Codex CLI, and access to the official connection page. Browser sign-in currently supports a browser and MCP server running on the same Windows computer. Use `npm.cmd` in PowerShell; other supported shells can use `npm`.

Run from the project directory:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run install:codex
```

The plugin appears in Codex as `TopMediAi-MCP`, with installation identifier `topmediai-mcp@topmediai-local`.

Installation creates a local `plugin/.mcp.json` without storing tokens or cookies in the plugin. This file contains local executable paths and must not be committed or distributed. Reinstall after moving the project or switching computers.

Call `get_service_status` in the current chat. If sign-in is required, use `start_login`, verify the account on the official page, and approve the connection. Keep calling `wait_for_login` with the same `login_id` until credentials are saved or the session ends. After saving, call `get_service_status` and `get_balance` in the same chat and resume the original request. Restarting Codex or the MCP server is not required.

Fallback CLI commands:

```powershell
npm.cmd run login
npm.cmd run login:status
npm.cmd run logout
```

Sign-in waits for up to ten minutes. Private connection links are hidden by default. If the browser cannot open automatically, use `--show-private-link` locally. This link is for the local browser only; never share it, screenshot it, or paste it into chat.

The installation self-check only proves that a separate MCP process can start. It does not prove that the current chat has loaded its tools or that account credentials are valid. If tools are missing, check plugin enablement, refresh the plugin package, and reconnect MCP; start a new chat if needed. Never attribute another generator's output to TopMediai.

## Environment and configuration

The public installer, server, and CLI commands support **production only**, with built-in production website and API endpoints. New users do not need to create `.env`, select an environment, enter hostnames, or copy tokens. Optional overrides are documented in [.env.example](.env.example). See [Production installation and configuration](docs/production-switch.md).

- Production uses direct APIs by default. Service addresses must be valid HTTPS origins; explicitly empty required values are rejected. The legacy gateway is enabled only by an explicit `TOPMEDIAI_PRODUCTION_GATEWAY_HOST` and has limited capabilities.
- Installation reads shell configuration and freezes service addresses, environment, and upload settings. Set overrides before installation. See the example comments for direct startup and sign-in CLI behavior.
- Normal installations use private saved credentials. `TOPMEDIAI_TOKEN` is an explicit override and must never appear in public files, screenshots, or issue reports. Standard installation clears this override to avoid inheriting old credentials.
- On Windows, credentials are stored under `%LOCALAPPDATA%\TopMediai\credentials\` and revalidated before every tool call. Switching accounts selects the corresponding task directory; requests already in flight retain their original account.
- Generation and uploads need no extra feature switches. Uploads still require authorization for specific files and a dedicated directory. After changing endpoints, upload settings, or code, refresh the installed configuration and plugin package, then reconnect MCP.
- Local logout deletes saved credentials. It does not sign out the website, revoke server-side tokens, or cancel submitted tasks.

Refresh configuration with:

```powershell
npm.cmd run setup:plugin
```

After updating the plugin, verify `get_service_status.server_version`. Do not assume the entire application needs a restart.

## Tools and creative workflow

| Purpose | Main tools |
| --- | --- |
| Status and sign-in | `get_service_status`, `start_login`, `wait_for_login`, `cancel_login` |
| Account and plans | `get_balance`, `review_generation_plan` |
| Images | `list_image_models`, `estimate_image_cost`, `generate_image`, `get_image_task` |
| Image references and previews | `upload_reference_image`, `preview_image_task` |
| Music | `list_music_models`, `estimate_music_cost`, `generate_music` |
| Video | `list_video_models`, `estimate_video_cost`, `generate_video`, `upload_reference_media`, `preview_video_task` |
| Speech | `list_voices`, `get_voice_detail`, `list_tts_models`, `list_sts_models`, `get_speech_entitlements`, `upload_speech_audio`, `estimate_tts_cost`, `generate_tts`, `estimate_sts_cost`, `generate_sts` |
| Multimedia status and playback | `get_generation_capabilities`, `get_generation_task`, `preview_audio_task` |

The actual loaded tool list is authoritative. When no model is specified, use the default returned by the current catalog; do not switch models based on price or style. Read parameters, reference limits, voice languages, and capabilities from that catalog. A listed model is not proof that quoting or generation is available.

Obtain a valid quote before submitting with a stable `request_id` and an explicit budget. `review_generation_plan` summarizes quotes for the current flow. By default, confirmation is required for designated high-price models or an estimated flow total strictly above 1000 credits. Explicit user preferences take precedence. Reassess expired quotes, changed inputs, or higher prices. The tool does not replace user consent, and a local budget is not a server-enforced spending cap.

Timeouts, cancellations, disconnects, and unknown submission outcomes do not prove that generation or billing did not occur. Preserve the original task identifiers, check the account's history, and never automatically regenerate. If an account or configuration change hides an old task, check its history first.

Prefer image previews after completion. For expired image links, query the original task with `get_image_task({request_id, refresh_result:true})`; link renewal is not guaranteed. Deliver audio through a player or named links and video through an inline player with named original links. Distinguish preview failures from generation failures, and deliver successful artifacts even when other stages fail.

## Video preview

When video completes, call `preview_video_task` with the original `task_handle` to show a read-only inline player and include named original video links. The player supports click-to-play, pause, seeking, volume, fullscreen, and retry. Show successful versions for partial results without reopening unchanged cards.

Preview reads saved account-scoped results without backend polling, local media downloads, generation, spending, or stored-task changes. It loads media only from approved production video CDN origins without account credentials. Unsupported UI, formats, or playback failures retain original links and never justify regeneration. Browser navigation, screenshots, and downloads require explicit user requests.

Refresh the plugin package and reconnect MCP after updating. Verify `server_version=1.0.0`, 35 tools, and `preview_video_task`. Card display and fullscreen depend on host support.

## Uploading reference media

No extra upload switch is required. Select only user-authorized files from a dedicated directory; never broaden access to personal or credential directories. For example:

```powershell
$env:TOPMEDIAI_UPLOAD_ROOT = 'C:\path\to\upload-inputs'
npm.cmd run setup:plugin
```

Create the directory and place authorized files there, then refresh plugin configuration and reconnect MCP.

- **Images:** PNG/JPEG, up to 5 MiB. Use the returned `reference_image_id`; never guess IDs or reuse them across accounts. See [Image uploads and references](docs/image-to-image-security.md).
- **Video references:** MP4/WAV/MP3. Requires the dedicated directory and local FFmpeg/FFprobe. Read count, size, duration, and combination limits from the operation's model catalog. Uploaded IDs and ordering are bound to the quote.
- **STS source audio:** MP3/WAV/AAC/FLAC/AIFF/OGG, up to 50 MiB and 300 seconds. Requires the dedicated directory and local FFmpeg/FFprobe. See [TTS and STS guide](docs/speech-integration.md).

Local validation and metadata removal do not make cloud files private. Upload URLs, result links, and full local reports must not be copied directly into public issue reports.

## Local diagnostics and shared reports

```powershell
# Read-only queries; does not submit generation
npm.cmd run diagnose
# Also create a redacted copy for sharing
npm.cmd run diagnose -- --share-report
```

Console output contains a summary by default. The full report at `.data/diagnostic-runs/latest-production.json` is private. The shared copy at `.data/diagnostic-runs/shared-production.json` hides account identifiers, prompts, cost amounts, media URLs, private links, and local paths. Inspect the shared copy before sharing; renaming the full report does not redact it.

Normal MCP results still provide real balances and usable result links. Diagnostic redaction applies only to shared reports and console summaries.

## Development and release checks

```powershell
npm.cmd test
npm.cmd run check:public
npm.cmd run check:public -- --build
npm.cmd run prepare:public
```

`prepare:public` creates an independent public snapshot from reviewed files and initializes a local Git repository without inheriting the original history. Publish only a snapshot that passes checks. Editing current files does not remove earlier history. See [Public release checks](docs/releasing.md).

## License

Original project code is licensed under the [MIT License](LICENSE), copyright TopMediai. Third-party code and dependencies retain their respective licenses and copyright notices.

The source license does not grant free use of TopMediai cloud services. Sign-in, generation, uploads, and other services remain subject to applicable account entitlements, pricing, and service terms. The TopMediai name, trademarks, and brand icon are excluded from this project's MIT grant and require appropriate authorization for use.
