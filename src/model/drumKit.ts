// Editable, stateful drum parameters + global randomise/undo controls.
// Port of DrumParameters.cpp + DrumKit.h (minus the Markov "Evolve", which was
// never implemented in the C++ either). Each drum now also carries a live shuffle
// window (lo/hi per param) that a preset sets — so any slot can take on any
// character and "Full Range" can open the window wide.

import { DrumType } from "./drums";
import { ParamId, NUM_PARAMS } from "./params";
import {
  getParamSpec, baseRange, isDiscrete, LFO_TARGETS, OSC_MOD_TYPES, NOISE_TYPES, CLICK_TYPES,
  MODAL_MATERIALS, ECHO_SYNC_BEATS,
} from "./paramSpec";
import { intervals } from "./melodyScale";
import { Preset, defaultPresetFor, FACTORY_PRESETS } from "./presets";

export type Snapshot = number[];

// The random source every shuffle draw goes through. Normally Math.random; a seeded
// generator is swapped in for the duration of a seeded shuffle so the same seed +
// same preset window reproduces the same sound (exact at 100% randomness, where the
// draw no longer depends on the pre-shuffle values).
let rand: () => number = Math.random;

/** Deterministic RNG from a seed string (xmur3 hash into mulberry32). */
export function seededRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h ^= h >>> 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// How a shuffled Pitch is quantised: free Hz, the nearest semitone, or the nearest
// note of a key (root + scale from the current grid). Key/Chromatic also snap the
// musical companions (Osc2Detune to semitones, CombTune to just ratios, OscModRatio
// to harmonic steps) so tuned modules land consonant.
export enum PitchSnap { Off, Chromatic, Key }

export interface ShuffleOptions {
  randomness: number;      // 0..1 draw window (see randomize)
  curve?: FreqCurve;       // frequency-param spread (default Linear)
  maxLen?: number;         // cap on estimated audible seconds (0/undefined = off)
  bpm?: number;            // tempo for synced-echo length estimates (default 120)
  snap?: PitchSnap;        // pitch quantisation (default Off)
  root?: number;           // 0-11 semitone root for Key snap
  scale?: number;          // ScaleType index for Key snap
  seed?: string;           // deterministic shuffle when non-empty
}

// Distribution curve for the Shuffle random draw of FREQUENCY params (Pitch &
// Filter Cutoff). Pitch perception is logarithmic, so a uniform-in-Hz draw
// ("Linear") lands most picks in the perceptual high range — the others reshape
// the draw to spread it the way the ear hears it.
export enum FreqCurve {
  Linear,    // uniform in Hz (legacy behaviour) — high-heavy
  Log,       // equal weight per octave (MIDI-like) — naturally bass-heavier
  GaussLow,  // bell in log-space centred low (bass)
  GaussMid,  // bell centred mid
  GaussHigh, // bell centred high
}

const GAUSS_SIGMA = 0.18; // spread of the Gaussian curves (in normalised log-space)
const GAUSS_MU: Record<number, number> = {
  [FreqCurve.GaussLow]: 0.15,
  [FreqCurve.GaussMid]: 0.5,
  [FreqCurve.GaussHigh]: 0.85,
};

// Downward bias on the shuffled Noise-source level: the draw is `low + r^BIAS * span`
// with r uniform, so the average lands at 1/(BIAS+1) of the window instead of 1/2. This
// keeps quiet/no-noise sounds common and loud hiss occasional, while the full range is
// still reachable. 1 = uniform (no bias); higher = quieter on average.
const NOISE_LEVEL_BIAS = 2; // mean ≈ 1/3 of the window

// Click-layer level gets the same downward treatment — a transient should usually
// season the hit, not dominate it (full-blast clicks stay reachable).
const CLICK_LEVEL_BIAS = 1.6;

// Per-hit Life draw biases: accents/humanize lean subtle, ratchets are occasional
// spice, and hit-chance hugs 1 (most voices play straight; ghost-y voices are the
// exception). Pan draws triangular around the centre so the field stays balanced.
const ACCENT_BIAS = 1.3;
const HUMANIZE_BIAS = 1.5;
const HIT_CHANCE_BIAS = 2.2;
const RATCHET_BIAS = 2.5;

// Just-intonation ratios CombTune snaps to (Key/Chromatic snap): sub-octaves,
// fifths/fourths, thirds, octaves and harmonics — tuned comb hits land consonant.
const JUST_RATIOS = [0.25, 0.5, 2 / 3, 0.75, 1, 1.25, 4 / 3, 1.5, 2, 3, 4];

// Upward bias on the shuffled decay SHAPE: real drums decay exponentially (fast drop,
// long quiet tail = shape > 0.5), so the draw is `hi - r^BIAS * span` — percussive
// shapes are common, linear occasional, gated (hold-then-drop) rare but reachable.
const DECAY_SHAPE_BIAS = 1.7; // mean ≈ 0.63 of the window

// Probability that a shuffle leaves a layer's independent decay OFF (following the
// amp envelope, the classic single-envelope voice). Applied per layer, scaled by the
// window like every draw, so gentle shuffles stay near the current sound.
const TONE_DECAY_OFF_P = 0.7;
const NOISE_DECAY_OFF_P = 0.5;

// --- Shuffle harshness guard --------------------------------------------------
// Caps applied AFTER the draw (shuffle-only — manual editing can still go anywhere).
// Each targets a stacked-extremes screech the independent draws can land on.
const FM_INDEX = 4;            // mirror of FM_INDEX in public/worklet/engine.js
const FM_BW_LIMIT = 9000;      // Hz, Carson-rule cap on FM/ring sideband spread
const TILT_KNEE = 400;         // Hz, equal-loudness tilt starts above this pitch
const TILT_POW = 0.3;          // strength of the (knee/pitch)^pow tone attenuation
const TILT_FLOOR = 0.35;       // never attenuate the tone below this factor
const RESO_SCREAM_HZ = 4500;   // centre of the ear's most sensitive band
const RESO_MIN_Q = 2.8;        // max allowed Q at the centre of the scream band
const PITCH_ENV_PEAK = 6500;   // Hz cap on where a positive pitch env may START (pitch×(1+amt))
const FOLD_KNEE = 600;         // Hz, wavefolding eases off above this pitch
const FOLD_POW = 0.8;          // strength of the (knee/pitch)^pow fold attenuation
const COMB_WHISTLE_HZ = 2600;  // comb resonators tuned above this…
const COMB_WHISTLE_DECAY = 0.55; // …get their ring capped here (long treble ring = whistle)
const MIN_LAYER_DECAY = 0.05;  // s; a dominant layer decaying faster is just a click
// Per-noise-colour level compensation (indexed like NOISE_TYPES): the differentiated
// spectra (Blue/Violet) and S&H grit (Metal) pierce at equal level, so scale them back.
const NOISE_COLOUR_GAIN = [1, 1, 1, 0.65, 0.5, 1, 0.7];

// How many effect/filter "modules" a shuffle leaves active at once (there are 13 in
// all — see soundModules). Weighted toward a handful so a sound is usually doing a
// few things, but it can occasionally run most of them at once for a dense result.
function sparsityBudget(): number {
  const r = rand();
  if (r < 0.08) return 1;
  if (r < 0.24) return 2;
  if (r < 0.44) return 3;
  if (r < 0.62) return 4;
  if (r < 0.76) return 5;
  if (r < 0.86) return 6;
  if (r < 0.93) return 7;
  if (r < 0.97) return 9;
  return 12;
}

// A standard-normal sample via Box–Muller.
function randNormal(): number {
  const u1 = rand() || 1e-9; // avoid log(0)
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// --- Shuffle max-length model ----------------------------------------------
// A rough estimate of a hit's audible length in seconds: the amp body plus the
// dominant FX tail (echo OR reverb, whichever rings longest). Used both to cap
// shuffled sounds and to label them. Constants are tuned by ear, not exact DSP.
const ECHO_EPS = 0.03; // echo repeat quieter than this is inaudible
const VERB_EPS = 0.05; // reverb mix below this adds no usable tail
const RV_BASE = 0.3;   // shortest reverb tail (size 0), seconds
const RV_SPAN = 2.2;   // extra tail at size 1, seconds
// Modal ring-time model, mirroring MODAL_BASE_DECAY and the longest per-material
// decay weight in engine.js MODAL_TABLES; ModalDecay scales it by 4^(2(v-0.5)).
const MODAL_RING_BASE = 0.45;
const MODAL_RING_MAX_D = [1, 1.4, 1, 1.6, 0.8]; // Membrane/Bell/Bar/Bowl/Plate

// Ring time of the modal bank for a snapshot (0 when the bank is off/silent).
function modalTail(snap: number[]): number {
  if ((snap[ParamId.ModalMix] || 0) <= 0.02) return 0;
  const mat = Math.round(snap[ParamId.ModalMaterial] || 0);
  const dec = typeof snap[ParamId.ModalDecay] === "number" ? snap[ParamId.ModalDecay] : 0.5;
  return MODAL_RING_BASE * (MODAL_RING_MAX_D[mat] ?? 1) * Math.pow(4, (dec - 0.5) * 2);
}

// How many audible repeats a feedback echo produces at the given feedback/mix.
function echoRepeats(fb: number, mix: number): number {
  if (mix <= ECHO_EPS) return 0;
  if (fb < 0.01) return 1;
  return Math.max(1, 1 + Math.log(ECHO_EPS / mix) / Math.log(fb));
}

/** The echo's effective per-repeat delay in seconds: EchoTime when free, or the
    synced division at the given tempo. Tolerates old snapshots (no EchoSync). */
export function effectiveEchoTime(snap: number[], bpm: number): number {
  const sync = Math.round(snap[ParamId.EchoSync] || 0);
  const beats = ECHO_SYNC_BEATS[sync] || 0;
  return beats > 0 ? (beats * 60) / Math.max(1, bpm) : snap[ParamId.EchoTime];
}

/** Rough audible length (seconds) of a sound from its parameter snapshot: the amp
    body (attack + decay + sustain-weighted release) plus the dominant FX tail
    (echo/reverb). Used for the shuffle recap, the length cap, and the engine's
    channel-stealing "tail" (so long-ringing sounds keep their channel). `bpm` sizes
    a tempo-synced echo's tail (harmless default for free echoes). */
export function estimateLength(snap: number[], bpm = 120): number {
  const body =
    snap[ParamId.AmpAttack] +
    snap[ParamId.AmpDecay] +
    snap[ParamId.AmpSustain] * snap[ParamId.AmpRelease];
  const echoTail =
    snap[ParamId.EchoMix] > ECHO_EPS
      ? effectiveEchoTime(snap, bpm) * echoRepeats(snap[ParamId.EchoFeedback], snap[ParamId.EchoMix])
      : 0;
  const verbTail =
    snap[ParamId.ReverbMix] > VERB_EPS
      ? RV_BASE + snap[ParamId.ReverbSize] * RV_SPAN
      : 0;
  return body + Math.max(echoTail, verbTail, modalTail(snap));
}

// Draw a frequency in [lo, hi] (both > 0) shaped by `curve`. Log/Gaussian options
// work in normalised log-position p∈[0,1] and map back with lo·(hi/lo)^p.
export function sampleFreq(curve: FreqCurve, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  if (curve === FreqCurve.Linear) return lo + rand() * (hi - lo);
  const ratio = hi / lo;
  let p: number;
  if (curve === FreqCurve.Log) {
    p = rand();
  } else {
    const mu = GAUSS_MU[curve] ?? 0.5;
    p = Math.min(1, Math.max(0, mu + GAUSS_SIGMA * randNormal()));
  }
  return lo * Math.pow(ratio, p);
}

// Nearest entry of `table` to `x` in LOG distance (right for ratios/frequencies).
function nearestLog(x: number, table: number[]): number {
  let best = table[0];
  let bestD = Infinity;
  for (const t of table) {
    const d = Math.abs(Math.log(x / t));
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

export class DrumParameters {
  readonly drum: DrumType;
  private values: number[] = new Array(NUM_PARAMS).fill(0);
  private lo: number[] = new Array(NUM_PARAMS).fill(0);
  private hi: number[] = new Array(NUM_PARAMS).fill(1);
  private preset: Preset; // the last applied preset, used by Reset

  constructor(drum: DrumType) {
    this.drum = drum;
    this.preset = defaultPresetFor(drum);
    this.applyPreset(this.preset);
  }

  get(id: ParamId): number {
    return this.values[id];
  }

  /** Write a value, clamped to this param's ABSOLUTE range (baseSpec). Manual entry
      can therefore exceed the active preset's window without breaking the engine. */
  set(id: ParamId, value: number): void {
    const r = baseRange(id);
    this.values[id] = Math.min(r.max, Math.max(r.min, value));
  }

  /** Current shuffle window for a param (the active preset's range). */
  loOf(id: ParamId): number { return this.lo[id]; }
  hiOf(id: ParamId): number { return this.hi[id]; }
  presetName(): string { return this.preset.name; }
  presetColor(): string { return this.preset.color; }

  /** Apply a preset: set the shuffle window AND the values it carries. */
  applyPreset(p: Preset): void {
    this.preset = p;
    for (let i = 0; i < NUM_PARAMS; i++) {
      const id = i as ParamId;
      const r = baseRange(id);
      const lo = p.ranges[i]?.lo ?? r.min;
      const hi = p.ranges[i]?.hi ?? r.max;
      this.lo[id] = Math.min(r.max, Math.max(r.min, lo));
      this.hi[id] = Math.min(r.max, Math.max(r.min, hi));
      this.set(id, p.values[i] ?? getParamSpec(this.drum, id).def);
    }
  }

  /** Adopt a preset as the "active" one for the label + Reset target, WITHOUT
      touching current values/ranges (used on load to restore the saved name). */
  adoptPreset(p: Preset): void {
    this.preset = p;
  }

  /** Reset values back to the active preset's values (keeps its ranges). */
  resetToPreset(): void {
    for (let i = 0; i < NUM_PARAMS; i++) {
      const id = i as ParamId;
      this.set(id, this.preset.values[i] ?? getParamSpec(this.drum, id).def);
    }
  }

  capture(): Snapshot {
    return this.values.slice();
  }

  /** Restore values from a snapshot. Tolerates short (pre-expansion) snapshots and
      JSON null "holes" by filling any missing entry with the param default. */
  restore(snap: Snapshot): void {
    for (let i = 0; i < NUM_PARAMS; i++) {
      const id = i as ParamId;
      const v = snap[i];
      this.set(id, typeof v !== "number" || Number.isNaN(v) ? getParamSpec(this.drum, id).def : v);
    }
  }

  captureRanges(): { lo: number[]; hi: number[] } {
    return { lo: this.lo.slice(), hi: this.hi.slice() };
  }

  restoreRanges(lo: number[], hi: number[]): void {
    for (let i = 0; i < NUM_PARAMS; i++) {
      const id = i as ParamId;
      const r = baseRange(id);
      if (lo[i] !== undefined) this.lo[id] = Math.min(r.max, Math.max(r.min, lo[i]));
      if (hi[i] !== undefined) this.hi[id] = Math.min(r.max, Math.max(r.min, hi[i]));
      // LFO destinations are always fully shufflable; widen any range saved before
      // the "None" option existed so it can be reached again.
      if (id === ParamId.LfoTarget || id === ParamId.Lfo2Target || id === ParamId.Lfo3Target) {
        this.lo[id] = r.min;
        this.hi[id] = r.max;
      }
    }
  }

  /** Randomise ("Shuffle") every randomisable param at once (Volume and ChokeGroup
      are never touched). Continuous params are drawn uniformly from a window:
      current lerped toward each edge of its live (preset) range by `randomness`.
      Discrete "type" params reroll to a random choice within their preset range —
      locked when lo==hi, so a character preset only shuffles its open discretes
      (LFO destinations, click type, modal material, echo sync) while Full Range
      also shuffles waves/filters. The shuffle amount is the probability that each
      discrete param rerolls.

      `curve` reshapes the random draw of the FREQUENCY params (Pitch & Filter
      Cutoff) — see {@link FreqCurve}; `snap` then quantises the landed Pitch to a
      semitone or to a key, and tunes the musical companions (Osc2Detune, CombTune,
      OscModRatio) to consonant steps. `seed` makes the whole draw deterministic.

      After the draw, {@link applySparsity} switches off a random subset of the
      effect/filter modules so a sound is usually only doing 1-3 things at once
      instead of everything at full tilt — the count itself varies per shuffle.
      {@link ensureAudibleLevel} then floors near-silent results (source levels,
      fundamental-killing filters, click-length layer decays) and
      {@link tameHarshness} caps stacked-extreme screech (scream-band resonance,
      runaway FM sidebands, treble-launched pitch envelopes, folded/crushed high
      tones, whistling combs, piercing noise colours, hard-panned bass). The app
      adds a closed loop on top: it renders the result offline and stores a
      loudness makeup gain on the node (see App.normalizeVoice).

      `maxLen` (seconds, 0 = off) caps the estimated audible length at `bpm`: FX
      tails are trimmed first (echo, then reverb), then the amp body, to fit. */
  randomize(opts: ShuffleOptions): void {
    const randomness = Math.min(1, Math.max(0, opts.randomness));
    const curve = opts.curve ?? FreqCurve.Linear;
    if (opts.seed) rand = seededRng(opts.seed);
    try {
      for (let i = 0; i < NUM_PARAMS; i++) {
        const id = i as ParamId;
        const s = getParamSpec(this.drum, id);
        if (!s.randomizable) continue;
        if (isDiscrete(s)) {
          const lo = Math.round(this.lo[id]);
          const hi = Math.round(this.hi[id]);
          if (hi > lo && rand() < randomness) {
            this.set(id, lo + Math.floor(rand() * (hi - lo + 1)));
          }
          continue;
        }
        const cur = this.get(id);
        const lo = cur + (this.lo[id] - cur) * randomness;
        const hi = cur + (this.hi[id] - cur) * randomness;
        const isFreq = id === ParamId.Pitch || id === ParamId.FilterCutoff;
        // Most params draw uniformly from the window; a few get shaped draws:
        // frequency params use the perceptual curve, noise/click levels are biased
        // quiet, the decay shape is biased percussive, the layer decays usually stay
        // off (= follow amp), the Life params lean subtle, and pan hugs the centre.
        let v: number;
        if (isFreq) v = sampleFreq(curve, lo, hi);
        else if (id === ParamId.NoiseLevel) v = lo + Math.pow(rand(), NOISE_LEVEL_BIAS) * (hi - lo);
        else if (id === ParamId.ClickLevel) v = lo + Math.pow(rand(), CLICK_LEVEL_BIAS) * (hi - lo);
        else if (id === ParamId.AmpDecayShape) v = hi - Math.pow(rand(), DECAY_SHAPE_BIAS) * (hi - lo);
        else if (id === ParamId.ToneDecay) v = rand() < TONE_DECAY_OFF_P ? lo : lo + rand() * (hi - lo);
        else if (id === ParamId.NoiseDecay) v = rand() < NOISE_DECAY_OFF_P ? lo : lo + rand() * (hi - lo);
        else if (id === ParamId.AccentAmount) v = lo + Math.pow(rand(), ACCENT_BIAS) * (hi - lo);
        else if (id === ParamId.Humanize) v = lo + Math.pow(rand(), HUMANIZE_BIAS) * (hi - lo);
        else if (id === ParamId.HitChance) v = hi - Math.pow(rand(), HIT_CHANCE_BIAS) * (hi - lo);
        else if (id === ParamId.Ratchet) v = lo + Math.pow(rand(), RATCHET_BIAS) * (hi - lo);
        else if (id === ParamId.Pan) v = lo + ((rand() + rand()) / 2) * (hi - lo);
        else v = lo + rand() * (hi - lo);
        this.set(id, v);
      }
      this.applyPitchSnap(opts.snap ?? PitchSnap.Off, opts.root ?? 0, opts.scale ?? 0);
      this.dedupeLfoTargets();
      this.applySparsity(randomness);
      if (randomness > 0) {
        this.ensureAudibleLevel();
        this.tameHarshness();
      }
      this.clampLength(opts.maxLen ?? 0, opts.bpm ?? 120);
    } finally {
      rand = Math.random;
    }
  }

  /** Quantise the drawn Pitch to a semitone (Chromatic) or to the nearest note of a
      key (root + scale), and pull the tuned companions onto consonant steps: whole-
      semitone Osc2 detunes, just-intonation comb ratios, half-integer FM ratios.
      Snapped values re-clamp to the base range via set(). */
  private applyPitchSnap(snap: PitchSnap, root: number, scale: number): void {
    if (snap === PitchSnap.Off) return;
    const f = this.get(ParamId.Pitch);
    const midi = 69 + 12 * Math.log2(f / 440);
    let target = Math.round(midi);
    if (snap === PitchSnap.Key) {
      const allowed = new Set(intervals(scale).map((iv) => (root + iv) % 12));
      // Walk outward from the rounded semitone to the nearest allowed pitch class.
      for (let d = 0; d <= 6; d++) {
        const up = Math.round(midi) + d;
        const dn = Math.round(midi) - d;
        if (allowed.has(((up % 12) + 12) % 12)) { target = up; break; }
        if (allowed.has(((dn % 12) + 12) % 12)) { target = dn; break; }
      }
    }
    this.set(ParamId.Pitch, 440 * Math.pow(2, (target - 69) / 12));
    this.set(ParamId.Osc2Detune, Math.round(this.get(ParamId.Osc2Detune)));
    this.set(ParamId.CombTune, nearestLog(this.get(ParamId.CombTune), JUST_RATIOS));
    this.set(ParamId.OscModRatio, Math.max(0.5, Math.round(this.get(ParamId.OscModRatio) * 2) / 2));
  }

  /** Crossbreed: replace the current sound with a child of it and `other`. Discrete
      params coin-flip a parent; continuous params mostly inherit one parent (60%)
      or land on a random blend (40%), then a light mutation jitters a quarter of
      them so children aren't pure interpolations. Volume and ChokeGroup stay ours
      (mix state and kit wiring, not genes). Runs the same audibility/harshness
      post-passes as a shuffle. Tolerates short (older) `other` snapshots. */
  breedFrom(other: number[]): void {
    const MUTATE_P = 0.25;
    const MUTATE_SPAN = 0.06; // jitter as a fraction of the param's base range
    for (let i = 0; i < NUM_PARAMS; i++) {
      const id = i as ParamId;
      if (id === ParamId.Volume || id === ParamId.ChokeGroup) continue;
      const a = this.get(id);
      const b = other[i];
      if (b === undefined || Number.isNaN(b)) continue;
      const s = getParamSpec(this.drum, id);
      let v: number;
      if (isDiscrete(s)) {
        v = rand() < 0.5 ? a : b;
      } else {
        v = rand() < 0.6 ? (rand() < 0.5 ? a : b) : a + (b - a) * rand();
        if (rand() < MUTATE_P) {
          const r = baseRange(id);
          v += (rand() * 2 - 1) * (r.max - r.min) * MUTATE_SPAN;
        }
      }
      this.set(id, v);
    }
    this.dedupeLfoTargets();
    this.ensureAudibleLevel();
    this.tameHarshness();
  }

  /** Keep a shuffled sound from coming out near-silent. Two common causes on a wide
      (Full Range) draw: the Tone and Noise source levels both land low, or the
      filter is set to cut the fundamental (LP below it / HP above it). This lifts
      the louder source up to a floor (preserving the tone/noise balance) and pulls a
      pathological cutoff back so the fundamental still passes — without flattening
      the variety (dark/bright/dull sounds are all still reachable). */
  private ensureAudibleLevel(): void {
    const SRC_FLOOR = 0.6; // the louder of tone/noise reaches at least this
    const tone = this.get(ParamId.ToneLevel);
    const noise = this.get(ParamId.NoiseLevel);
    const peak = Math.max(tone, noise);
    if (peak < 1e-3) {
      this.set(ParamId.ToneLevel, SRC_FLOOR); // both sources silent — give it a voice
    } else if (peak < SRC_FLOOR) {
      const k = SRC_FLOOR / peak;
      this.set(ParamId.ToneLevel, tone * k);
      this.set(ParamId.NoiseLevel, noise * k);
    }

    // Keep the filter from silencing the fundamental (gentle: dark/thin still OK).
    const ftype = Math.round(this.get(ParamId.FilterType));
    const pitch = this.get(ParamId.Pitch);
    const cutoff = this.get(ParamId.FilterCutoff);
    if (ftype === 0 && cutoff < pitch * 0.6) this.set(ParamId.FilterCutoff, pitch * 0.6); // LP
    else if (ftype === 1 && cutoff > pitch * 1.6) this.set(ParamId.FilterCutoff, pitch * 1.6); // HP
    else if (ftype === 2) { // BP: keep the band within reach of the tone
      this.set(ParamId.FilterCutoff, Math.min(pitch * 6, Math.max(pitch * 0.3, cutoff)));
    }

    // A DOMINANT layer whose independent decay landed at a few milliseconds leaves
    // just a click where the whole sound should be — snap it back to "follow the
    // amp" (0). Deliberate clicks stay reachable via a short Amp Decay, and the
    // quieter layer may still tick as seasoning.
    const domDecay = this.get(ParamId.ToneLevel) >= this.get(ParamId.NoiseLevel)
      ? ParamId.ToneDecay : ParamId.NoiseDecay;
    const d = this.get(domDecay);
    if (d > 0 && d < MIN_LAYER_DECAY) this.set(domDecay, 0);
  }

  /** The audible-level floor's counterpart: keep a shuffled sound from coming out
      SCREECHY. Independent draws sometimes stack extremes — high Q parked in the
      ear's scream band, FM sidebands sprayed past 10kHz, piercing noise colours at
      full level, heavy bitcrush on a high tone. Each cap here targets one of those
      stacks while leaving every individual extreme reachable. Shuffle-only: manual
      editing is never limited. */
  private tameHarshness(): void {
    // Equal-loudness tilt: at equal amplitude a 2kHz tone reads far louder (and
    // shriller) than a 60Hz one, so pull ToneLevel down as pitch climbs above the
    // mids. Floored so bright sounds stay present, just not ear-piercing.
    const pitch = this.get(ParamId.Pitch);
    if (pitch > TILT_KNEE) {
      const g = Math.max(TILT_FLOOR, Math.pow(TILT_KNEE / pitch, TILT_POW));
      this.set(ParamId.ToneLevel, this.get(ParamId.ToneLevel) * g);
    }

    // A positive pitch envelope STARTS the note at pitch×(1+amt) — cap that launch
    // point so a bright tone can't open as a 10kHz siren drop. Kick-style sweeps on
    // low pitches are untouched (50Hz × 6 starts at a harmless 300Hz).
    const envAmt = this.get(ParamId.PitchEnvAmount);
    if (envAmt > 0 && pitch * (1 + envAmt) > PITCH_ENV_PEAK) {
      this.set(ParamId.PitchEnvAmount, Math.max(0, PITCH_ENV_PEAK / pitch - 1));
    }

    // Wavefolding multiplies a tone's harmonics upward — folding an already-HIGH
    // tone sprays them across the piercing top octaves, so ease Fold off as pitch
    // climbs (bass folding, the classic use, is untouched).
    if (pitch > FOLD_KNEE) {
      this.set(ParamId.Fold, this.get(ParamId.Fold) * Math.pow(FOLD_KNEE / pitch, FOLD_POW));
    }

    // A long-ringing comb resonator tuned into the treble is a pure whistle — cap
    // its ring time up there (short treble pings and long bass strings both stay).
    if (pitch * this.get(ParamId.CombTune) > COMB_WHISTLE_HZ
        && this.get(ParamId.CombDecay) > COMB_WHISTLE_DECAY) {
      this.set(ParamId.CombDecay, COMB_WHISTLE_DECAY);
    }

    // Bright noise colours pierce at equal level — rebalance so colours shuffle at
    // roughly equal perceived loudness.
    const colour = Math.round(this.get(ParamId.NoiseType));
    const colourGain = NOISE_COLOUR_GAIN[colour] ?? 1;
    if (colourGain !== 1) this.set(ParamId.NoiseLevel, this.get(ParamId.NoiseLevel) * colourGain);

    // Resonance scream guard: allowed Q shrinks as the cutoff nears the ear's most
    // sensitive band (~2-9kHz, worst around 4.5k); HP/BP expose the peak more than LP.
    const cutoff = this.get(ParamId.FilterCutoff);
    const band = Math.exp(-0.5 * Math.pow(Math.log2(cutoff / RESO_SCREAM_HZ) / 1.2, 2)); // 1 at centre
    const { max: qMax } = baseRange(ParamId.FilterReso);
    let allowedQ = qMax - (qMax - RESO_MIN_Q) * band;
    if (Math.round(this.get(ParamId.FilterType)) !== 0) allowedQ *= 0.85; // HP/BP
    if (this.get(ParamId.FilterReso) > allowedQ) this.set(ParamId.FilterReso, allowedQ);

    // FM/ring bandwidth cap. Carson's rule: FM spread ≈ (β+1)·fmod with β = amt·index,
    // fmod = pitch·ratio — keep it under FM_BW_LIMIT by trimming the amount. Ring mod
    // just needs its sidebands (pitch·ratio) kept below the same line.
    const modType = Math.round(this.get(ParamId.OscModType));
    if (modType !== 0) {
      const fMod = pitch * this.get(ParamId.OscModRatio);
      const amt = this.get(ParamId.OscModAmount);
      if (modType === 1) {
        const maxAmt = (FM_BW_LIMIT / fMod - 1) / FM_INDEX;
        if (amt > maxAmt) this.set(ParamId.OscModAmount, Math.max(0, maxAmt));
      } else if (fMod > FM_BW_LIMIT) {
        this.set(ParamId.OscModAmount, amt * (FM_BW_LIMIT / fMod));
      }
    }

    // Heavy bit/rate crushing of an already-high tone is pure shriek (the decimation
    // images land inharmonically in the highs) — ease both off above 1kHz.
    if (pitch > 1000) {
      this.set(ParamId.Crush, Math.min(3, Math.round(this.get(ParamId.Crush))));
      this.set(ParamId.Downsample, Math.min(3, Math.round(this.get(ParamId.Downsample))));
    }

    // Bass belongs in the middle of the stereo field (a hard-panned kick lurches the
    // mix); pull low-pitched sounds most of the way back to centre.
    if (pitch < 150) this.set(ParamId.Pan, this.get(ParamId.Pan) * 0.3);
  }

  /** The toggleable effect/filter/modulation "modules" of the voice, each with its
      display name (for the recap), whether it's currently audible, and how to switch
      it off. The core tone (osc/pitch/wave/noise level) and the amp envelope are NOT
      modules — they always define the sound. Listed in routing order. */
  private soundModules(): { name: string; on: boolean; off: () => void }[] {
    const NONE = LFO_TARGETS.length - 1;
    const g = (id: ParamId) => this.get(id);
    const round = (id: ParamId) => Math.round(g(id));
    const lfo = (t: ParamId, d: ParamId) => ({
      name: LFO_TARGETS[round(t)],
      on: round(t) !== NONE && g(d) > 0.001,
      off: () => this.set(t, NONE),
    });
    return [
      lfo(ParamId.LfoTarget, ParamId.LfoDepth),
      lfo(ParamId.Lfo2Target, ParamId.Lfo2Depth),
      lfo(ParamId.Lfo3Target, ParamId.Lfo3Depth),
      { name: round(ParamId.Sync) >= 1 ? "Sync" : "Osc2",
        on: g(ParamId.Osc2Mix) > 0.02, off: () => this.set(ParamId.Osc2Mix, 0) },
      { name: "Fold", on: g(ParamId.Fold) > 0.02, off: () => this.set(ParamId.Fold, 0) },
      { name: OSC_MOD_TYPES[round(ParamId.OscModType)],
        on: round(ParamId.OscModType) !== 0 && g(ParamId.OscModAmount) > 0.02,
        off: () => this.set(ParamId.OscModType, 0) },
      { name: "Comb", on: g(ParamId.CombMix) > 0.02, off: () => this.set(ParamId.CombMix, 0) },
      { name: MODAL_MATERIALS[round(ParamId.ModalMaterial)],
        on: g(ParamId.ModalMix) > 0.02, off: () => this.set(ParamId.ModalMix, 0) },
      { name: "Crush", on: round(ParamId.Crush) > 0, off: () => this.set(ParamId.Crush, 0) },
      { name: "Downsmpl", on: round(ParamId.Downsample) > 0, off: () => this.set(ParamId.Downsample, 0) },
      { name: CLICK_TYPES[round(ParamId.ClickType)],
        on: g(ParamId.ClickLevel) > 0.02, off: () => this.set(ParamId.ClickLevel, 0) },
      { name: "Drive", on: g(ParamId.Drive) > 0.05, off: () => this.set(ParamId.Drive, 0) },
      // The pitch envelope is bipolar: positive drops from above (punch), negative
      // rises into the note (a reverse-ish swell).
      { name: g(ParamId.PitchEnvAmount) >= 0 ? "Punch" : "Rise",
        on: Math.abs(g(ParamId.PitchEnvAmount)) > 0.1, off: () => this.set(ParamId.PitchEnvAmount, 0) },
      { name: "Echo", on: g(ParamId.EchoMix) > 0.03, off: () => this.set(ParamId.EchoMix, 0) },
      { name: "Verb", on: g(ParamId.ReverbMix) > 0.05, off: () => this.set(ParamId.ReverbMix, 0) },
      // Per-hit Life modules — pattern-domain variation rather than timbre.
      { name: "Accent", on: g(ParamId.AccentAmount) > 0.1, off: () => this.set(ParamId.AccentAmount, 0) },
      { name: "Ghosts", on: g(ParamId.HitChance) < 0.95, off: () => this.set(ParamId.HitChance, 1) },
      { name: "Ratchet", on: g(ParamId.Ratchet) > 0.05, off: () => this.set(ParamId.Ratchet, 0) },
    ];
  }

  /** Turn off a random subset of the active modules so only ~`sparsityBudget()` of
      them stay on. Each disable happens with probability `randomness`, so a gentle
      shuffle rarely strips a module while a full shuffle enforces the budget; at
      randomness 0 (no-op shuffle) nothing is touched. */
  private applySparsity(randomness: number): void {
    if (randomness <= 0) return;
    const active = this.soundModules().filter((m) => m.on);
    const budget = sparsityBudget();
    if (active.length <= budget) return;
    // Fisher-Yates shuffle so the kept subset is unbiased.
    for (let i = active.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [active[i], active[j]] = [active[j], active[i]];
    }
    let toDisable = active.length - budget;
    for (let i = 0; i < active.length && toDisable > 0; i++) {
      if (rand() < randomness) { active[i].off(); toDisable--; }
    }
  }

  /** Short list of the main settings shaping the current sound, for the recap line:
      wave, pitch, the noise colour (if noise is audible), the envelope character
      (Punchy/Gated when the decay shape leaves linear, layer decays when split),
      every active module by name, then the estimated length.
      e.g. ["Square","159","Pink","Punchy","Ring","Comb","0.8s"]. */
  describe(): string[] {
    const tokens: string[] = [];
    tokens.push(getParamSpec(this.drum, ParamId.Waveform).choices![Math.round(this.get(ParamId.Waveform))]);
    tokens.push(String(Math.round(this.get(ParamId.Pitch))));
    if (this.get(ParamId.NoiseLevel) > 0.05) tokens.push(NOISE_TYPES[Math.round(this.get(ParamId.NoiseType))]);
    const decShape = this.get(ParamId.AmpDecayShape);
    if (decShape >= 0.68) tokens.push("Punchy");
    else if (decShape <= 0.32) tokens.push("Gated");
    if (this.get(ParamId.ToneDecay) > 0.004) tokens.push("T-env");
    if (this.get(ParamId.NoiseDecay) > 0.004) tokens.push("N-env");
    for (const m of this.soundModules()) if (m.on) tokens.push(m.name);
    tokens.push(`${+this.estimateLength().toFixed(2)}s`);
    return tokens;
  }

  /** Rough audible length (seconds) of the current sound. Delegates to the standalone
      {@link estimateLength} so raw lane snapshots can compute the same tail. */
  estimateLength(): number {
    return estimateLength(this.values);
  }

  /** Trim FX (echo, then reverb), and finally the amp body, so the estimated
      length fits within `maxLen` seconds at `bpm`. Leaves the dry drum untouched
      when it already fits. No-op when maxLen <= 0. */
  private clampLength(maxLen: number, bpm = 120): void {
    if (maxLen <= 0) return;
    const A = this.get(ParamId.AmpAttack);
    const D = this.get(ParamId.AmpDecay);
    const R = this.get(ParamId.AmpRelease);
    const body = A + D + this.get(ParamId.AmpSustain) * R;
    const tailBudget = Math.max(0, maxLen - body);

    // Echo: shorten the delay to fit the budget; disable if even a minimal echo
    // (its shortest delay × audible repeats) won't fit. A tempo-synced echo can't
    // shorten freely — step it down to the longest division that fits instead.
    if (this.get(ParamId.EchoMix) > ECHO_EPS) {
      const reps = echoRepeats(this.get(ParamId.EchoFeedback), this.get(ParamId.EchoMix));
      const maxTime = reps > 0 ? tailBudget / reps : Infinity;
      const sync = Math.round(this.get(ParamId.EchoSync));
      if (sync > 0) {
        const beatSec = 60 / Math.max(1, bpm);
        let fit = 0; // largest sync index whose delay fits (0 = none)
        for (let i = 1; i < ECHO_SYNC_BEATS.length; i++) {
          if (ECHO_SYNC_BEATS[i] * beatSec <= maxTime) fit = i;
        }
        if (fit === 0) this.set(ParamId.EchoMix, 0);
        else if (ECHO_SYNC_BEATS[sync] * beatSec > maxTime) this.set(ParamId.EchoSync, fit);
      } else {
        const minTime = getParamSpec(this.drum, ParamId.EchoTime).min;
        if (maxTime < minTime) this.set(ParamId.EchoMix, 0);
        else if (this.get(ParamId.EchoTime) > maxTime) this.set(ParamId.EchoTime, maxTime);
      }
    }

    // Reverb: shrink room size to fit; disable mix if even the smallest room
    // tail overruns the budget.
    if (this.get(ParamId.ReverbMix) > VERB_EPS) {
      if (tailBudget < RV_BASE) this.set(ParamId.ReverbMix, 0);
      else {
        const maxSize = (tailBudget - RV_BASE) / RV_SPAN;
        if (this.get(ParamId.ReverbSize) > maxSize) {
          this.set(ParamId.ReverbSize, Math.max(0, maxSize));
        }
      }
    }

    // Modal bank: shrink the ring time to fit; drop the bank when even the
    // tightest ring (0.25x scale) overruns the budget.
    if (this.get(ParamId.ModalMix) > 0.02) {
      const mat = Math.round(this.get(ParamId.ModalMaterial));
      const base = MODAL_RING_BASE * (MODAL_RING_MAX_D[mat] ?? 1);
      if (tailBudget < base * 0.25) this.set(ParamId.ModalMix, 0);
      else {
        const maxDec = 0.5 + Math.log(Math.min(4, tailBudget / base)) / Math.log(4) / 2;
        if (this.get(ParamId.ModalDecay) > maxDec) this.set(ParamId.ModalDecay, Math.max(0, maxDec));
      }
    }

    // Body still too long on its own → scale the envelope down (FX already
    // removed above, since tailBudget was 0). Decay/Release have non-zero floors
    // that set() clamps to, so scale only the reducible part above each floor —
    // that lands the body exactly on maxLen instead of stalling at the floor.
    if (body > maxLen) {
      const fA = baseRange(ParamId.AmpAttack).min;
      const fD = baseRange(ParamId.AmpDecay).min;
      const fR = baseRange(ParamId.AmpRelease).min;
      const S = this.get(ParamId.AmpSustain);
      const floorBody = fA + fD + S * fR;
      const k = body > floorBody ? Math.max(0, (maxLen - floorBody) / (body - floorBody)) : 0;
      this.set(ParamId.AmpAttack, fA + (A - fA) * k);
      this.set(ParamId.AmpDecay, fD + (D - fD) * k);
      this.set(ParamId.AmpRelease, fR + (R - fR) * k);
    }
  }

  /** Two LFOs aimed at the same destination just double up — silence the later
      duplicate(s) by switching them to "None". Duplicate "None"s are fine. */
  private dedupeLfoTargets(): void {
    const NONE = LFO_TARGETS.length - 1;
    const slots = [ParamId.LfoTarget, ParamId.Lfo2Target, ParamId.Lfo3Target];
    const seen = new Set<number>();
    for (const id of slots) {
      const t = Math.round(this.get(id));
      if (t === NONE) continue;
      if (seen.has(t)) this.set(id, NONE);
      else seen.add(t);
    }
  }
}

const MAX_UNDO = 20;

// One undo entry captures the full editable state (values + ranges) so undoing a
// preset change or shuffle is exact.
interface UndoState { values: number[]; lo: number[]; hi: number[]; }

export class DrumKit {
  private params = new Map<DrumType, DrumParameters>();
  private undo = new Map<DrumType, UndoState[]>(); // per-drum undo stack

  constructor(drums: DrumType[]) {
    for (const d of drums) this.params.set(d, new DrumParameters(d));
  }

  get(drum: DrumType): DrumParameters {
    return this.params.get(drum)!;
  }

  /** Live Pitch range for melody mapping (reflects the applied preset). */
  pitchRange(drum: DrumType): [number, number] {
    const p = this.get(drum);
    return [p.loOf(ParamId.Pitch), p.hiOf(ParamId.Pitch)];
  }

  private pushUndo(drum: DrumType): void {
    const stack = this.undo.get(drum) ?? [];
    const p = this.get(drum);
    const r = p.captureRanges();
    stack.push({ values: p.capture(), lo: r.lo, hi: r.hi });
    if (stack.length > MAX_UNDO) stack.shift();
    this.undo.set(drum, stack);
  }

  shuffleAll(drum: DrumType, opts: ShuffleOptions): void {
    this.pushUndo(drum);
    this.get(drum).randomize(opts);
  }

  /** Crossbreed the drum's current sound with another snapshot (undoable). */
  breed(drum: DrumType, other: number[]): void {
    this.pushUndo(drum);
    this.get(drum).breedFrom(other);
  }

  resetAll(drum: DrumType): void {
    this.pushUndo(drum);
    this.get(drum).resetToPreset();
  }

  applyPreset(drum: DrumType, preset: Preset): void {
    this.pushUndo(drum);
    this.get(drum).applyPreset(preset);
  }

  /** Restore which preset is "active" by name (for the label/Reset after a load).
      No-op if the name isn't a known factory preset. */
  adoptPresetByName(drum: DrumType, name: string): void {
    const p = FACTORY_PRESETS.find((x) => x.name === name);
    if (p) this.get(drum).adoptPreset(p);
  }

  canBack(drum: DrumType): boolean {
    const stack = this.undo.get(drum);
    return !!stack && stack.length > 0;
  }

  /** Step one drum back to its previous state. Returns false if nothing to undo. */
  backAll(drum: DrumType): boolean {
    const stack = this.undo.get(drum);
    if (!stack || stack.length === 0) return false;
    const s = stack.pop()!;
    const p = this.get(drum);
    p.restore(s.values);
    p.restoreRanges(s.lo, s.hi);
    return true;
  }
}
