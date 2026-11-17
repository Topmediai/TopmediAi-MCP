# Scene routing and depth quality

Read this before selecting reference inputs for an adaptation. Depth is a preferred
candidate when the requested inheritance is spatial motion, camera movement or
occlusion and the final appearance comes from different assets. It is not mandatory
for every reference ad. An explicit user choice takes precedence; explain concrete
limitations and fill missing information rather than silently switching routes.

## What to inherit

Determine separately: subject appearance, action/pose, camera motion, timing,
foreground/background geometry, color/light, focus/blur, dialogue/music, and text/UI.
State the chosen route and asset responsibilities briefly before quoting. Infer
ordinary choices from the request; ask only when a meaningful ambiguity remains.

| Task | Depth route assessment | Required complements and checks |
|---|---|---|
| Dance / action imitation | Good candidate for body travel, turns, spacing, gross limb motion; not proven joint-accurate motion capture | Character image if identity matters; timed key poses and source beat timing. Inspect crossed limbs, hands, foot contact/sliding, spins, fast motion, facing direction and screen-left/right. A muted depth clip carries no music beat. Use available pose/skeleton references only where the actual tool/model accepts them; do not invent pose-control parameters. |
| Character performance | Useful for entrance, sit/stand, bending, reaching and relative positions | State acting, gaze, expression and hand intent in text; appearance/identity image when available. Facial micro-expression, fingers and speech/lip-sync are not recovered from depth alone. |
| Foreground/background layering | Useful for near/far ordering, occlusion and a subject passing in front of objects | Describe actual scene/materials from RGB evidence or supplied scene images. Relative depth is not a calibrated distance map. Check depth ordering at overlaps and transitions. |
| Photographic depth of field / rack focus | Geometry may help, but depth estimates do not encode the original aperture, lens, blur or focus schedule | Write foreground/background focus targets and exact focus-change timing from the RGB source. Do not treat synthetic blur as recovered optics or use “depth” and “depth of field” interchangeably. |
| Camera push/pull, tracking, orbit, rise, low/high viewpoint | Good candidate for visible perspective change and relative motion | Separate the subject's path from the camera's path; specify operator side, screen direction, framing, turn/orbit direction, timing and focus. A depth clip is not calibrated camera tracking or an exact 3D camera solve. Verify background parallax and subject scale. |
| Product levitation, reveal, turn and hero showcase | Preferred candidate when preserving trajectory/composition while changing the product | Product image controls the new shape and branding. The source object's silhouette is only rough occupancy; do not force a bottle into a carton shape. Check grip, trajectory and landing/contact. |
| Try-on / fashion | Useful for full-body blocking and broad outfit movement | Garment/character images preserve cut, print and color; inspect cloth, hair and occluded limbs. Depth loses fabric appearance and cannot guarantee fit. |
| Unboxing | Conditional, requires contact-state review | Separate box, lid, hands and product; state closed/open states and one-time reveal. Depth merges nearby fingers/surfaces; use keyframe references or simpler actions if separation fails. |
| Problem/solution, tutorial | Useful for gross action, insufficient for an exact physical procedure | Describe ordered steps and actual demonstrated mechanism; inspect tool contact, small parts and grip changes. Use readable detail/keyframes where precision matters. |
| Money shot / tactile macro | Conditional | Transparent glass, shiny metal, liquids, smoke, particles, tiny surfaces and reflections may have misleading depth. Appearance/material references and explicit light/physics remain essential; text/keyframe guidance may be better. |
| Before/after | Conditional for movement, poor for color/texture-only change | Preserve separate verified before/after appearance evidence. Depth cannot encode a skin-color, finish, print or UI-state difference by itself; never invent product efficacy. |
| Selling points / product launch / TVC | Route each shot by its mechanism | Use depth for spatial staging; use actual assets/local composition for readable claims, end cards and typography; use RGB-derived look/light guidance for art direction. |
| Review / testimonial / talking-head | Supplemental blocking reference | Script, voice, facial performance and lip-sync are separate requirements. Depth does not replace them or validate a testimonial. |
| Multi-character interactions | Conditional, higher inspection burden | Distinct character references and spatial roles; inspect crossings, identity swaps, occlusion and contact. Do not assume a merged depth region separates actors correctly. |
| Multi-shot / fast-cut edits | Conditional, shot-aware processing | Detect actual cut times. Review normalization per shot; do not smooth or interpolate across hard cuts. Reassemble with measured timings if preprocessing per shot. |
| Website/UI, text animation, product color/finish comparison | Depth is usually not the primary route | Preserve real screenshots/vectors and use code/local composition, or supported image/keyframe workflows. Depth discards the very information these tasks need. |

These are engineering suitability judgments, not experimentally established
success rates. Specialized planning skills can supply choreography/storyboards;
do not force a phone-shot UGC aesthetic onto a dance or cinematic reference.

## Four separate outcomes

1. **Technical conversion:** decoding, model inference, encoding, measured frame
   rate/duration/aspect and output files succeed. Causes of failure include damaged
   media, unsupported export/input, unavailable dependencies and memory limits.
2. **Usable depth guidance:** motion/geometry remain intelligible. An MP4 can be
   technically valid but contain flat or inverted depth, shape loss, foreground /
   background swaps, occlusion errors or temporal flicker.
3. **Backend generation:** upload, exact quote, submission and terminal status.
   Valid depth does not guarantee service acceptance or successful generation.
4. **Creative fidelity:** the completed output preserves the requested action,
   camera, timing, product/identity and visual/audio requirements. A successful
   task status alone does not establish this outcome.

Report the actual failed stage rather than a single undifferentiated “failed”.
If the backend returned no reason, say cause unknown. Do not infer refunds, policy
classification or cause from a successful later attempt.

## Local quality gate before upload and quote

Keep the original RGB source for local evidence. Pair it with depth at the opening,
each cut, action extrema, overlap/contact changes, near-lens point and final state.
For choreography add beat anchors, turns, foot plants and crossed-limb moments;
for camera reference add parallax and framing changes. Watch dense windows around
fast/occluded events; sparse contact sheets alone cannot verify temporal stability.

Record four fields for each required condition: what was inspected, observed issue,
effect on this specific task, and pass / needs repair / not inspected. Suggested
conditions:

- Media timing/aspect match within the measured conversion tolerance.
- Near/far polarity is correct and the clip is neither blank nor effectively flat.
- Required subject/object boundaries and motion are readable at critical moments.
- Important overlaps, hand-object contacts and foot plants have usable separation.
- Frame-to-frame depth changes do not destroy the intended motion; inspect actual
  consecutive frames before claiming stability. Camera and subject movement remain
  distinguishable enough for the requested result.
- Appearance, small text, color, facial detail, sound and focus requirements lost
  in depth have actual complementary assets or explicit written instructions.

Block this route when missing/incorrect depth undermines the specific required
action or camera path. Do not upload just because encoding succeeded. Ordinary
minor imperfections can be disclosed when the guide remains useful. Do not call
uninspected conditions “passed”. No arbitrary numerical score guarantees quality.

## Proportional fallback

Fix the identified local problem first: correct decode/frame rate, use suitable
inference resolution, split at actual cuts, simplify the target interaction, or
use an available temporally consistent video-depth estimator. The existing helper
is single-frame Depth Anything V2 applied per frame; clip-wide normalization is
not temporal inference. Do not claim Video Depth Anything was used unless it was.
Its [official implementation](https://github.com/DepthAnything/Video-Depth-Anything)
is a possible alternative, not an installed dependency of this skill.

When depth cannot preserve the information that matters, use the available
appearance/keyframe, pose-reference, text/shot-plan, RGB-reference or code route
that meets the user's objective. Respect explicit route/model choices and actual
capabilities. Do not silently replace depth with grayscale or an unsupported API.
Explain any material creative change. Additional paid tests require separate
exact quotes and the current conversation's approval rules; no automatic paid
retry or batch is implied by preprocessing failure.

## Evidence and future validation

Current local evidence: one car-interior product-showcase adaptation had a failed
RGB-reference attempt and a successful depth-guide attempt with a revised prompt.
The preprocessing used Depth Anything V2 Small; successful generation was with
Seedance 2.5. Source preprocessing, prompt framing and media changed together.
The user reported success; task completion is recorded. This is not a controlled
causal test or a cross-category benchmark. Do not infer a percentage failure rate,
universal applicability, or “depth fixes editing classification”.

For future authorized tests, keep a record of category, actual inputs, estimator /
settings, prompt version, model/quality/duration, conversion result, depth-QA result,
generation result and observed output quality. Distinguish one source with retries
from independent sources. Report sample counts and scope before rates. Estimate
category reliability only from a sufficiently representative set, and disclose
uncertainty rather than extrapolating this single success. Do not run a paid
benchmark or change the estimator automatically to populate the record.
