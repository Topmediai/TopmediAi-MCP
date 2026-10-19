# TTS and STS guide

TTS synthesizes speech from text. STS converts authorized source audio to a selected voice. Both wait synchronously and return audio on success; subsequent `get_generation_task` calls read local records.

## TTS

Call `list_tts_models`, `list_voices({operation:"tts"})`, `get_voice_detail`, `estimate_tts_cost`, and `generate_tts` in order. Use voices, languages, and parameters returned by the catalog.

TTS estimates billing locally, accounting for Unicode, line breaks, HTML entities, SSML, and account/voice entitlements. Final settlement is performed by the generation service. A quote does not establish membership eligibility or actual charges. Do not use previews to bypass full-generation restrictions.

## STS

Use `upload_speech_audio` for source audio authorized for external storage. Read the voice catalog with `operation=sts`, then call `estimate_sts_cost` and `generate_sts`. Tools use an account-scoped `speech_asset_id`; never supply arbitrary raw URLs, another account's IDs, or storage credentials.

Supported source formats are MP3/WAV/AAC/FLAC/AIFF/OGG, up to 50 MiB and 300 seconds. Local FFmpeg/FFprobe validate decoding and duration, remove metadata, and convert to WAV. Failed validation prevents upload.

```powershell
$env:TOPMEDIAI_UPLOAD_ROOT = 'C:\path\to\speech-inputs'
$env:TOPMEDIAI_AUDIO_TIMEOUT_MS = '300000'
npm.cmd run setup:plugin
```

Create the dedicated directory, refresh the plugin package, and reconnect MCP. FFmpeg/FFprobe must already be installed locally. Override their executable paths with `TOPMEDIAI_FFMPEG_PATH` and `TOPMEDIAI_FFPROBE_PATH` if needed; they are never downloaded automatically.

Source URLs may be publicly accessible. Local asset expiry does not delete cloud files. See [Data and privacy](privacy.md).

## Budgets and delivery

For `cost_mode=selected_entitlement`, budget for the selected entitlement. Do not add mutually exclusive billing branches or switch branches independently. Obtain a new quote after expiry or a change in branch or amount.

Quotes, cost confirmations, and deliveries show the credit estimate in `display.estimated_costs`, for example, "Estimated consumption: 10 Credits". TTS uses `billing.credits_required` from local billing rules; STS uses the same field from the backend preview. Even when settlement uses characters, do not replace the credit estimate with character or second counts, or describe estimates as actual charges. Raw `costs` remain available for budgets and settlement. Tasks preserve their quoted estimates for subsequent status and preview calls. Older tasks may recover estimates from their saved account-scoped quote; missing prices remain unknown rather than being guessed.

Use a stable `request_id`. Success returns `status=completed`, `execution_mode=synchronous`, and `artifacts[].url`. Deliver the actual returned links. If an audio address cannot be resolved, preserve generation completion and explain the delivery issue; do not regenerate.

Timeouts, cancellations, disconnects, and abnormal responses may leave the backend outcome unknown. Preserve `submission_unknown`, check the account's history, and do not automatically submit again. Client timeouts must allow enough time for synchronous generation.
