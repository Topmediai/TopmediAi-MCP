# Data and privacy

This plugin runs locally and uses TopMediai services to sign in, query entitlements, and submit generation. Generation sends the current inputs and required media to the service. Verify the account, environment, costs, and upload authorization before use.

## Credentials and local records

Credentials are saved by environment in a private local directory, outside plugin installation files. Default sign-in output omits account email addresses and private connection links. The `--show-private-link` option explicitly reveals a private link locally and must not be used in public logs.

Local task records and full diagnostic reports may contain account identifiers, user inputs, costs, task states, and result URLs. Never commit or distribute `.env`, `.data/`, logs, or the local `plugin/.mcp.json`. Deleting local records does not cancel remote tasks, revoke credentials, or delete cloud results.

## Uploads and result URLs

Image and audiovisual references, including STS source audio, require separate upload permission and a dedicated directory. Upload URLs may be publicly accessible. Local media IDs, account isolation, and quote validation do not change cloud object permissions.

Images, video, and audio are validated locally and have metadata removed. These measures cannot guarantee that the content itself is free of private information. Do not upload credential files, sensitive footage, personal information, or unauthorized voices.

Result and reference URLs may contain signatures or other access parameters. Verify their access scope and content before publicly sharing links, screenshots, or full reports. The plugin does not guarantee cloud retention periods, URL renewal, or automatic deletion.

## Shared diagnostics

`npm run diagnose -- --share-report` produces a separate redacted report. An explicit field allowlist hides credentials, emails, user text, cost amounts, media references, private links, and local paths. Tasks and accounts use consistent aliases within the report. Unrecognized fields are not passed through directly.

Normal MCP results still contain usable balances, task details, and result URLs; they are not redacted public reports. Share only an inspected diagnostic copy, and review manually written additions and screenshots separately.
