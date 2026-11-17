---
name: ugc-video-ad
description: "Design natural phone-shot UGC ads from product and character references, including demos, try-ons, unboxings, and reviews. Generate video through TopMediai when requested. Use other workflows for cinematic brand films and code-rendered website promos."
---

# TopMediai UGC Video Ad

## Codex / TopMediai execution

For requested TopMediai production, read
[references/topmediai-mcp.md](references/topmediai-mcp.md) before choosing a model,
binding assets, quoting or rendering. The creative phases below describe the ad;
the reference defines real MCP execution. Prompt-only requests stop after the
prompt. Preserve user-selected age, style, product details and existing approvals.

A prompt-forge for UGC-style ad videos. The deliverable is a prompt that makes an AI
video model produce footage indistinguishable from a real person filming on their
phone — because that raw, current, unstaged quality is what earns watch-time. Models
drift toward glossy, graded, older-looking, tripod-stable output unless the prompt
actively steers them away from it; every technique below exists to do that steering.

## Phase 1 — Brief intake (ask little, infer the rest)

Ask only what you cannot reasonably default, in one batch:

1. **Subject** — the product to feature, or the content concept ("GRWM with a chaotic
   outfit", "unbox these sneakers", "review this serum").
2. **Render target** — honor a supported user-selected model. Otherwise use the
   matching TopMediai catalog's product default and explain the choice. Verify audio,
   references and duration in the catalog; if the default cannot meet the requested
   operation, offer compatible alternatives before switching.

Default spoken dialogue and voiceover to conversational English for an overseas
audience. Follow an explicit language choice or a brief that calls for a silent
or music-only ad. Infer the on-camera persona, delivery, and reference roles from
the brief.

## Phase 2 — Cast the creator and scene (before any prompt writing)

The #1 failure mode of AI UGC is an uncast, generic face: models default to a
polished, older "presenter" look. Cast explicitly, always.

**Style references and casting:** study the visible facial proportions, hair,
makeup, wardrobe, posture, expression, and overall presence of any people supplied
as style inspiration. Translate the qualities that suit the product, audience,
and scene into a distinct original creator with their own features and styling.
Cast for each brief and keep the chosen creator consistent within the video.
Bind a creator image for identity only when the user asks to retain that likeness.

**Persona defaults (young, current, real):**
- Choose and state an adult age that suits the brief. For youthful street-style
  work, cast young adults in their early to mid-20s. Vary the casting across
  concepts, including men and women when they fit the brief.
- Give each creator a recognizable combination of hair, facial features, and
  personal style. Use wardrobe, accessories, posture, and expression that suit
  the scene. For example, a creator can pair a short silver bob and ear cuff
  with a boxy denim jacket, or wear a close crop and a paneled technical jacket.
  Keep the delivery casual enough for a phone-shot recommendation.
- Realism cues to write into the prompt: a friendly, upbeat presence, brief looks
  between the product and lens, relaxed head movement, and small gestures that
  follow from handling or showing the product.
- When the face is visible, describe a few natural facial features. Keep face
  shape, jawline, and feature spacing consistent through speech, head turns, and
  cuts. Bind a user-selected identity reference as a separate subject if the
  model supports it. For talking shots, place the phone near eye level at a
  comfortable distance, keep the face away from the frame edges, and avoid close
  ultra-wide framing. Use soft light when facial features or makeup finish need
  to read clearly.

**Scene library (pick one that houses the product):**
- bedroom (soft window light, unmade corner), kitchen counter, bathroom mirror,
  driver's seat / parked car, desk setup, apartment floor near the door. Ordinary,
  specific, lived-in — the filmer's own space.

**Look guardrails (kill the "dated AI" feel in one clause):**
- Use a current phone-camera look with soft, diffuse daylight and neutral white
  balance by default. Use a white or neutral gray object as a visual reference
  when practical. Preserve each subject's natural skin tone or coat colors and
  the product's true colors. Avoid a yellow or orange cast from warm lamps or
  mixed lighting. For image-guided video, inspect the reference frame for a
  color cast because its lighting can carry into the output.
- Add an avoid clause when the render model supports it: no heavy color grading, no
  teal-orange cinematic tint, no 2010s-style beauty filter, no ring-light overexposure,
  no waxy skin smoothing, no VHS/retro filter unless the brief explicitly wants lo-fi.

**Known model weak spots — write around them, don't fight them:**
- Complex hand-object interaction breaks: keep the grip simple (hold steady, one slow
  turn), no fine finger work.
- Applying products to skin (skincare swatches, makeup application) and clothing
  try-on close-ups degrade: frame the product held in hand or worn mid-shot instead.
- Fast gestures and rapid motion: one deliberate movement per beat, slow enough to read.

## Phase 3 — The believability gate (highest-leverage step)

The "this is an AI ad" feeling comes from an incoherent scene far more than from any
camera setting. Before writing a single prompt line, lock these four:

1. **PRODUCT** — what it is, and where it *physically lives* (serum → bathroom;
   sneakers → by the door; desk toy → a shelf).
2. **SETTING** — an ordinary, specific, lived-in place that is a plausible home for
   THIS product. Aspirational locations only when the brief explicitly demands them.
3. **FILMER** — who is holding the phone, plus one concrete, persona-true detail of
   their real space.
4. **MOTIVATION** — why is the camera rolling *right now*? (it just arrived / I'm
   packing / a friend asked / I caught myself using it).

**The one-sentence test:** "Why is THIS person, with THIS product, in THIS place,
filming right now?" If you cannot answer believably in one sentence, fix the setting
or the motivation — never the lighting.

**Rig plausibility:** choose a setup the creator could plausibly shoot. A propped
phone frees both hands. A friend can film a walking shot. Use a separate insert
when a detail needs a different camera position.

**Register match:** keep setting lavishness, packaging tier, and speaking tone on one
register. Premium products are most believable as "I treated myself," filmed at home.

## Phase 4 — Pick a skeleton

**Flow script (default)** — no timestamps; reads like stage direction. Best for a
single continuous moment with a beat or two. Use for models without reliable
multi-shot support.

**Timestamped beats** — each stage gets a window; the look changes via jump cuts.
Best for try-on hauls and multi-stage sequences. Only on models that handle multi-shot
well (Kling 3.0, Sora 2, Seedance 2.x); otherwise timestamps render as noise.


## Phase 4b — Format library (pick one per video)

Match the brief to a proven performance-marketing format; each has a beat skeleton
you can drop the product into:

| Format | Skeleton (15–30 s) | Best for |
|---|---|---|
| **Try-On** | show it worn → show a detail → show fit in motion | apparel, accessories, pet clothing |
| **Unboxing** | package in frame → first touch → hero detail reveal → verdict | new launches, gifts |
| **Money Shot** | hook on the product's most satisfying detail → context → CTA | visually striking products |
| **Problem & Solution** | show the pain (3 s) → introduce product → demo the fix → CTA | utility, cleaning, tools |
| **Before & After** | before state → transition beat → after state → CTA | beauty, fitness, home |
| **Selling Points** | hook → 3 rapid points with visual proof each → CTA | feature-rich products |
| **Tutorial** | end result first → 3 quick steps → invite to try | kitchen, craft, apps |
| **Product Launch** | teaser detail → full reveal in use → availability + CTA | new arrivals |
| **Review / Testimonial** | verdict-first → 2 proof moments → who it's for | considered purchases |
| **TVC-lite** | moody 2 s open → product hero sequence → end card | brand-lean campaigns |

Use the format's skeleton, but keep everything in Phases 3–9 (realness gate, voice,
product-as-hero) — the format is the container, not the style.

## Phase 4c — Frame the product in use

Choose the phone position and shot size by what the viewer needs to see. Use a
handheld selfie, a propped phone, a mirror, a first-person view, or a shot filmed
by a friend as the action calls for. When a presenter appears, start with them
speaking on camera when the framing allows. Carry their voice across product
details, try-on views, and shots of the product in use.

| What the viewer needs to see | Framing that can show it |
|---|---|
| Lip color and finish | Eye-level medium close-up in soft window light. Add a lip or product insert if it helps show the finish |
| Shoe shape and how it looks on foot | Low side view from the ankles down for a few steps, or full-body framing to show how the shoes work with the outfit |
| How a tool, cup, or device works | First-person or countertop view showing the hands, product, and result together |
| Garment fit or movement | Full-body or three-quarter view from a propped phone or a friend at a comfortable distance |
| Pet outfit fit and movement | Full-body view at pet eye level, side or rear three-quarter detail, and a short walk at the pet's pace |

Give each shot a clear job. Use an accent move only when it helps reveal the
product or action.

For pet try-ons, use the garment image for its design and the pet image for the
animal's appearance. When both are supplied and the model supports multiple
subject references, bind them separately and assign their roles explicitly in
the prompt. Keep the pet's markings, proportions, and gait consistent. Map the
garment's visible collar, closures, trim, and patterns to the parts of the body
where they belong. Show the outfit already on the pet and use easy movements,
such as a glance, turn, or short walk, to reveal fit and details. The owner can
film from behind the phone and narrate across the cuts.

## Phase 5 — The realness toolkit

Pick 4–6 per prompt; too many confuse the model, too few let it go glossy.

- **Setting first, light second.** Name a concrete mundane place ("her own messy
  bedroom", "the driver's seat of her car") — never a mood word ("aesthetic",
  "minimalist"), which renders as stock B-roll.
- **Camera:** specify the phone position and framing. Use light handheld
  movement for handheld shots and a stable frame for a propped phone.
- **Grade suppression (load-bearing — never drop):** "no color grading", "no cinematic
  grade", "real skin tones", "no ring light", "soft natural daylight from a window".
- **Skin:** for an original creator, describe natural skin texture and avoid
  beauty smoothing. When the user selects an identity reference, preserve that
  person's appearance.
- **Lived-in background:** 2–3 ordinary details that look *used*, held at the frame
  edge and soft ("a charging cable trailing off the nightstand", "a half-drunk mug").
  Never styled props, never gross, never competing with the product. Vary the objects
  across prompts.
- **Do NOT ask for HDR** — HDR removes the highlight clipping that signals real capture.

## Phase 6 — Voice and performance

By default, the person presenting the product on screen delivers their own
spoken lines. In the prompt, identify the speaker as the visible creator and
describe a voice that suits them and the brief. Ask for natural mouth movements
synchronized to their exact lines whenever they speak with their face visible.
Carry the same voice through cutaways. For a hands-only, product-only, or pet-led
ad with the presenter off camera, specify who is narrating. Follow the user's
explicit direction for a separate narrator or a silent ad.

Write short, conversational lines with ordinary word stress and a natural
speaking rate. Read the lines aloud against the available time or estimate the
read time with room for breaths and phrase breaks. If a line feels rushed,
shorten it or give it more room within the requested duration.

For a recommendation, introduce the product in a real use case, give a specific
reason to recommend it, and show the detail or benefit as it is mentioned.
Use product facts supplied by the user or qualities the video can show. Keep
the spoken thought connected across the shots. Choose sentence count and length
by reading the whole script at a natural pace with room to breathe.

Start promptly with a relevant action or line. Pair the explanation with relaxed
body language and a simple action that shows the point. The creator can lift
the product, gesture to a detail, show the fit, or use it as they describe it.
When a detail needs another angle, cut to it on the relevant words and keep
the explanation flowing. Leave room for brief breaths and natural reactions.
Avoid idle setup, prolonged pauses, abrupt rushing, and lingering end holds.

Direct the creator as if showing the product to a friend: warm, approachable,
and upbeat, with relaxed movement and a small smile where it fits. Keep gestures
motivated by the product and reactions understated. Avoid forced enthusiasm,
fixed smiles, and rehearsed gestures.

## Phase 7 — Model syntax and capabilities

Call `list_video_models` with the actual operation before production. The returned
capabilities determine audio, duration, quality, aspect ratio, prompt length and
reference limits. Do not infer current support from a model family name.

Use clear dialogue and performance blocks for talking UGC. Reference tags must
match the supplied media lists and the model's current contract. Bind separate
product and identity references with a supported multi-reference operation. Use
first and last frames to control the opening and closing images. Explain the
limits returned by the selected model.
For an intentionally silent model, distinguish a separate voiceover from lip-sync;
this MCP connection does not provide a general lip-sync endpoint.

## Phase 8 — Stage the product as hero, not as ad

- **A centered logo or pristine gift box is the strongest "paid ad" tell.** Show the
  product as owned-and-used. Avoid an oversized floating logo/end card unless requested;
  preserve the real product logo and any packaging the brief requires.
- Use one simple grip or weight cue. For example, she tilts the product toward
  the lens as she mentions the detail, then brings it back toward her.
- Describe the product's visible materials, colors, and distinctive details.
  Show it worn, held, or used in a way that supports the recommendation.

## Phase 9 — End it like a person

Cut on a natural movement or as a small smile lands. Keep the product in frame
through the cut.

## Phase 10 — Deliver the prompt

Output in a clean code block, then briefly note: target model and params (9:16,
duration, audio on/off, caption suppression), and that `{{creator}}` / `{{product}}`
are asset slots to bind per the platform's mechanism (uploaded reference images —
first frame or subject reference — not in-prompt tokens). If the model is silent,
flag that a separate voiceover/composition is needed and that mouth synchronization is unverified.

When the user asks for character studies or video stills, use the requested
image generator and compose for the intended video aspect ratio. Each requested
variant should have its own casting and shot direction. Keep the product
recognizable and review face proportions, color, and framing in the results.

## Phase 11 — Verify binding, then render via TopMediai MCP

1. Check the actual attachment IDs and roles before quoting. If required media is
   absent, resolve the input; prompt placeholders alone do not bind assets. Text-only
   concepts legitimately use `text_to_video` without image attachments.
2. Follow [the integration reference](references/topmediai-mcp.md): exact quote,
   complete-flow review, applicable confirmation, quote-bound submission, original
   task query and preview delivery. Keep native audio on unless silence is requested.
3. A short style test can help a batch, but propose it as an optional paid stage,
   quote it and use a supported duration. Do not add it automatically to a single clip.
4. For batch shots, retain creator/product/look anchors. If a finished edit was
   requested, assemble and verify locally when tools are available; otherwise deliver
   the successful clips and identify the remaining edit. Never label raw clips or a
   standalone TTS file as the finished captioned/lip-synced advertisement.
