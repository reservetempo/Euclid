# Euclid

A synthesised melody-grid drum machine for the web — a fork of *MobileSequencer
010*, itself a mobile-focused port of the JUCE desktop app *Sequencer 010*. Every sound is generated procedurally (no
samples) by a single AudioWorklet; you paint melodies across chained 16-step grids
using any drum's timbre, pitched to a chosen key and scale.

## Features

- **Five drum slots**, each loadable with any of twelve preset characters (Kick,
  Snare, Clap, Closed/Open Hat, three Toms, Rim, Cowbell, Wobble, Synth Bass) — or
  a fully shuffled one-off sound.
- **Steps view** — paint notes across the grid; each painted row plays the slot's
  sound pitched to the grid's Root + Scale (or as-is with Key off). Grids chain into
  one loop via the order list.
- **Sounds view** — a full per-parameter editor with one-tap **Shuffle / Back /
  Reset**, a Randomness amount, frequency Spread and Max-length controls, plus
  saving and recalling named sounds organised into collapsible folders.
- **Save/load** projects (localStorage autosave + JSON file), installable PWA with
  offline support.

## Sound generation

All synthesis lives in [`public/worklet/engine.js`](public/worklet/engine.js), a
hand port of the original C++ engine that runs verbatim in the audio thread (no
bundler). The main thread owns the parameter ranges/defaults and sends each drum a
flat float **snapshot**; the worklet turns one snapshot into a polyphonic voice.

Each **voice** is processed sample-by-sample through this chain:

1. **Oscillator 1** — sine, triangle, or square (square has LFO-modulatable pulse
   width).
2. **FM / ring modulation** — an optional second sine *operator* at `pitch × ratio`
   that either phase-modulates the carrier (FM) or multiplies it (ring mod),
   opening metallic and inharmonic timbres.
3. **Oscillator 2** — an optional detuned second oscillator, with optional **hard
   sync** to oscillator 1 (classic tearing sync sweeps; small detune = thickness).
4. **Wavefolder** — folds the wave back on itself to add harmonics (west-coast
   style), bypassed at zero.
5. **Noise** in one of seven colours — White, Pink (−3 dB/oct), Brown (−6),
   Blue (+3), Violet (+6), Crackle (sparse dust impulses), or Metal
   (sample-and-hold decimation).
6. **Tone/noise mix**, then an optional **bitcrusher**: sample-rate **Downsample**
   (decimation) followed by **Crush** bit-depth reduction for lo-fi grit.
7. **State-variable filter** — low-/high-/band-pass with resonance.
8. **Drive** — `tanh` saturation.
9. **Karplus-Strong / comb resonator** — a tuned feedback delay line excited by the
   signal so far. With a short envelope it behaves like a plucked/struck string;
   with high feedback it rings like a sustained string. Tuned to the note pitch ×
   `Comb Tune`.
10. **Amp envelope** (linear ADSR) and per-note **pitch envelope**.

Three independent **LFOs** run alongside, each with its own shape
(Sine / Tri / Saw / Square / **Sample-&-Hold**), rate, depth, and destination
(Pitch, Filter, Amp, Drive, Resonance, or pulse-Width). Duplicate destinations are
de-duplicated so two LFOs never fight over the same target.

Per **channel** (after the voices are summed) come the shared effects: a mono
feedback **echo**, a Freeverb **reverb**, and the output **volume**.

The parameter list is **append-only** — every index in
[`src/model/params.ts`](src/model/params.ts) lines up with the `P` map in the
worklet, so old saved sounds keep working as new modifiers are added (they just
default the new tail to "off").

## Shuffle — exploring the sound-verse

Shuffle is the heart of the app: it randomises a drum's whole sound at once so you
can hunt for timbres you'd never dial in by hand.

- **Presets as windows.** Applying a preset sets both the sound *and* a per-parameter
  **range window** (`lo`/`hi`). Shuffle draws inside that window, so a character
  preset (e.g. Kick) stays in character while **Full Range** opens every window wide
  for true open-ended exploration. A locked window (`lo == hi`) holds that parameter
  fixed.
- **Randomness amount.** A single slider sets how far each value can jump from its
  current setting toward the window edges — 0 % is a no-op, 100 % draws across the
  full window.
- **Spread.** Pitch and filter cutoff are drawn through a chosen frequency curve
  (Linear / Logarithmic / Bass / Mid / High) so picks land the way the ear hears
  pitch instead of clustering in the perceptual highs.
- **Sparsity — random number of active modules.** There are thirteen toggleable
  effect/filter/modulation modules (3 LFOs, FM/ring, Osc2, fold, comb, crush,
  downsample, drive, pitch-punch, echo, reverb). After the draw, Shuffle switches a
  random subset of them off so the count of simultaneously active modules **varies
  per shuffle** — usually a handful (≈3–6), sometimes as few as one, occasionally up
  to a dozen for a dense result. The core tone (oscillator, pitch, noise level) and
  amp envelope are never switched off. Higher Randomness enforces the budget more
  strictly.
- **Audible-level floor.** A wide draw can land both source levels low, or set the
  filter to cut the fundamental, which would come out near-silent. Shuffle lifts the
  louder of Tone/Noise up to a floor (keeping their balance) and pulls a pathological
  filter cutoff back so the fundamental still passes — so results stay roughly level
  without losing dark/bright/dull variety.
- **Max length.** An optional cap on a hit's estimated audible length; Shuffle trims
  the longest tail first (echo, then reverb), then the amp body, to fit — handy for
  keeping drums punchy.
- **Recap line.** After each shuffle a one-line summary names the main settings
  shaping the sound — wave, pitch, noise colour, every active module, and the
  estimated length, e.g. `Square · 180 · Crackle · Comb · 1.96s`. A ▶ button
  re-auditions it.

**Back** undoes the last shuffle/preset/reset (20-deep), **Reset** returns to the
active preset's values, and **Save** stores the current sound (named + coloured)
into the slot's library.

## How big is the sound-verse?

Counting only the choices the engine exposes for a single voice:

- **13 effect/filter modules**, each of which can be on or off → **8,192** distinct
  active-module combinations.
- The discrete "type" switches alone — waveform, filter type, the three LFO
  destinations and shapes, noise colour, FM/ring mode, crush and downsample depths,
  and oscillator sync — give **1,037,232,000** (≈ 1.04 billion) distinct setups
  *before a single continuous knob is touched*.
- Including every continuously-variable parameter at its on-screen resolution
  (pitch, tone/noise levels, both envelopes, filter cutoff/resonance, the three LFO
  rates and depths, FM ratio/amount, osc-2 detune, comb tuning, drive, echo, reverb,
  …), one drum slot can take roughly **7 × 10⁷³ distinct parameter settings** — far
  more than the grains of sand on Earth (~10¹⁹) or the stars in the observable
  universe (~10²⁴).

These count distinct *settings*, not perceptually distinct sounds — many neighbouring
settings sound alike — but it's why Shuffle keeps turning up timbres you've never
heard. (And that's per voice: a project layers five independent slots, each pitched
across the scale.)

## Develop

```bash
npm install
npm run dev      # local dev server
npm run build    # typecheck + static production build -> dist/
```

Deploys automatically to GitHub Pages via `.github/workflows/deploy.yml`.
