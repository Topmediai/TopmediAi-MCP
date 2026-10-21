# Data and privacy

This plugin runs locally and uses TopMediai services to sign in, query entitlements, and submit generation. Generation sends the current inputs and required media to the service. Verify the account, environment, costs, and upload authorization before use.

## Credentials and local records

Credentials are saved in the operating system's credential store, outside plugin installation files: Windows Credential Manager, macOS Keychain, or Linux Secret Service. The service name is `com.topmediai.mcp`, with the `production` account slot. Credentials are reread before each tool call; a loaded saved credential reports `credential_source=system-store`. Default sign-in output omits account email addresses and private connection links. The `--show-private-link` option explicitly reveals a private link locally and must not be used in public logs.

There is no plaintext-file fallback. Linux requires a desktop D-Bus session and Secret Service. If the store is locked, denied, unavailable, or times out, follow the operating system's access instructions. Enter the computer password only in a system dialog, never in chat. Saving and deleting credentials are verified; an unconfirmed result is not success. Local logout does not revoke server-side tokens, and an explicit `TOPMEDIAI_TOKEN` override can still take precedence.

After upgrading from JSON storage, reconnect the account. Old credential files are not read, migrated, or automatically deleted. The former credential directory is used only for login locks containing metadata without tokens. Users must handle legacy secret files separately; never include them in source archives, logs, or public attachments.

Codex and Cursor running under the same OS user share the production credential. Logging out or switching accounts affects their next calls; in-flight requests keep their original credentials. Cost-confirmation preferences remain scoped to each chat. System credential storage does not isolate every process running under the same user account.

Windows native storage was tested with synthetic credentials under an isolated random service name. Complete macOS/Linux client flows and operating-system permission dialogs still require platform-specific acceptance testing.

Local task records and full diagnostic reports may contain account identifiers, user inputs, costs, task states, and result URLs. Never commit or distribute `.env`, `.data/`, logs, local `plugin/.mcp.json`, `plugin/.cursor-mcp.json`, or generated `.cursor/` files. Cursor configuration backups may also contain secrets from unrelated MCP services and must remain private. Deleting local records does not cancel remote tasks, revoke credentials, or delete cloud results.

## Uploads and result URLs

Image and audiovisual references, including STS source audio, require separate upload permission and a dedicated directory. Upload URLs may be publicly accessible. Local media IDs, account isolation, and quote validation do not change cloud object permissions.

Images, video, and audio are validated locally and have metadata removed. These measures cannot guarantee that the content itself is free of private information. Do not upload credential files, sensitive footage, personal information, or unauthorized voices.

Result and reference URLs may contain signatures or other access parameters. Verify their access scope and content before publicly sharing links, screenshots, or full reports. The plugin does not guarantee cloud retention periods, URL renewal, or automatic deletion.

## Shared diagnostics

`npm run diagnose -- --share-report` produces a separate redacted report. An explicit field allowlist hides credentials, emails, user text, cost amounts, media references, private links, and local paths. Tasks and accounts use consistent aliases within the report. Unrecognized fields are not passed through directly.

Normal MCP results still contain usable balances, task details, and result URLs; they are not redacted public reports. Share only an inspected diagnostic copy, and review manually written additions and screenshots separately.
