// Editable, stateful drum parameters + global randomise/undo controls.
// Port of DrumParameters.cpp + DrumKit.h (minus the Markov "Evolve", which was
// never implemented in the C++ either). Each drum now also carries a live shuffle
// window (lo/hi per param) that a preset sets — so any slot can take on any
// character and "Full Range" can open the window wide.

import { DrumType } from "./drums";
import { ParamId, NUM_PARAMS } from "./params";
import { getParamSpec, baseRange, isDiscrete, LFO_TARGETS, OSC_MOD_TYPES, NOISE_TYPES } from "./paramSpec";
import { Preset, defaultPresetFor, FACTORY_PRESETS } from "./presets";

export type Snapshot = number[];

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

// How many effect/filter "modules" a shuffle leaves active at once (there are 13 in
// all — see soundModules). Weighted toward a handful so a sound is usually doing a
// few things, but it can occasionally run most of them at once for a dense result.
function sparsityBudget(): number {
  const r = Math.random();
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
  const u1 = Math.random() || 1e-9; // avoid log(0)
  const u2 = Math.random();
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

// How many audible repeats a feedback echo produces at the given feedback/mix.
function echoRepeats(fb: number, mix: number): number {
  if (mix <= ECHO_EPS) return 0;
  if (fb < 0.01) return 1;
  return Math.max(1, 1 + Math.log(ECHO_EPS / mix) / Math.log(fb));
}

/** Rough audible length (seconds) of a sound from its parameter snapshot: the amp
    body (attack + decay + sustain-weighted release) plus the dominant FX tail
    (echo/reverb). Used for the shuffle recap, the length cap, and the engine's
    channel-stealing "tail" (so long-ringing sounds keep their channel). */
export function estimateLength(snap: number[]): number {
  const body =
    snap[ParamId.AmpAttack] +
    snap[ParamId.AmpDecay] +
    snap[ParamId.AmpSustain] * snap[ParamId.AmpRelease];
  const echoTail =
    snap[ParamId.EchoMix] > ECHO_EPS
      ? snap[ParamId.EchoTime] * echoRepeats(snap[ParamId.EchoFeedback], snap[ParamId.EchoMix])
      : 0;
  const verbTail =
    snap[ParamId.ReverbMix] > VERB_EPS
      ? RV_BASE + snap[ParamId.ReverbSize] * RV_SPAN
      : 0;
  return body + Math.max(echoTail, verbTail);
}

// Draw a frequency in [lo, hi] (both > 0) shaped by `curve`. Log/Gaussian options
// work in normalised log-position p∈[0,1] and map back with lo·(hi/lo)^p.
export function sampleFreq(curve: FreqCurve, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  if (curve === FreqCurve.Linear) return lo + Math.random() * (hi - lo);
  const ratio = hi / lo;
  let p: number;
  if (curve === FreqCurve.Log) {
    p = Math.random();
  } else {
    const mu = GAUSS_MU[curve] ?? 0.5;
    p = Math.min(1, Math.max(0, mu + GAUSS_SIGMA * randNormal()));
  }
  return lo * Math.pow(ratio, p);
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

  /** Restore values from a snapshot. Tolerates short (pre-LFO2/3) snapshots by
      filling any missing tail with the param default. */
  restore(snap: Snapshot): void {
    for (let i = 0; i < NUM_PARAMS; i++) {
      const id = i as ParamId;
      const v = snap[i];
      this.set(id, v === undefined || Number.isNaN(v) ? getParamSpec(this.drum, id).def : v);
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

  /** Randomise ("Shuffle") every randomisable param at once (Volume is never
      touched). Continuous params are drawn uniformly from a window: current lerped
      toward each edge of its live (preset) range by `randomness`. Discrete "type"
      params (Wave/Filter/LFO destinations) reroll to a random choice within their
      preset range — locked when lo==hi, so a character preset only shuffles its LFO
      destinations while Full Range also shuffles waves/filters. The shuffle amount
      is the probability that each discrete param rerolls.

      `curve` reshapes the random draw of the FREQUENCY params (Pitch & Filter
      Cutoff) so highs don't dominate perceptually — see {@link FreqCurve}. All
      other continuous params keep a uniform draw.

      After the draw, {@link applySparsity} switches off a random subset of the
      effect/filter modules so a sound is usually only doing 1-3 things at once
      instead of everything at full tilt — the count itself varies per shuffle.

      `maxLen` (seconds, 0 = off) caps the estimated audible length: FX tails are
      trimmed first (echo, then reverb), then the amp body, to fit. */
  randomize(randomness: number, curve: FreqCurve = FreqCurve.Linear, maxLen = 0): void {
    randomness = Math.min(1, Math.max(0, randomness));
    for (let i = 0; i < NUM_PARAMS; i++) {
      const id = i as ParamId;
      const s = getParamSpec(this.drum, id);
      if (!s.randomizable) continue;
      if (isDiscrete(s)) {
        const lo = Math.round(this.lo[id]);
        const hi = Math.round(this.hi[id]);
        if (hi > lo && Math.random() < randomness) {
          this.set(id, lo + Math.floor(Math.random() * (hi - lo + 1)));
        }
        continue;
      }
      const cur = this.get(id);
      const lo = cur + (this.lo[id] - cur) * randomness;
      const hi = cur + (this.hi[id] - cur) * randomness;
      const isFreq = id === ParamId.Pitch || id === ParamId.FilterCutoff;
      // Noise level is biased toward the low edge so shuffles are quieter on average;
      // frequency params use the perceptual curve; everything else is a uniform draw.
      let v: number;
      if (isFreq) v = sampleFreq(curve, lo, hi);
      else if (id === ParamId.NoiseLevel) v = lo + Math.pow(Math.random(), NOISE_LEVEL_BIAS) * (hi - lo);
      else v = lo + Math.random() * (hi - lo);
      this.set(id, v);
    }
    this.dedupeLfoTargets();
    this.applySparsity(randomness);
    if (randomness > 0) this.ensureAudibleLevel();
    this.clampLength(maxLen);
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
      { name: "Crush", on: round(ParamId.Crush) > 0, off: () => this.set(ParamId.Crush, 0) },
      { name: "Downsmpl", on: round(ParamId.Downsample) > 0, off: () => this.set(ParamId.Downsample, 0) },
      { name: "Drive", on: g(ParamId.Drive) > 0.05, off: () => this.set(ParamId.Drive, 0) },
      { name: "Punch", on: g(ParamId.PitchEnvAmount) > 0.1, off: () => this.set(ParamId.PitchEnvAmount, 0) },
      { name: "Echo", on: g(ParamId.EchoMix) > 0.03, off: () => this.set(ParamId.EchoMix, 0) },
      { name: "Verb", on: g(ParamId.ReverbMix) > 0.05, off: () => this.set(ParamId.ReverbMix, 0) },
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
      const j = Math.floor(Math.random() * (i + 1));
      [active[i], active[j]] = [active[j], active[i]];
    }
    let toDisable = active.length - budget;
    for (let i = 0; i < active.length && toDisable > 0; i++) {
      if (Math.random() < randomness) { active[i].off(); toDisable--; }
    }
  }

  /** Short list of the main settings shaping the current sound, for the recap line:
      wave, pitch, the noise colour (if noise is audible), every active module by
      name, then the estimated length. e.g. ["Square","159","Pink","Ring","Comb","0.8s"]. */
  describe(): string[] {
    const tokens: string[] = [];
    tokens.push(getParamSpec(this.drum, ParamId.Waveform).choices![Math.round(this.get(ParamId.Waveform))]);
    tokens.push(String(Math.round(this.get(ParamId.Pitch))));
    if (this.get(ParamId.NoiseLevel) > 0.05) tokens.push(NOISE_TYPES[Math.round(this.get(ParamId.NoiseType))]);
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
      length fits within `maxLen` seconds. Leaves the dry drum untouched when it
      already fits. No-op when maxLen <= 0. */
  private clampLength(maxLen: number): void {
    if (maxLen <= 0) return;
    const A = this.get(ParamId.AmpAttack);
    const D = this.get(ParamId.AmpDecay);
    const R = this.get(ParamId.AmpRelease);
    const body = A + D + this.get(ParamId.AmpSustain) * R;
    const tailBudget = Math.max(0, maxLen - body);

    // Echo: shorten the delay to fit the budget; disable if even a minimal echo
    // (its shortest delay × audible repeats) won't fit.
    if (this.get(ParamId.EchoMix) > ECHO_EPS) {
      const reps = echoRepeats(this.get(ParamId.EchoFeedback), this.get(ParamId.EchoMix));
      const minTime = getParamSpec(this.drum, ParamId.EchoTime).min;
      const maxTime = reps > 0 ? tailBudget / reps : Infinity;
      if (maxTime < minTime) this.set(ParamId.EchoMix, 0);
      else if (this.get(ParamId.EchoTime) > maxTime) this.set(ParamId.EchoTime, maxTime);
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

  shuffleAll(
    drum: DrumType,
    randomness: number,
    curve: FreqCurve = FreqCurve.Linear,
    maxLen = 0,
  ): void {
    this.pushUndo(drum);
    this.get(drum).randomize(randomness, curve, maxLen);
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
