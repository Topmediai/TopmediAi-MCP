# TopMediai MCP integration for Codex

Use this reference for TopMediai production, not for prompt-only or local-only work.
Read the installed `topmediai-mcp` skill for the current product contract; live tool
schemas and returned catalogs determine capabilities and parameters. Never substitute
another provider when a TopMediai tool, login, or capability is unavailable.

## Readiness and model selection

1. Discover the connected `topmediai` MCP tools by their listed names.
   Call `get_service_status`, `get_balance`, and the relevant capability/catalog tools.
   A loaded credential alone does not establish valid account access. On LOGIN_REQUIRED
   use `start_login` then keep waiting on the same `wait_for_login` session until saved
   or terminal; verify account access and resume. Never ask for tokens in chat.
2. Use the user's supported model. If unspecified, use the matching catalog's
   `default_model_type` or `default_mv`, explaining the choice. If that default cannot
   perform the operation, explain and offer compatible choices; do not silently switch.
3. Validate the selected operation's duration, ratio, quality, prompt length, audio,
   and reference limits. Catalog capabilities supersede generic model examples.
   `duration` is the returned protocol enum, not seconds; include `real_duration`
   where required. Preserve sound by default; set `generate_audio=false` only for an
   explicit silent-video request and keep catalog/quote choices consistent.

## Bind actual references

- Upload only the selected, externally authorized media from the configured
  `TOPMEDIAI_UPLOAD_ROOT`. Do not broaden the directory or upload unrelated files.
  Storage links may be public. No upload is needed for local analysis or prompt-only work.
- Images: `upload_reference_image(file_path)` returns an account-scoped
  `reference_image_id`; PNG/JPEG and size/readiness limits come from the service.
- First frame: use `image_to_video` and `first_reference_image_id`. First/last frame:
  use `image_to_video_start_end` plus `end_reference_image_id` only where supported.
- Independent creator/product references: use `reference_to_video` with ordered
  `reference_images=[{reference_image_id, type: "subject"}, ...]` as supported.
  A last frame is an ending constraint, not a second identity reference.
- Video/audio references: `upload_reference_media(file_path, media_type, model_type)`
  requires the returned supported model, authorized files, and local FFmpeg/FFprobe.
  Use `omni_reference_to_video` and returned `reference_video_ids` /
  `reference_audio_ids`. Honor the catalog's per-model media limits.
- Prompt tags such as `@ImageN`, `@VideoN`, `@AudioN` refer to the supplied ordered
  lists; text tags or `{{creator}}` / `{{product}}` alone do not attach media.
  Verify the actual uploaded IDs and binding roles before quoting.

## Exact quote, review, submit, query

1. Quote exact inputs through `estimate_video_cost`, `estimate_image_cost`,
   `estimate_music_cost`, or `estimate_tts_cost` as relevant. Changed inputs need a
   new quote. Do not guess prices, IDs, defaults, or enum values.
2. Maintain a stable `flow_id` for the whole user request. Call
   `review_generation_plan` with all pending `{kind, quote_id}` steps and all original
   submitted `{kind, request_id}` steps, including failed/uncertain submissions.
   Pass the user's current confirmation preference to the review and follow its
   decision. Honor explicit quote-first requests. Pass `confirmed_plan_id` only
   after the user has approved that exact plan. Preserve valid existing approvals.
3. Respect explicit budgets and valid quotes. Show estimates from
   `display.estimated_costs` / plan `estimated_totals`; show balances only from
   `display.balances`, using the site's localized Credits label. Missing is unknown,
   not free. Keep alternative settlement resources internal and never sum unlike units.
4. `generate_video`, `generate_music`, and `generate_tts` take `quote_id`, a stable
   `request_id`, and their schema's `budget`; the prompt/media/settings are bound to
   the quote. Images use `generate_image` with its actual schema (`max_credits`).
   Do not pass invented generic `video_generate`, raw local paths, or model settings
   to a submission that accepts only a quote. Never automatically retry a paid POST
   or uncertain upload; preserve original task/request identifiers and recover/query.
5. Query video/music with the returned `task_handle` via `get_generation_task`;
   query images with the original `request_id` via `get_image_task`. Honor returned
   polling delays and stop on terminal states. Timeout means status unverified,
   not proof of failure, cancellation, or refund. Speech is synchronous.
6. Deliver every completed video with its model, available estimated Credits and a
   named original media link. If `preview_video_task` is available, call it once
   with the completed `task_handle`. Do the same with `preview_audio_task` for
   completed audio when supported. Preview failure does not undo generation.
   Download only when requested or needed for authorized local composition.

## Music, speech, and local composition

- Music: `list_music_models` → exact `estimate_music_cost` → plan review →
  `generate_music` → query/preview. Use the catalog default if no model was specified.
- Speech: `list_tts_models`, `list_voices(operation="tts")`, `get_voice_detail` →
  exact `estimate_tts_cost` → plan review → `generate_tts` → preview. Use a returned
  public voice ID, accent, and supported controls. TTS estimates still display Credits.
- TopMediai currently offers no general video stitching, caption burning, or lip-sync
  tool in this connection. Do not invent one. TTS creates voiceover audio; it does not
  prove on-camera mouth synchronization. For authorized composition use available
  local FFmpeg/code, verify files and sync, and distinguish source clips from a finished
  ad. If local tooling is unavailable, deliver completed assets and state the gap.
- A separate style-test clip is optional, not an automatic extra paid generation.
  Include it in the plan only when requested or justified and authorized. If the model
  cannot render 5 seconds, use a supported duration only within the agreed plan.
