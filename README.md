# Euclid

A **Euclidean drum machine / polymeter sequencer for the web**, where every sound is
generated procedurally (no samples) by a single hand-written `AudioWorklet`. You build
rhythms as **circles of steps** — each of six voices per pattern spreads a number of
hits evenly around a ring of steps — assign each voice a synthesised sound found by
**shuffling** a deep synth engine, chain patterns into a loop, and export the result to
WAV.

It descends from *MobileSequencer 010* (a mobile port of the JUCE desktop app
*Sequencer 010*); the synth engine is a faithful JavaScript port of that C++ engine.
The original was a note-painting melody grid; **Euclid replaces the painting UI with a
Euclidean circle sequencer** and adds true polymeter, per-voice inline shuffling, a
mixer, and WAV export.

This document is written to be complete enough to **recreate the app from scratch**. It
specifies the concept, architecture, data model, DSP engine, sequencer timeline, shuffle
system, and UI, including the non-obvious algorithms.

---

## 1. Product concept

- **Mobile-first, single-page, dark-themed** web app. Installable PWA with offline
  support. Portrait orientation.
- **Six patterns** ("grids"), each an independent Euclidean sequencer with **six
  voices** (concentric circles — one per letter of the logo). A voice is a synth sound
  plus a Euclidean rhythm (`hits` spread over `steps`, rotated by `start`, optionally
  split unevenly).
- **One visual language: dots on lines.** The logo is the word "Euclid" drawn from
  dots joined by thin lines (one voice colour per letter, `src/ui/logo.ts`); voice
  values are coloured circles on a connecting line; the BPM slider is a white dot on
  a white line; toolbar buttons are colour-ringed circles.
- **A 20-slot loop order** chains patterns into a song. Consecutive identical slots make
  a pattern play longer; different patterns hand off to each other.
- **Shuffle is the core creative act.** Instead of dialing a synth, you randomise a
  voice's entire sound within a chosen "character window" until you find something you
  like. The synth is deep enough (≈10⁷³ distinct settings per voice) that shuffling keeps
  surfacing new timbres.
- **Everything is live.** Editing a voice, shuffling, muting, or changing the rhythm
  updates the running loop. Playback can **solo one pattern** or **play the whole loop**.
- **Export** renders the loop to a downloadable WAV (for manual upload to SoundCloud,
  etc.). There is no built-in publishing — the SoundCloud API is closed to new apps.

---

## 2. Tech stack & project layout

- **Vite 5** + **TypeScript 5**, **no UI framework** — the UI is built with direct DOM
  calls (`document.createElement`) and a single global stylesheet. State lives in one
  `App` class that re-renders views imperatively.
- **Audio: one `AudioWorklet`.** All DSP is in `public/worklet/engine.js`, authored in
  **plain JS** and served **verbatim** (no bundler transform), because it runs in the
  `AudioWorkletGlobalScope`. It must be self-contained (no imports).
- `vite.config.ts` sets `base: "./"` so the build can be hosted from a subfolder; the
  worklet is loaded by URL at runtime (`${import.meta.env.BASE_URL}worklet/engine.js`).
- **PWA**: `public/manifest.webmanifest` + `public/sw.js` (registered in production only).
- **Deploy**: GitHub Pages via `.github/workflows/deploy.yml` on push to `main`
  (`npm ci` → `npm run build` → upload `dist/`).

```
index.html                 → loads src/main.ts, mounts #app
src/main.ts                → new App(#app); registers the service worker in prod
src/style.css              → single global stylesheet (dark theme tokens in :root)

src/ui/app.ts              → App: owns engine + arrangement + kit + UI + all views
src/ui/logo.ts             → the "Euclid" wordmark as dot-and-line SVG letters
src/ui/euclidView.ts       → circular canvas visualization of one grid's 6 voices
src/ui/voiceShuffleMenu.ts → per-voice inline shuffle popup
src/ui/soundView.ts        → full per-parameter editor for one voice
src/ui/gridView.ts         → LEGACY 5×16 note-painting grid (not used by the UI)
src/ui/confetti.ts         → LEGACY (unused)

src/audio/engineHost.ts    → main-thread wrapper around the worklet (message API + offline render)
src/audio/wav.ts           → AudioBuffer → 16-bit PCM WAV Blob

src/model/params.ts        → ParamId enum (snapshot indices) + param grouping
src/model/paramSpec.ts     → per-drum parameter ranges/defaults + choice lists + skew mapping
src/model/drums.ts         → the 12 drum "characters" (DrumType) + the 5 named slots
src/model/presets.ts       → factory presets (character windows + "Full Range")
src/model/drumKit.ts       → editable params, the Shuffle algorithm, undo, length model
src/model/euclid.ts        → Euclidean/split pattern generation
src/model/melodyGrid.ts    → MelodyGrid (voices+cells) + WipArrangement (6 grids + order) + loop math
src/model/melodyScale.ts   → row→note key/scale mapping (manual mode + engine parity)
src/model/project.ts       → serialize/deserialize (versioned JSON, migrations)
src/model/soundLibrary.ts  → LEGACY saved-sound folders (not used by the UI)
src/model/rhythms.ts       → LEGACY rhythm presets (not used by the UI)

public/worklet/engine.js   → the entire DSP engine (voice + channel + FX + sequencer clock)
```

> **Legacy note.** `gridView.ts`, `confetti.ts`, `soundLibrary.ts`, `rhythms.ts`, and the
> manual note-painting path are inherited from MobileSequencer and are **not wired into
> the Euclid UI**. The engine still supports manual grids for back-compat, but new grids
> open in Euclidean mode and the UI only exposes Euclidean editing. A fresh recreation can
> omit the legacy files entirely.

---

## 3. Architecture: two threads, one message protocol

**Main thread** (`App`) owns all editable state and the UI. It never does DSP; it sends
the audio thread a compact description of the sounds and the pattern.

**Audio thread** (`EngineProcessor` in `engine.js`) owns the clock and all synthesis. It
holds a **sound table** (id → parameters) and a **pattern** (6 grids + 20-slot order),
runs a step sequencer, and renders audio.

### Message protocol (`engineHost.ts` ⇄ `engine.js`)

Main → worklet (`port.postMessage`):

| message | payload | effect |
|---|---|---|
| `setSounds` | `sounds: {id, snap, lo, hi, tail}[]` | replace the whole sound table |
| `pattern` | `blocks, order, restart` | replace the pattern; while playing and `!restart` it's **staged** and applied at the next loop boundary; `restart` (or stopped) applies immediately and resets the transport to step 0 |
| `tempo` | `bpm` | set tempo |
| `play` | `maxSteps` | start from step 0; `maxSteps>0` stops sequencing after that many steps (used by offline export), letting tails ring |
| `stop` | — | stop sequencing (tails keep ringing) |
| `audition` | `snapshot, gate, tail` | play one sound once on a reserved preview channel |

Worklet → main:

| message | payload | effect |
|---|---|---|
| `playhead` | `{grid, col, slot, fired[]}` | drives the circle playhead highlight, the order-slot highlight, and the mixer flash LEDs. Sent only when it changes. |

A **sound** in the table is `{ id, snap:number[], lo, hi, tail }` where `snap` is the full
parameter snapshot, `lo`/`hi` are the Pitch range (for key mapping), and `tail` is the
estimated ring length (for channel stealing). The engine **binds ids to physical channels
on demand** (see §4.4), so any number of distinct sounds can share 32 channels.

### Offline render (WAV export)

`renderToBuffer()` creates an `OfflineAudioContext`, adds the same worklet module, and
constructs the node with **`processorOptions`** carrying the whole render config
(`{render:true, sounds, blocks, order, tempo, maxSteps}`). The processor constructor
applies that config **synchronously** and sets `playing=true`. This is essential:
`startRendering()` runs to completion immediately, so port messages posted just before it
would race the render and produce silence — passing config via `processorOptions`
guarantees it's live before the first render quantum.

---

## 4. The synth engine (`public/worklet/engine.js`)

A single `AudioWorkletProcessor` named `engine-processor`, 2-channel output. Constants:
`NUM_DRUMS = 32` physical channels, `NUM_VOICES = 6` polyphony per channel,
`STEP_GATE_SEC = 0.4` (tempo-independent note hold so a hit plays its full envelope).

### 4.1 Parameter snapshot

A sound is a flat `number[]` **snapshot** indexed by `ParamId` (`src/model/params.ts`).
The order is **append-only** and the worklet's `P` map mirrors it exactly, so old saves
keep working as parameters are added (missing tail defaults to "off"). Current layout
(65 values):

```
0  Pitch            Hz, base oscillator frequency
1  PitchEnvAmount   × multiplier of a per-note pitch envelope; BIPOLAR — negative
                    starts low (floored at 5Hz) and RISES into the note (swells/zaps)
2  PitchEnvDecay    s, exponential decay of the pitch envelope
3  Waveform         Sine / Tri / Square / Saw (square has LFO-able pulse width;
                    square & saw edges are polyBLEP anti-aliased)
4  ToneLevel        0..1 oscillator level
5  NoiseLevel       0..1 noise level
6  AmpAttack        s
7  AmpDecay         s
8  AmpSustain       0..1
9  AmpRelease       s
10 FilterType       LP / HP / BP / Vowel (3 formant BPs; Cutoff morphs A-E-I-O-U)
11 FilterCutoff     Hz
12 FilterReso       Q
13 LfoTarget        Pitch/Filter/Amp/Drive/Reso/Wave/None (LFO 1)
14 LfoRate          Hz (only while the LFO's Sync = Free)
15 LfoDepth         0..1
16 Drive            0..1  (tanh saturation)
17 EchoTime         s
18 EchoFeedback     0..0.85
19 EchoMix          0..1
20 ReverbSize       0..1
21 ReverbMix        0..1
22 Volume           0..1  (not randomizable)
23-25 Lfo2Target/Rate/Depth
26-28 Lfo3Target/Rate/Depth
29 NoiseType        White/Pink/Brown/Blue/Violet/Crackle/Metal
30 OscModType       Off/FM/Ring (second-operator cross-mod)
31 OscModRatio      modulator freq as a ratio of the carrier
32 OscModAmount     FM index / ring depth
33 Crush            Off/12/10/8/6/5/4/3-bit
34 Downsample       Off/2x/3x/4x/6x/8x/12x/16x
35-37 Lfo1Shape/Lfo2Shape/Lfo3Shape   Sine/Tri/Saw/Square/S&H
38 Osc2Mix          0..1 second oscillator level
39 Osc2Detune       semitones
40 Sync             hard-sync osc2 to osc1 (Off/On)
41 Fold             0..1 wavefolder amount
42 CombMix          0..1 Karplus-Strong/comb dry-wet
43 CombTune         resonator pitch as a ratio of the note
44 CombDecay        0..1 resonator feedback (pluck → sustained string)
45 AmpAttackShape   attack curve: 0 plucky .. 0.5 linear (legacy) .. 1 slow swell
46 AmpDecayShape    decay+release curve: 0 gated hold .. 0.5 linear .. 1 percussive
47 ToneDecay        s, independent exponential decay for the tone layer (0 = follow amp)
48 NoiseDecay       s, independent exponential decay for the noise layer (0 = follow amp)
49 ClickLevel       0..1 transient click layer level (0 = off)
50 ClickType        Tick / Snap / Knock / Blip / Clank
51 ModalMix         0..1 modal resonator bank dry/wet (0 = off)
52 ModalMaterial    Membrane / Bell / Bar / Bowl / Plate (mode ratio+decay tables)
53 ModalDecay       0..1 ring-time scale (4^(2(v-0.5)) = 0.25x .. 4x)
54 EchoSync         Free / 1/32 / 1/16 / 1/16. / 1/8 / 1/8. / 1/4 / 1/4. / 1/2
55 EchoPing         stereo ping-pong echo (Off/On)
56 Pan              -1..+1 constant-power (centre = exact legacy mono level)
57 AccentAmount     0..1 how much NON-accent hits duck (accent = cycle's first hit)
58 Humanize         0..1 per-hit random level/pitch/cutoff jitter
59 HitChance        0.25..1 probability a hit plays (misses may become quiet ghosts)
60 Ratchet          0..1 probability a hit becomes a 2-4x retrigger burst
61 ChokeGroup       Off / A / B / C / D (not randomizable — kit wiring, not a gene)
62-64 Lfo1Sync/Lfo2Sync/Lfo3Sync   Free / 1/32 / 1/16 / 1/16. / 1/8 / 1/8. / 1/4 /
                    1/4. / 1/2 / 1/1 — one LFO CYCLE spans the division at the live
                    tempo (Free = LfoRate Hz), phase-locked to the beat grid per hit
```

`src/model/paramSpec.ts` defines, per parameter, a base `{min, max, def, skew, step, unit,
randomizable, choices?}` and then **narrows ranges/defaults per drum character** so each
stays in character (a Kick can't squeal, a Hat lives bright, etc.). `skew` gives a
juce-style non-linear slider mapping (`p^skew`), used by the UI and manual entry;
`choices` marks a parameter discrete.

### 4.2 Voice signal chain (per sample)

Each `Voice` renders sample-by-sample through this chain (order matters):

1. **Three LFOs** evaluated first. Each has a shape (Sine/Tri/Saw/Square/**Sample-&-Hold**),
   rate, depth, destination, and a **tempo sync** (`Lfo*Sync`). They fold into modulators:
   pitch (× 2^(v·d·0.5)), filter cutoff (× 2^(v·d·2)), amp (tremolo), drive (additive),
   resonance (× 2^(v·d)), or pulse width. Phases advance even when depth is 0. S&H latches
   a new random value each cycle. When Sync ≠ Free, one LFO cycle spans the division at
   the LIVE tempo (`60·beats/bpm` seconds — recomputed every block, like the echo) and
   the phase is initialised from the transport at the hit (`(beatPos/beats) mod 1`,
   `beatPos` = beats since play started) instead of restarting at 0 — so every hit's
   wobble lands the same way against the bar (the classic beat-synced dubstep wobble).
   Auditions (no transport) start at phase 0.
2. **Pitch** = `basePitch · (1 + pitchEnvAmount·pitchEnv) · pitchLFO`, where `pitchEnv`
   decays exponentially each sample.
3. **Second operator** (FM or Ring): a sine at `freq·ratio`. FM adds to the carrier phase
   (`× amount·FM_INDEX`, `FM_INDEX=4`); Ring multiplies the carrier by `(1−amt)+amt·mod`.
4. **Oscillator 1**: sine / triangle / square / saw (square uses the LFO-modulated pulse
   width; square & saw edges are **polyBLEP** anti-aliased so high pitches don't screech).
5. **Oscillator 2** (optional): a detuned copy blended by `Osc2Mix`, with optional **hard
   sync** (reset osc2 phase whenever osc1 wraps) for tearing sync tones.
6. **Wavefolder** (optional): `sin(osc · (1 + fold·FOLD_GAIN) · π/2)` — folds the wave to
   add harmonics.
7. **Noise** in one of seven colours mixed in at `NoiseLevel`: White; Pink (−3 dB/oct,
   Paul Kellet filter); Brown (−6, leaky integrator); Blue (+3, differentiated pink);
   Violet (+6, differentiated white); Crackle (sparse dust impulses); Metal
   (sample-and-hold decimation).
8. **Layer envelopes**: the tone mix and the noise each get an OPTIONAL independent
   exponential decay (`ToneDecay`/`NoiseDecay`, 0 = follow the amp envelope) applied at
   the source mix — so a hit can be a short noise snap on a long tonal body (kick+click,
   snare) or a short tonal blip under a long noise tail (cymbals). The master ADSR still
   gates the whole voice.
9. **Bitcrusher** (optional): sample-rate **Downsample** (sample-and-hold decimation) then
   **Crush** bit-depth quantisation.
10. **Filter**: TPT/Zavalishin state-variable LP/HP/BP with resonance (cutoff & Q take
    their LFO modulation here), OR **Vowel** mode — three parallel formant bandpasses
    (F1/F2/F3 from the `VOWELS` table) whose morph position (A→E→I→O→U) is the
    log-mapped Cutoff, so a filter LFO literally makes the sound talk.
11. **Click transient layer** (optional): a few-ms one-shot burst (`ClickLevel`,
    `ClickType`: Tick = violet spike ~1.5ms, Snap = white burst ~6ms, Knock = sine thud at
    2× pitch ~12ms, Blip = 1.1kHz sine ping ~4ms, Clank = S&H metal grit ~8ms; decays in
    `CLICK_DECAY`). Injected **after** the main filter (an LP body can't dull it) and
    before drive/comb (drive glues it in, and it can pluck the resonators).
12. **Drive** (optional): `tanh(x · (1 + drive·5))`.
13. **Karplus-Strong / comb resonator** (optional): a fractional-delay feedback loop with
    a one-pole damping filter and `tanh` soft-clip, tuned to `freq · CombTune`. Low
    feedback = a pluck; high feedback (`CombDecay→1`) = a sustained string.
14. **Modal resonator bank** (optional): up to 6 two-pole resonators at a material's
    mode ratios (`MODAL_TABLES`: Membrane, minor-third Bell, free Bar, Bowl with beating
    detuned pairs, inharmonic Plate), tuned to the note, decay scaled by `ModalDecay`
    (`4^(2(v−0.5))`). Modes above 0.45·sr are dropped (auto-darkening). Unit-order mode
    gains suit impulsive excitation; a `tanh` on the summed output bounds sustained
    resonance (reads as an overdriven ringing bell). Mixed like the comb.
15. **Amp ADSR** × amp LFO **× per-hit velocity**. Segments are **shaped**: each
    advances a linear phase `t` and maps it through a power curve
    (`shapeExp(s) = 4^(2s−1)`, so shape 0.5 = exponent 1 = exactly linear). Attack =
    `t^aExp`; decay = `sustain + (1−sustain)·(1−t)^dExp`; release reuses the decay shape
    from the current value. Segment TIMES are unchanged by the shape — only the contour
    bends. The note-off fires after `gate` samples; the voice deactivates when the
    envelope reaches 0. A **ratchet** schedule re-strikes the envelope (and pitch/click/
    layer transients) every `interval` samples, each sub-hit ×0.85 quieter, re-arming its
    own gate.

### 4.3 Channel chain (after summing 6 voices)

Per `Channel`: **feedback Echo** → **Freeverb reverb** (port of `juce::Reverb`: 8 combs
+ 4 allpass, mono) → **Volume** → **constant-power Pan** into the STEREO master. FX
params are read live from the channel's current snapshot (never from the triggering
note), so a pitched hit never clobbers the base sound.

- **Echo delay** is `EchoTime` seconds when `EchoSync` = Free, else a tempo division
  (`ECHO_SYNC_BEATS · 60/bpm` — the engine owns the tempo). Buffer = 1.3s (longer
  synced delays clamp).
- **Ping-pong** (`EchoPing`): the mono echo is replaced by two cross-fed delay lines —
  dry (panned) feeds L, L feeds R, R feeds back into L·fb — so repeats bounce wide
  regardless of the dry pan. Lines are allocated lazily per channel.
- **Pan** is normalised so a CENTRED sound sums into L/R at exactly the old mono level
  (legacy projects sound identical); hard-panned sides gain +3dB.

The stereo master bus gets a per-side **soft-knee clip** before output: linear
(transparent) below `CLIP_KNEE = 0.9`, tanh-rounded above with peaks asymptoting to ±1,
so stacked resonant/driven channels saturate gently instead of hard digital clipping at
the DAC. The offline WAV export renders through the same path (and writes stereo).

### 4.3b Per-hit Life & choke groups

`perHit(snap, isAccent)` rolls each scheduled hit ONCE at trigger time (plain
`Math.random` — live feel, not sound design): the cycle's first hit is the **accent**
and other hits duck by `AccentAmount·0.5`; a hit failing its `HitChance` roll becomes a
**ghost** at 0.3 velocity half the time and is dropped otherwise; **Humanize** jitters
velocity ±25%, pitch ±1.5% and cutoff ±20% (on the per-hit snapshot copy only); and
**Ratchet** turns the hit into a 2/3/4-strike burst across the step (weighted 50/30/20).
Velocity multiplies the voice output. When a sound with a **ChokeGroup** triggers, every
other sound in that group gets a fast 20ms release (closed hat chokes open hat) — set
per sound, never shuffled.

### 4.4 Dynamic channel allocation

There are 32 physical channels but many more distinct sounds. `allocate(id)` reuses the
channel already bound to `id`, else a free channel, else **steals the most idle** one
(scored by `hasActiveVoices ? 1e15 : 0 + busyUntil`, so long-ringing sounds are protected
— their `tail` pushes `busyUntil` later). Stealing resets that channel's FX so the old
tail doesn't bleed. A reserved id (`AUDITION = -2`) is used for one-shot previews.

### 4.5 Melody key mapping (manual grids + parity)

For **manual** grids only, `frequencyFor(row, root, scale, lo, hi)` maps a grid row to a
scale degree and centres it inside the sound's Pitch range (octave-shifted to the range
centre). Scales: Major, Minor, Major/Minor pentatonic. The same math exists in
`melodyScale.ts` for UI note labels. **Euclidean voices play their sound as-is** (no key
mapping) — each voice carries its own pitch character from its snapshot.

---

## 5. Data model & persistence

### 5.1 Arrangement (`melodyGrid.ts`)

- `WipArrangement` holds **6 `MelodyGrid`s** and an **`order: Int8Array(20)`** (each slot
  = grid index 0–5, or `-1` empty). Defaults: 6 empty grids, `order[0] = 0`.
- A `MelodyGrid` in **Euclidean mode** (default) has **5 `EuclidVoice`s**:

  ```ts
  interface EuclidVoice {
    soundId: number;      // -1 = empty slot (no circle, no audio)
    snapshot: number[];   // the synth parameter snapshot
    color: string;        // ring/title colour (VOICE_COLORS[slot])
    name: string;         // auto-generated recap string
    pitch: [number, number];
    hits: number; steps: number; rotation: number; // Euclidean rhythm
    split?: number;       // uneven primary-gap override (undefined = even spread)
    mute?: boolean; solo?: boolean;                // mixer state
    preset?: string; ranges?: {lo:number[]; hi:number[]}; // shuffle-editor state
  }
  ```

  (A grid also keeps legacy manual state: `cells:Int16Array(5×16)`, `root`, `scale`,
  `keyEnabled`, `keyedDrums` — retained for back-compat, unused by the UI.)

- `blocksMessage()` serialises grids for the worklet, **precomputing** each assigned
  voice's boolean Euclidean pattern into `{soundId, steps, pattern:number[]}` (so the
  worklet stays pattern-only). Empty voices are filtered out.

### 5.2 Snapshots & the kit

`DrumKit` holds a `DrumParameters` per drum **character**. In the Euclid UI the kit is
used as a **parameter-spec provider + shuffle engine** for a single reference drum
(`DrumType.Kick` opened on the **Full Range** preset), one throwaway kit per voice editor.
`DrumParameters` stores `values[]`, plus a per-parameter **shuffle window** `lo[]/hi[]`
(set by the active preset). `set()` clamps to the **absolute** base range, so manual entry
can exceed a preset window but never break the engine.

### 5.3 Persistence (`project.ts`)

`serialize`/`deserialize` to `ProjectJSON` (**version 7**) covering: tempo, all 6 grids
(cells, root/scale/key, euclid flag, voices), the 20-slot order, and the drum kit
(snapshots + ranges + preset names). Autosaved to `localStorage["msq010.project"]`
(debounced 300 ms) and available as **Save/Load JSON file**. Deserialize includes
migrations from v1–v7 (e.g. pre-v5 stored the sound id under `drum`; v6 added voices; v7
added split + inline-shuffle editor state).

---

## 6. Sequencer & timeline (the heart of playback)

### 6.1 Euclidean patterns (`euclid.ts`)

- `euclidPattern(hits, steps, rotation)` — an even **Bresenham spread** with the downbeat
  on step 0 (`step i is a hit when (i·hits) mod steps < hits`), then rotated by `rotation`.
- `splitPattern(hits, steps, gap, rotation)` — an **uneven** split: the first `hits−1` gaps
  are `gap` steps, the last gap takes the remainder (e.g. 3/16 as 6·6·4). `evenGap =
  floor(steps/hits)`; `maxSplitGap = floor((steps−1)/(hits−1))`.
- `voicePattern(hits, steps, rotation, split?)` picks even (no `split`) vs split.
- `MAX_STEPS = 64`. New voices start blank (`hits=steps=0`, silent) until dialed in.

### 6.2 Timeline: runs, continuous polymeter, and chaining truncation

Implemented in `engine.js fireStep`/`buildTimeline`, and mirrored for the loop-length
display in `melodyGrid.ts loopSteps()`. This is the defining behavior of the app — read
carefully.

- A step counter **`absStep` is monotonic** (reset only on play/restart, never at the loop
  wrap). Position within the loop is `pos = absStep % total`. Because per-voice phase is
  read from this continuous counter, **a voice's cycle never resets at the grid-loop
  boundary — this is true polymeter.** A 14-step voice against a 16-step voice keeps
  rolling (…13, 0, 1 while the 16 finishes its last two) instead of restarting every 16.

- The order is grouped into **runs**: a run is a maximal group of **consecutive identical
  grid slots**. A run plays continuously for `slots × referenceSteps` steps, where
  **`referenceSteps` = the step count of the grid's first assigned voice** (the "reference
  voice" that connects to the next grid). Placing the same grid in two consecutive slots
  makes a run of `2 × referenceSteps`.

- **Hard boundary (chaining to a different grid).** At a run's end (the next run is a
  different grid), any voice whose current cycle would **overrun the run length is
  dropped** for that cycle — "remove that voice's last sequence". The reference voice
  always fits (its length divides the run length). Example: grids `[A, A, B]` with A's
  voices 16 (reference) and 14 → A runs 32 steps continuously; the 14-voice fires steps
  0–27 (two full cycles) and is **silent 28–31** because a third cycle can't finish before
  B starts at 32.

- **Soft boundary (a single grid filling the whole order).** With one run, the loop length
  becomes the **LCM of that grid's voice step counts** (capped at 1024) so every voice's
  phase realigns at the wrap and there is **no truncation** — pure continuous polymeter.
  Example: a lone grid with voices 16 & 14 loops every **112** steps.

- **Staging.** Edits while playing are staged and promoted at the loop boundary
  (`pos == 0`); for soft single-grid loops they're also promoted at each reference-voice
  downbeat so live edits still take effect promptly.

- Step timing: 16th notes → `samplesPerStep = sampleRate·60/bpm/4`. Each fired step holds
  its notes for `STEP_GATE_SEC`.

### 6.3 Play source: solo a grid vs. play the loop

The play source is **derived from the selected workspace** (`app.ts effectiveOrder()`):

- Selecting a **numbered grid button (1–6)** sends the engine an order of just that grid
  → **solo playback** of that pattern, ignoring the loop order. While playing, the switch
  is sent with `restart:true` so it jumps to that grid from step 0 immediately.
- The **↻ (Loop) button** shows the order editor and sends the real 20-slot order.

The numbered button is simultaneously the **edit target** and the **solo source**, and its
title fills with the grid's identity colour when selected.

### 6.4 Transport & tempo

- Play/Stop toggles `engine.play()/stop()`. Play always starts the current source from
  step 0.
- Tempo is a **slider (60–200)** plus a **manual number box (20–300)**; the two stay in
  sync (the slider thumb clamps to its own range while the box may go wider).

### 6.5 WAV export

Menu → **Export WAV** prompts for a number of loop repeats, then `renderToBuffer()`
renders `loops × loopSteps` steps of the **loop-order arrangement** offline (faster than
realtime) through the same engine, appends a tail sized to the longest sound so FX ring
out, encodes 16-bit PCM stereo WAV (`wav.ts`), and downloads `euclid-song.wav`. Mixer
mute/solo is respected (muted channels are rendered with Volume 0).

---

## 7. Shuffle — exploring the sound-verse

Shuffle randomises a voice's **entire** sound at once. It's the primary way sounds are
made. Implemented in `drumKit.ts` (`randomize` / `shuffleAll`).

- **Presets are windows.** A preset carries both **values** and a per-parameter **range
  window** (`lo/hi`). `FACTORY_PRESETS` = 12 drum characters + **Full Range**. A character
  preset **locks its discrete Wave/Filter/Noise-colour type** (window `lo==hi`) so
  shuffles stay in character, while keeping the "open" discrete params (LFO destinations
  + click type — spice, not identity) and continuous params full-window; a drum that
  explicitly **narrows** a discrete range keeps that window instead of locking (the
  Wobble's `Lfo1Sync` shuffles within 1/16..1/4, so its wobble speed varies but always
  stays on the beat); **Full Range** opens every window to the absolute base range for
  open-ended exploration.
- **Randomness amount (0–1).** Each continuous value is drawn from `cur` lerped toward the
  window edges by `randomness` (0 = no-op, 1 = full window). Each discrete "type"
  parameter rerolls within its window with probability `randomness`.
- **Spread (frequency curve).** Pitch & Filter Cutoff are drawn through a chosen
  `FreqCurve` — Linear (uniform in Hz), Logarithmic (equal per octave), or Gaussian
  Bass/Mid/High — so picks land the way the ear hears pitch instead of clustering in the
  perceptual highs.
- **Shaped draws.** A few parameters get non-uniform draws: `NoiseLevel` is
  `low + r^2·span` (average ~1/3 of the window — quiet hiss common, loud occasional;
  `NOISE_LEVEL_BIAS = 2`); `ClickLevel` likewise biased quiet (`CLICK_LEVEL_BIAS = 1.6`);
  `AmpDecayShape` is biased toward the percussive end (`hi − r^1.7·span`, mean ≈ 0.63 —
  real drums decay exponentially, gated shapes stay rare-but-reachable); the layer decays
  `ToneDecay`/`NoiseDecay` snap to the window's low edge (= off, follow amp) with
  probability 0.7/0.5 so classic single-envelope voices stay common and layered designs
  arrive as a deliberate minority; the Life params lean subtle (Accent `r^1.3`, Humanize
  `r^1.5`, Ratchet `r^2.5`, HitChance hugging 1 via `hi − r^2.2·span`); and `Pan` draws
  triangular around the centre (`(r+r)/2`) so the stereo field stays balanced.
- **Pitch snap.** After the draw, the landed Pitch can quantise to the nearest
  **semitone** or to the nearest note of the current grid's **key** (root + scale), and
  the tuned companions snap consonant: `Osc2Detune` to whole semitones, `CombTune` to
  just-intonation ratios, `OscModRatio` to half-integer (harmonic) steps — so tonal
  voices land in tune with each other.
- **Seeded shuffles.** Every draw goes through a swappable RNG; a seed string (xmur3 →
  mulberry32) makes the whole shuffle deterministic. At 100% randomness the draw no
  longer depends on pre-shuffle values, so *seed + preset window = the same sound on any
  device* — seeds are shareable. The UI rolls and shows a fresh 6-char seed per shuffle.
- **Crossbreed.** `breedFrom(other)` replaces the sound with a child of it and another
  voice's sound: discretes coin-flip a parent, continuous params inherit one parent
  (60%) or a random blend (40%), then ~25% of them get a ±6%-of-range mutation. Volume
  and ChokeGroup stay ours (mix state / kit wiring, not genes). Runs the same
  audibility + harshness post-passes; fully undoable.
- **Sparsity.** There are **18 toggleable modules** (3 LFOs, FM/Ring, Osc2/Sync, Fold,
  Comb, Modal, Crush, Downsample, Click, Drive, Pitch-punch/Rise, Echo, Reverb, Accent,
  Ghosts, Ratchet). After the draw, Shuffle switches a random subset **off** so the
  number of simultaneously active modules **varies per shuffle** — weighted toward a
  handful (≈3–6), sometimes 1, occasionally up to a dozen. The core tone (oscillator,
  pitch, noise level) and amp envelope are never disabled. Higher randomness enforces
  the budget more strictly.
- **Duplicate-LFO de-dup.** Two LFOs aimed at the same destination collapse (the later
  one is set to "None").
- **Audible-level floor.** If a wide draw leaves both source levels low, or the filter
  cutting the fundamental, the louder of Tone/Noise is lifted to a floor (`0.6`, keeping
  their balance) and a pathological cutoff is pulled back so the fundamental passes — no
  near-silent results, without flattening dark/bright variety.
- **Harshness guard** (`tameHarshness`, shuffle-only — manual editing is never limited).
  The floor's counterpart: independent draws sometimes stack extremes into screech, so
  each stack gets a targeted cap while individual extremes stay reachable:
  **equal-loudness tilt** (`ToneLevel × (400/pitch)^0.3`, floored at 0.35, above 400 Hz —
  a 2 kHz tone reads far louder than a 60 Hz one at equal amplitude); **noise-colour
  gains** (Blue ×0.65, Violet ×0.5, Metal ×0.7 — differentiated spectra pierce);
  **resonance scream guard** (allowed Q shrinks from 8 to 2.8 as the cutoff nears the
  ear's most sensitive band, log-Gaussian around 4.5 kHz; ×0.85 for HP/BP); **FM
  bandwidth cap** (Carson's rule: trim `OscModAmount` so `(β+1)·pitch·ratio ≤ 9 kHz`,
  β = amount·FM_INDEX; ring mod scaled likewise); **crush cap** (above 1 kHz pitch,
  Crush/Downsample indices clamp to ≤3 — decimation images of high tones are pure
  shriek); **bass stays centred** (below 150 Hz pitch, Pan is pulled ×0.3 toward the
  middle so a hard-panned kick can't lurch the mix).
- **Max length.** An optional cap on a hit's estimated audible length; Shuffle trims
  tails first (a free echo shortens, a synced echo steps down to the longest division
  that fits, reverb shrinks, the modal ring tightens), then scales the amp body, to
  fit. `estimateLength(snap, bpm)` is tempo-aware for synced echoes and includes the
  modal ring (also sizing the engine's channel-steal "tail").
- **Undo / Reset / recap.** A 20-deep undo stack captures values + ranges, so **Back**
  reverses the last shuffle/preset/reset exactly; **Reset** returns to the active preset's
  values. `describe()` produces a one-line recap of the sound (wave, pitch, noise colour,
  envelope character — `Punchy`/`Gated` when the decay shape leaves linear, `T-env`/
  `N-env` when a layer decays independently — active modules incl. the click type, and
  estimated length), e.g. `Square · 180 · Crackle · Punchy · N-env · Snap · Comb · 1.96s`.

### How big is the sound-verse? (marketing/intuition)

Counting only the exposed choices for one voice: 18 on/off modules → 262,144 module
combinations; the discrete "type" switches alone (4 waves, 4 filters, 5 click types, 5
modal materials, 9 echo syncs…) → ≈10¹² setups before a single continuous knob moves;
including every continuous parameter at on-screen resolution → roughly **10⁹⁹ distinct
settings per voice** — about a googol of drums, versus ~10¹⁹ grains of sand on Earth.
Neighbouring settings often sound alike, but it's why Shuffle keeps surprising.

---

## 8. UI

Dark theme tokens in `:root` (`--bg #15161a`, `--panel`, `--panel2`, `--line`, `--text`,
`--muted`, `--accent #ffd60a`). Identity palettes: `GRID_COLORS[6]` (per pattern),
`VOICE_COLORS[5]` (per voice slot). Layout is a sticky top bar + a scrolling `main`.

### 8.1 Start gate

A full-screen **▶ Start** button. The `AudioContext` can only be created from a user
gesture (iOS/Chrome autoplay policy), so nothing runs until Start. On start it loads the
saved project (or seeds a random Full-Range default) and shows the main view.

### 8.2 Top bar

The dot-and-line `Euclid` wordmark (`logo.ts`, one voice colour per letter) ·
**transport** (round green Play ▶/■, the tempo slider drawn as a **white dot on a thin
white line**, and the BPM value in a white circle) · a round purple **menu ≡** (New
project, Save to file, Load from file, **Export WAV**). Toolbar buttons throughout are
**circles**, each ringed in its own colour (play green, menu purple, loop ↻ accent,
mixer blue, remove × red, patterns 1–6 in their grid colours).

### 8.3 Steps view (the default)

- **Pattern bar**: circular buttons **1–6** (select + solo a grid; each is ringed in its
  grid colour, dim until selected) and a round **↻** (loop/order view).
- **Circle visualization** (`euclidView.ts`): 6 nested rings (inner = voice 1). Each
  assigned voice draws a dot at every step around its ring in the voice's colour, with a
  radial line to the centre on each hit; the current step lights up white during playback
  (highlight = `playStep % steps`, so continuous polymeter shows correctly).
- **Voice menu**: six rows. Each row has:
  - a **title button** filled with the voice's ring colour (dark text) showing its name —
    tap to open the **inline shuffle menu**;
  - **Hits / Steps / Start / Split** drawn as the sequencer's own language: four
    voice-coloured **circles joined by a line** (`.euclid-vals::before`; dim grey when
    the slot is empty) — tap to type, or **click-hold and drag vertically to scrub**
    (`±1` per ~7 px). Split is disabled unless there are ≥2 hits and room to vary the
    gap; its tooltip shows the gap composition (e.g. `6·6·4`);
  - a small round **×** remove button sitting on the same line (when the slot is filled).
- A round blue **🎚** mixer button.

### 8.4 Inline shuffle menu (`voiceShuffleMenu.ts`)

A popup anchored under the voice title, dismissed on outside tap: big **🎲 Shuffle**, the
recap line with a **▶** re-audition, **Back/Reset**, a **Randomness** slider, **Spread**,
**Max len** and **Snap** selects (pitch quantisation Off/Semitone/Key), a **Seed** text
row (type to repeat a shuffle exactly; empty rolls fresh and shows the seed used), a
**🧬 Breed with…** button (when other voices of the grid have sounds) listing them as
coloured tiles — picking one crossbreeds the two sounds — a **Presets** button revealing
the character-window grid, and **Full Parameters** (opens the deep editor). Every change
writes the sound back into the voice, resends the sound table (the engine swaps it in on
the voice's next "on" step), persists, redraws the circle, and auditions once.

### 8.5 Sound view (`soundView.ts`)

The full per-parameter editor for one voice: parameters grouped (Tone / Amp / Filter / LFO
/ Drive & FX / Per-Hit Life / Output), each with a slider + manual numeric entry (clamped
only to the absolute base range) and, for the LFO block, three independent destination
sections. Same Shuffle/Back/Reset/Randomness/Spread/Max-len/Snap/Seed controls; works
live (no saved-sound library).

### 8.6 Order / Loop view

Shows the **loop length** (seconds · steps, from `loopSteps()`), a **grid palette** (pick a
pattern colour as the brush), and the **20-slot grid** (tap a slot to place the brush,
tap again to clear). The currently playing slot is outlined during playback.

### 8.7 Mixer view

One strip per assigned voice: a colour **flash LED** (pulses when the voice triggers, from
the `playhead.fired` list), the name, **Mute/Solo** toggles, and **Volume + Reverb + Pan**
faders (Pan is bipolar and reads `L30 / C / R30`; writing it pads short legacy snapshots
with param defaults first). Mute/solo are applied at push time by zeroing Volume; when any
channel is soloed, only soloed channels are audible.

---

## 9. Build, run, deploy

```bash
npm install
npm run dev      # Vite dev server (host:true for LAN/mobile testing)
npm run build    # tsc typecheck + vite build → dist/
npm run preview  # preview the production build
```

- The worklet has a **fixed (non-hashed) filename**, so the service worker serves it
  **network-first** (like HTML navigations) — a stale engine must never keep running
  against a new message protocol. Hashed assets are cache-first.
- CI (`.github/workflows/deploy.yml`) builds and deploys `dist/` to GitHub Pages on every
  push to `main`.

---

## 10. Recreation checklist (minimum viable Euclid)

1. Vite + TS scaffold, `base:"./"`, single `App` class rendering to `#app`, dark stylesheet.
2. Port `engine.js` verbatim: voice chain (§4.2), channel FX (§4.3), 32-channel dynamic
   allocation (§4.4), and the **run-based polymeter sequencer** (§6.2) with a monotonic
   `absStep`, hard-boundary truncation, and soft single-grid LCM loops.
3. `EngineHost` message wrapper + `OfflineAudioContext` render via `processorOptions`.
4. Param model: `ParamId` (append-only), per-drum `paramSpec` ranges, `presets`
   (character windows + Full Range), and the **Shuffle** algorithm with sparsity, noise
   bias, audible-level floor, max-length, and 20-deep undo (§7).
5. `euclid.ts` pattern generation; `MelodyGrid`/`WipArrangement` with 6 voices per grid and
   a 20-slot order; `blocksMessage()` precomputing patterns; `loopSteps()` mirroring the
   engine timeline.
6. UI: start gate; transport with editable BPM; pattern bar with **per-grid solo + loop**;
   circular visualization; per-voice rows with drag-scrub Hits/Steps/Start/Split and the
   inline shuffle menu; order editor; mixer; full sound editor.
7. Versioned `localStorage` + JSON save/load; **Export WAV**; PWA manifest + network-first
   service worker; GitHub Pages workflow.
