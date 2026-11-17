---
name: clone-video-ad
description: "Analyze reference ads and create original adaptations with a shot breakdown, Look & Sound card, generation prompt, hook variants, and character dossier. Supports motion guides made from depth estimates and video generation through TopMediai."
---

# TopMediai Clone Video Ad

Turn one winning competitor video into five reusable assets: a rebuilt prompt you can
render, a bank of hook variations to A/B test, a creator identity dossier, and a
Look & Sound card that preserves the original's color, grade, filters and music feel.

## Evidence and production boundary

Inspect the actual supplied video before attributing shots, dialogue, music or
timing to it. Frames alone support visual analysis, not unheard audio or a full
transcript; label unknowns and estimates. A URL or filename alone is not evidence
of decoded media. Pure analysis requires no upload or paid generation. Describe
the observed performer accurately in the reference analysis.
For "make this for my product", transfer the shot plan, product facts, look/sound
anchors and authorized media to [ugc-video-ad](../ugc-video-ad/SKILL.md). Read its
[TopMediai MCP integration](../ugc-video-ad/references/topmediai-mcp.md) for
catalogs, uploads, quotes, review, submission and delivery. Multiple
paid shots must be part of the same flow review; stitching uses verified local
tools, not an invented TopMediai editing endpoint. Analysis-only requests stop at
the requested artifacts.

## Character identity for the adaptation

- If the user provides a character image or identity reference, use it for the
  adapted character's appearance and continuity. Bind the supplied image as a
  character reference when the selected model supports it. If the model cannot
  accept it, explain the limitation before quoting the generation plan.
- If the user supplies no character reference, design a distinct original
  character. Give them their own facial features, hair, and styling so they are
  visually distinct from the reference performer. Carry over the performance,
  blocking, gestures, camera work, and timing that serve the ad.
- In the render prompt, state which input controls character appearance. If the
  reference video is also attached, assign it the relevant motion, framing, or
  timing role. Use the same adapted identity across all shots.

## Automatic environment preparation

For a chosen depth route, read
[references/automatic-setup.md](references/automatic-setup.md) and invoke
`scripts/run_depth.ps1` on Windows or `scripts/run_depth.sh` on macOS/Linux.
The entry point automatically obtains an isolated Python, hash-locked dependencies,
portable FFmpeg and the depth model, then runs conversion. Reuse verified caches.
Do not ask users to manually configure Python, package environments, model paths or
PATH. Only actual host/network restrictions may need user action. Setup is invoked
on the first relevant task, not by downloading the ZIP itself. Pure analysis does
not initialize a heavy depth runtime. Preserve TopMediai login and cost approval rules.

## Scene routing and genuine depth motion guide

Before adapting a reference for generation, read
[references/scene-routing-and-quality.md](references/scene-routing-and-quality.md)
to separate action, camera, geometry, appearance, focus and audio requirements.
Prefer evaluating depth for spatial-action/camera transfer with changed appearance,
including product showcase, choreography, character blocking and foreground/background
layering; choose complements or another route when depth loses critical information.
Do not force depth onto text/UI, color-change or dialogue/lip-sync requirements.

When depth is selected or explicitly requested, read
[references/depth-motion-guide.md](references/depth-motion-guide.md) and use
`scripts/run_depth.ps1` / `scripts/run_depth.sh` for automatic setup and the real
`scripts/make_depth_video.py` estimator behind them.
Ordinary grayscale conversion is not depth. Inspect RGB/depth pairs and save measured
metadata before using the derived guide. Original RGB video supplies analysis;
depth supplies geometry/motion; product images supply appearance; text defines the
new full-color scene. Treat this as an experimental reference technique, not a native
TopMediai depth-control API or a universal fix for an unknown failure. Apply the
local quality gate before upload/quote, recording uninspected conditions honestly.
Distinguish technical conversion, usable depth, backend generation and creative
fidelity. Dance requires pose/foot-contact/beat checks; depth ordering does not encode
optical depth of field; apparent perspective motion is not a calibrated camera solve.
One successful local showcase is evidence of feasibility, not a measured success rate.

Phrase recreation as a new video guided by observed timing/camera/action. Reserve
"edit/replace/preserve every other pixel" language for an actual editing request.
For an explicit depth-guide request, use the depth clip as the motion reference,
and bind it with the product/character images using an available
`omni_reference_to_video` model. Keep the authorized MP4 under the existing
dedicated upload root for the MCP call, with the local report and original RGB
source kept separately unless they are needed for the request. Do not force a phone-shot UGC look onto a cinematic
product-showcase reference. Pure skill/preprocessing work does not start a paid retry.
Changed media needs a fresh quote and review preserving prior failed submissions
in the same flow. Respect explicit provider restrictions rather than modifying
references to bypass them.

## Decode framework — seven lenses

### Lens 1 — Script
- Full verbatim transcript with timestamps.
- Tone markers (conversational / authoritative / breathless / dry).
- Pause points, emphasis words, and where the CTA lands.

### Lens 2 — Visual grammar
- Shot size and angle per beat (close-up / medium / wide).
- Camera behavior (locked phone, handheld drift, slow push).
- Cut rhythm: where cuts land, average shot length, and how often — this is the
  pacing DNA; capture it as a timecoded shot table (see Multi-clip mode).
- **Signature moves:** name every deliberate camera accent (crash zoom, whip pan,
  dolly-in, orbit, bullet-time-style speed ramp) with the beat it lands on — the
  original's "signature move" is often why it feels watchable; losing it in the
  rebuild is the most common pacing failure.

### Lens 3 — Lighting
- Source (window, ring light, overhead), direction, quality.
- Color temperature and contrast feel — note tells of studio lighting on "casual" content.

### Lens 4 — Color, grade & texture (the look)
This lens separates "looks like the original" from "same words, different film". Capture:
- **Palette:** 5 dominant swatches with approximate hex, plus accent color usage.
- **Grade:** contrast level, saturation level (muted / natural / punchy), white-balance
  lean (warm / neutral / cool), any tint (teal-orange, golden, green-shadow film look).
- **Filters & texture:** film grain, halation, soft bloom, VHS/lo-fi, monochrome or
  desaturated passages, sharpened-phone look, none-at-all.
- **Depth cues:** shallow or deep depth of field, background blur amount, whether the
  subject separates from the background.
- **Era check:** does the look read current or dated? Name the specific tell
  (2010s heavy filter, crushed blacks, oversaturation) so the rebuild can avoid it
  unless the original genuinely wins with it.

### Lens 5 — Sound & music
- Music genre, tempo (BPM estimate), energy arc (build / flat / drop at reveal).
- **Sync points:** which on-screen events the music hits or accents land on.
- Voice treatment: raw phone-mic vs processed, room tone, voice-to-music balance.
- SFX inventory: whooshes, pops, UI clicks, silence as a tool.

### Lens 6 — Delivery
- Energy on a 1–10 scale per beat, not overall.
- Gesture inventory and facial timing; micro-expressions (natural pauses, eye-contact
  shifts, subtle head movement) — these are what sell "real person".
- Authenticity markers: self-interruption, offhand aside, visible imperfection.

### Lens 7 — Identity fingerprint
Record visible traits of the source performer in the debrief. For the adapted
creator dossier, use the user-supplied identity or the distinct original
character defined above. Describe the face, hair, and distinguishing features
concretely enough to maintain continuity across shots. Use the brief to choose an
age range for a new character.

## Rebuild — prompt construction

Reconstruct the decoded ad as a render-ready prompt with the look and sound carried
over explicitly. Populate CHARACTER with the adapted identity and its reference
role. For a new ad with spoken lines, default to conversational English at a
natural rate unless the user requests a different language. For UGC adaptations,
use the friendly delivery and continuous pacing guidance in
[ugc-video-ad](../ugc-video-ad/SKILL.md). Keep the source transcript in its
original language in the debrief.

```
CHARACTER: [age] [ethnicity] [gender], [face shape] face, [eyes], [nose], [mouth],
[skin], [distinguishing marks]. [Hair]. [Overall vibe.]
SETTING: [environment + background detail + atmosphere]
LOOK: [palette swatches] · [contrast/saturation level] · [white balance / tint] ·
[filter/texture: grain/halation/none] · [depth of field]
PERFORMANCE: [what they do, energy per beat, gestures, micro-expressions, expression timing]
CAMERA: [shot size, angle, movement, framing, per-shot from the shot table]
LIGHT: [source, direction, quality, mood]
SOUND: [music genre ~BPM, sync points, voice treatment, SFX]
SCRIPT: "[full dialogue]"
SPECS: duration [N]s · 9:16 · UGC, authentic, relatable · high fidelity
```

The decode informs the rebuild; never copy the competitor's actual copy, branding, or
claims — rebuild the *structure, look and energy*, swap in the user's product, hooks,
and voice.

## Multi-clip mode (pacing-faithful rebuild)

One monolithic prompt flattens the original's rhythm — real pacing comes from cuts.
When fidelity matters (it usually does), rebuild as a sequence:

1. From Lens 2's shot table, emit **one render-ready prompt per shot** (same
   CHARACTER/LOOK/SOUND headers, per-shot CAMERA/ACTION/SCRIPT) — typically 3–6 shots
   for a 15–30 s ad.
2. Render each shot separately at uniform specs (ratio, fps, grade anchors).
3. Stitch in order with hard cuts at the original's cut points; no dissolves.
4. If the platform's model supports multi-shot natively, prefer that path with the
   per-shot beats embedded; fall back to generate-and-stitch otherwise.

## Hook engine

From Lens 1, classify the hook type (problem-solution, curiosity gap, social proof,
urgency, contrarian claim, direct callout, etc.), then:

1. Distill it into a reusable formula: trigger + specificity + emotional lever.
2. Generate **10 variations** — same formula, different surface details, spanning
   angles the original didn't use.
3. Keep every variation within the proven structure; change details, not skeleton.

## Output contract — always five artifacts

| # | Artifact | Filename convention | Contents |
|---|---|---|---|
| 1 | Debrief | `Debrief-[Product]-[HookType]-[Date].md` | all seven lenses, actionable only |
| 2 | Look & Sound card | `Look-[Product]-[Date].md` | palette swatches, grade, filters, depth cues, music BPM + sync points |
| 3 | Rebuild prompt(s) | `Rebuild-[Identity]-[Setting]-[Type]-[Date].txt` | monolith, or `Shot01…ShotN` set in multi-clip mode |
| 4 | Hook bank | `Hooks-[Product]-[Variation]-[Date].txt` | original hook + 10 variations |
| 5 | Identity dossier | `Identity-[Name].md` | fingerprint + reference-image notes |

## Playbooks

1. **Single decode** — "解构这个视频": run the framework, deliver all five artifacts.
2. **Identity continuity** — "用 [角色名] 出 N 条": load `Identity-[Name].md`, generate
   rebuild prompts across settings (bathroom, bedroom, kitchen, car) with the face held
   identical.
3. **Competitor sweep** — upload the category's top 5 videos: decode all, extract the
   shared hook formula, average structure, winning look, and the synthesis of elements.
4. **Batch matrix** — combine M identity dossiers × N hook formulas into a full
   production queue of rebuild prompts.
5. **Hook isolation test** — hold body, CTA, look and creative identical; vary only the
   hook, so performance differences are attributable to the hook alone.

## Quality bar

- Rebuild prompts ship render-ready: no placeholders left unbound; LOOK and SOUND
  blocks never omitted — a rebuild missing the original's grade or music feel is a
  failed rebuild.
- Verify the render prompt uses the intended character and reference roles.
  When reviewing a render, check identity continuity and report visible drift.
- Every observation must change a decision — no generic "good pacing" notes.
- Hook variations preserve the proven skeleton; deviation happens in details only.
- Multi-clip mode: per-shot prompts must share identical CHARACTER/LOOK/SOUND headers
  so the stitched result reads as one film.

## Library effect

After ~20 decodes you own: 20 proven structures, 20 looks, 20 sound beds, 200+ tested
hooks, and a cast of consistent creator identities — a compounding creative arsenal no
single tool ships with.
