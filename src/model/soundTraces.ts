// GRAPH MODE's model: the sound's settings as TIME FUNCTIONS. Each trace maps a few
// snapshot params onto one curve y(t) — the pitch envelope falling onto its base pitch,
// the amp ADSR, a layer's own decay, an LFO's wobble, the echo's dying repeats — with
// an editable FORMULA (each variable bound to a param), discrete TYPE rows for every
// real engine choice behind it, and a colour of its own so the lines read apart.
//
// The formula is HONEST about overrides: a tempo-synced LFO or echo swaps its editable
// rate/time for the synced value computed at the live tempo (the engine ignores the
// knob then — see `ctx.bpm`), and the modal formula is the material's real mode sum.
// Each trace also carries the ENGINE CODE that implements its formula (`code`), shown
// by the editor's ? button.
//
// A setting that persists for the whole note draws across the ENTIRE axis; one that
// genuinely ends states its DOMAIN next to the formula ("t < 220ms"). A zero-level
// setting is INACTIVE (not drawn); giving its level a value brings it to life.

import { ParamId } from "./params";

/** One editable variable of a trace's formula, bound to a snapshot param. */
export interface TraceVar {
  sym: string;                 // the symbol shown in the formula
  param: ParamId;
  step: number;                // DISPLAY units per scrub tick
  scale?: number;              // display = raw × scale (100 for percent-style params)
  fmt: (v: number) => string;  // display from the RAW value — units live in the formula text
}

/** One discrete "function type" row (its choices come from the param's spec). */
export interface TraceType {
  label: string;
  param: ParamId;
}

/** Read a param value (the live kit's current sound). */
export type ParamGet = (id: ParamId) => number;

/** Live context the formulas may depend on (tempo, for the beat-synced overrides). */
export interface TraceCtx {
  bpm: number;
}

export interface TraceSpec {
  id: string;
  label: string;
  color: string;
  /** Formula text pieces interleaved with indices into `vars` — or a function of the
      live values, so overrides (sync at the live tempo, the modal material) reshape
      the formula itself. */
  parts: (string | number)[] | ((get: ParamGet, ctx: TraceCtx) => (string | number)[]);
  vars: TraceVar[];
  /** Discrete "function type" rows (LFO wave + destination + sync, noise colour…). */
  types?: TraceType[];
  /** Whether the setting is audible at all (zero level/amount = inactive, not drawn). */
  active: (get: ParamGet) => boolean;
  /** Seconds the trace spans; Infinity = it persists for the whole note. */
  duration: (get: ParamGet, ctx: TraceCtx) => number;
  /** Normalised y (0..1) at absolute time t seconds. */
  curve: (get: ParamGet, t: number, ctx: TraceCtx) => number;
  /** A "from → to" recap of the values ("1190 Hz → 340 Hz"), for the editor. */
  fromTo?: (get: ParamGet, ctx: TraceCtx) => string;
  /** What this trace is, for the editor's ? glossary. */
  about: string;
  /** The engine lines that implement the formula (shown under the ? explainer). */
  code: string;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const hzFmt = (v: number) => String(Math.round(v));
const secFmt = (v: number) => String(r2(v));
const pctFmt = (v: number) => String(Math.round(v * 100));

/** Log-normalise a frequency for display (20 Hz → 0, ~12 kHz → 1). */
const hzNorm = (hz: number) => clamp01(Math.log2(Math.max(20, hz) / 20) / Math.log2(12000 / 20));

// Click transient decay seconds per ClickType — mirrors CLICK_DECAY in engine.js.
const CLICK_DECAY = [0.0015, 0.006, 0.012, 0.004, 0.008];
// Bit depth per Crush index / sample-rate divisor per Downsample index — mirror
// CRUSH_BITS / DOWNSAMPLE_FACTOR in engine.js (index 0 = off).
const CRUSH_BITS = [0, 12, 10, 8, 6, 5, 4, 3];
const DOWNSAMPLE_FACTOR = [1, 2, 3, 4, 6, 8, 12, 16];
// Tempo-sync divisions in BEATS — mirror LFO_SYNC_BEATS / ECHO_SYNC_BEATS in engine.js.
const LFO_SYNC_BEATS = [0, 0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 4];
const ECHO_SYNC_BEATS = [0, 0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2];
const LFO_SYNC_NAMES = ["Free", "1/32", "1/16", "1/16·", "1/8", "1/8·", "1/4", "1/4·", "1/2", "1 bar"];
// Modal mode decay weights + gains per material — mirror MODAL_TABLES in engine.js.
const MODAL_D = [
  [1, 0.70, 0.55, 0.45, 0.40, 0.35],
  [1.4, 1, 0.90, 0.80, 0.70, 0.50],
  [1, 0.45, 0.25, 0.15],
  [1.6, 1.6, 1.1, 1.1, 0.70, 0.40],
  [0.8, 0.70, 0.65, 0.55, 0.50, 0.40],
];
const MODAL_G = [
  [1, 0.62, 0.40, 0.35, 0.25, 0.20],
  [0.5, 1, 0.70, 0.60, 0.50, 0.35],
  [1, 0.55, 0.30, 0.15],
  [0.8, 0.8, 0.60, 0.55, 0.30, 0.15],
  [1, 0.75, 0.65, 0.55, 0.45, 0.35],
];
const MODAL_NAMES = ["Membrane", "Bell", "Bar", "Bowl", "Plate"];

/** The LFO's EFFECTIVE cycle rate in Hz: the synced division at the live tempo when
    Sync is on (the engine ignores the Rate knob then), else the Rate knob. */
function lfoHz(get: ParamGet, rate: ParamId, sync: ParamId, ctx: TraceCtx): number {
  const beats = LFO_SYNC_BEATS[Math.round(get(sync))] || 0;
  return beats > 0 ? Math.max(1, ctx.bpm) / (60 * beats) : Math.max(0.05, get(rate));
}

/** The echo's EFFECTIVE delay in seconds (synced division at the live tempo, else T). */
function echoSec(get: ParamGet, ctx: TraceCtx): number {
  const beats = ECHO_SYNC_BEATS[Math.round(get(ParamId.EchoSync))] || 0;
  return beats > 0 ? (beats * 60) / Math.max(1, ctx.bpm) : Math.max(0.02, get(ParamId.EchoTime));
}

/** The amp segment curve bend — mirrors shapeExp in engine.js: shape 0.5 = linear,
    lower = plucky/gated (fast start), higher = swelling/percussive (slow start). */
const shapeExp = (s: number) => Math.pow(4, clamp01(s) * 2 - 1);

/** LFO wave at phase p (0..1): 0 Sine, 1 Tri, 2 Saw, 3 Square, 4 S&H (deterministic
    pseudo-random per cycle, for display only). Returns -1..1. */
function lfoWave(shape: number, p: number): number {
  const ph = p - Math.floor(p);
  switch (Math.round(shape)) {
    case 1: return 2 * Math.abs(2 * (ph - Math.floor(ph + 0.5))) - 1;
    case 2: return 2 * ph - 1;
    case 3: return ph < 0.5 ? 1 : -1;
    case 4: { const c = Math.floor(p); return Math.sin(c * 127.1 + 311.7) >= 0 ? Math.sin(c * 74.7) : -Math.abs(Math.sin(c * 39.2)); }
    default: return Math.sin(2 * Math.PI * ph);
  }
}

/** One decaying layer (level · e^(−t/decay)); decay 0 = follows the amp (persists). */
const layerCurve = (level: number, decay: number, t: number) =>
  clamp01(level * (decay > 0.004 ? Math.exp(-t / decay) : 1));

/** The modal ring envelope: the material's real mode sum Σ gₖ·e^(−t/τₖ), τₖ scaled by
    the decay knob (0.45s base · 4^(2(D−½)) · the material's per-mode weight). */
function modalCurve(get: ParamGet, t: number): number {
  const mat = Math.max(0, Math.min(MODAL_D.length - 1, Math.round(get(ParamId.ModalMaterial))));
  const scale = 0.45 * Math.pow(4, (clamp01(get(ParamId.ModalDecay)) - 0.5) * 2);
  const ds = MODAL_D[mat], gs = MODAL_G[mat];
  let sum = 0, norm = 0;
  for (let k = 0; k < ds.length; k++) {
    sum += gs[k] * Math.exp(-t / Math.max(0.01, scale * ds[k]));
    norm += gs[k];
  }
  return clamp01(get(ParamId.ModalMix) * (sum / norm));
}

/** An LFO trace (the three differ only in their param ids). Spans the whole note; its
    wave, DESTINATION and tempo-sync are all editable — and when Sync is on, the formula
    swaps the Rate knob for the synced rate at the live tempo (what the engine plays). */
function lfoTrace(
  n: 1 | 2 | 3, target: ParamId, rate: ParamId, depth: ParamId, shape: ParamId, sync: ParamId, color: string,
): TraceSpec {
  return {
    id: `lfo${n}`,
    label: `LFO ${n}`,
    color,
    parts: (g, ctx) => {
      const s = Math.round(g(sync));
      return s > 0
        ? ["y(t) = ", 0, ` · wave(${r2(lfoHz(g, rate, sync, ctx))}·t)  — ${LFO_SYNC_NAMES[s] ?? "sync"} @ ${Math.round(ctx.bpm)} BPM`]
        : ["y(t) = ", 0, " · wave(", 1, "·t)"];
    },
    vars: [
      { sym: "depth", param: depth, step: 2, scale: 100, fmt: pctFmt },
      { sym: "rate", param: rate, step: 0.1, fmt: (v) => `${r2(v)}` },
    ],
    types: [
      { label: "Wave", param: shape },
      { label: "Dest", param: target },
      { label: "Sync", param: sync },
    ],
    active: (g) => g(depth) > 0.001 && Math.round(g(target)) !== 6, // 6 = Off destination
    duration: () => Infinity, // the wobble runs as long as the note does
    curve: (g, t, ctx) => clamp01(0.5 + 0.5 * g(depth) * lfoWave(g(shape), lfoHz(g, rate, sync, ctx) * t)),
    fromTo: (g, ctx) => `±${Math.round(g(depth) * 100)}% at ${r2(lfoHz(g, rate, sync, ctx))} Hz`,
    about: "A repeating wobble applied to its destination for the note's whole life — the wave is the function's shape, Dest picks WHAT it bends (pitch vibrato, filter wah, amp or noise tremolo, drive, reso, pulse width, crush grit, ring AM…), Sync beat-locks one cycle to that note length at the live tempo (the Rate knob is ignored then, and the formula shows the synced rate instead). Depth 0 turns it off.",
    code: `// engine.js — Voice.renderAdding: the per-sample LFO
const beats = LFO_SYNC_BEATS[sync] || 0;
lfoInc = (beats > 0 ? tempo / (60 * beats)   // synced: one cycle per division
                    : lfoRate) / sampleRate; // free: the Rate knob in Hz
v = shape === S_AND_H ? heldRandom : lfoWave(shape, lfoPhase); // -1..1
lfoPhase += lfoInc;
switch (target) {
  case PITCH:  pitchMul  *= Math.pow(2, v * depth * 0.5); break;
  case FILTER: cutoffMul *= Math.pow(2, v * depth * 2);   break;
  case AMP:    ampMul    *= 1 - depth * (0.5 * (1 - v));  break;
  case NOISE:  noiseMul  *= 1 - depth * (0.5 * (1 - v));  break; // noise tremolo
  case CRUSH:  crushShift += v * depth * 4;               break; // ± bit depth
  case RING:   ringMul   *= 1 + v * depth;                break; // bipolar AM
  // … DRIVE, RESO, WAVE (pulse width)
}`,
  };
}

/** The trace set, in display order. Colours are hand-picked to stay apart on dark. */
export const SOUND_TRACES: TraceSpec[] = [
  {
    id: "pitch", label: "Pitch", color: "#ff6b6b",
    parts: ["f(t) = ", 0, " · (1 + ", 1, " · e^(−t/", 2, ")) Hz"],
    vars: [
      { sym: "P", param: ParamId.Pitch, step: 5, fmt: hzFmt },
      { sym: "A", param: ParamId.PitchEnvAmount, step: 0.1, fmt: (v) => String(r2(v)) },
      { sym: "D", param: ParamId.PitchEnvDecay, step: 0.01, fmt: secFmt },
    ],
    active: (g) => g(ParamId.ToneLevel) > 0.001,
    duration: () => Infinity, // the tone holds its base pitch for the whole note
    curve: (g, t) => hzNorm(g(ParamId.Pitch) * (1 + g(ParamId.PitchEnvAmount) * Math.exp(-t / Math.max(0.001, g(ParamId.PitchEnvDecay))))),
    fromTo: (g) => {
      const p = g(ParamId.Pitch);
      return `${Math.round(p * (1 + g(ParamId.PitchEnvAmount)))} Hz → ${Math.round(p)} Hz`;
    },
    about: "The tone's frequency for the note's whole life: it starts at P·(1+A), settles onto the base pitch P as the sweep decays, and holds there (negative A rises up into the note instead). For a wobbling pitch, point an LFO at Pitch.",
    code: `// engine.js — Voice.renderAdding: the per-sample pitch
let freq = basePitch * (1 + pitchEnvAmount * pitchEnv) * pitchMul;
pitchEnv *= pitchEnvCoef; // = exp(-1 / (D * sampleRate)) — the e^(−t/D)`,
  },
  {
    id: "amp", label: "Amp", color: "#ffa94d",
    parts: ["a(t) = A", 0, "^", 5, " D", 1, "^", 6, " S", 2, " R", 3, " · hold ", 4, "s"],
    vars: [
      { sym: "atk", param: ParamId.AmpAttack, step: 0.005, fmt: secFmt },
      { sym: "dec", param: ParamId.AmpDecay, step: 0.01, fmt: secFmt },
      { sym: "sus", param: ParamId.AmpSustain, step: 2, scale: 100, fmt: pctFmt },
      { sym: "rel", param: ParamId.AmpRelease, step: 0.01, fmt: secFmt },
      { sym: "gate", param: ParamId.Gate, step: 0.05, fmt: secFmt },
      // The segment CURVES — the amp's own function types: <50 plucky/gated, 50 linear,
      // >50 swelling/percussive. These bend the drawn attack and decay/release.
      { sym: "a-curve", param: ParamId.AmpAttackShape, step: 2, scale: 100, fmt: pctFmt },
      { sym: "d-curve", param: ParamId.AmpDecayShape, step: 2, scale: 100, fmt: pctFmt },
    ],
    active: () => true,
    duration: (g) => {
      const gate = g(ParamId.Gate) > 0 ? g(ParamId.Gate) : 0.4;
      return Math.min(32, Math.max(g(ParamId.AmpAttack) + g(ParamId.AmpDecay), gate) + g(ParamId.AmpRelease) + 0.02);
    },
    curve: (g, t) => {
      const a = Math.max(0.0001, g(ParamId.AmpAttack)), d = Math.max(0.0001, g(ParamId.AmpDecay));
      const s = clamp01(g(ParamId.AmpSustain)), r = Math.max(0.0001, g(ParamId.AmpRelease));
      const aExp = shapeExp(g(ParamId.AmpAttackShape)), dExp = shapeExp(g(ParamId.AmpDecayShape));
      const gate = g(ParamId.Gate) > 0 ? g(ParamId.Gate) : 0.4;
      const at = (t2: number): number => {
        if (t2 < a) return Math.pow(t2 / a, aExp);
        if (t2 < a + d) return s + (1 - s) * Math.pow(1 - (t2 - a) / d, dExp);
        return s;
      };
      if (t < gate) return clamp01(at(t));
      return clamp01(at(gate) * Math.pow(Math.max(0, 1 - (t - gate) / r), dExp));
    },
    fromTo: (g) => `held ${r2(g(ParamId.Gate) > 0 ? g(ParamId.Gate) : 0.4)}s, then ${r2(g(ParamId.AmpRelease))}s release`,
    about: "The loudness envelope every hit rides: attack up (bent by a-curve — under 50 is plucky, over 50 swells), decay to the sustain level (bent by d-curve), held while the note is on (the gate), then the release tail.",
    code: `// engine.js — the shaped ADSR (t = each segment's 0..1 phase)
attack:  value = Math.pow(t, aExp);                    // a-curve → aExp = 4^(2s−1)
decay:   value = sus + (1 - sus) * Math.pow(1 - t, dExp);
release: value = start * Math.pow(1 - t, dExp);
// note-off after the hold:
if (samplesPlayed >= gateSeconds * sampleRate) adsr.noteOff();`,
  },
  {
    id: "tone", label: "Tone", color: "#ffd43b",
    parts: ["y(t) = ", 0, " · e^(−t/", 1, ")"],
    vars: [
      { sym: "L", param: ParamId.ToneLevel, step: 2, scale: 100, fmt: pctFmt },
      { sym: "D", param: ParamId.ToneDecay, step: 0.01, fmt: secFmt },
    ],
    types: [{ label: "Wave", param: ParamId.Waveform }],
    active: (g) => g(ParamId.ToneLevel) > 0.001,
    // Its OWN decay ends it early; D = 0 follows the amp (persists with the note).
    duration: (g) => (g(ParamId.ToneDecay) > 0.004 ? Math.min(8, g(ParamId.ToneDecay) * 4) : Infinity),
    curve: (g, t) => layerCurve(g(ParamId.ToneLevel), g(ParamId.ToneDecay), t),
    fromTo: (g) => `${Math.round(g(ParamId.ToneLevel) * 100)}% → ${g(ParamId.ToneDecay) > 0.004 ? "0" : "held (follows the amp)"}`,
    about: "The oscillator layer's own level and decay clock (D = 0 rides the amp envelope for the whole note instead). L = 0 removes the tone entirely — noise-only sounds.",
    code: `// engine.js — Voice.renderAdding: the tone layer's own clock
let toneAmp = toneLevel;
if (toneEnvCoef > 0) {          // D > 0: its own exponential decay
  toneAmp *= toneEnv;
  toneEnv *= toneEnvCoef;       // = exp(-1 / (D * sampleRate))
}                               // D = 0: rides the amp ADSR instead
mixed = toneAmp * osc + noiseAmp * noise;`,
  },
  {
    id: "noise", label: "Noise", color: "#a9e34b",
    parts: ["y(t) = ", 0, " · e^(−t/", 1, ")"],
    vars: [
      { sym: "L", param: ParamId.NoiseLevel, step: 2, scale: 100, fmt: pctFmt },
      { sym: "D", param: ParamId.NoiseDecay, step: 0.01, fmt: secFmt },
    ],
    types: [{ label: "Colour", param: ParamId.NoiseType }],
    active: (g) => g(ParamId.NoiseLevel) > 0.001,
    duration: (g) => (g(ParamId.NoiseDecay) > 0.004 ? Math.min(8, g(ParamId.NoiseDecay) * 4) : Infinity),
    curve: (g, t) => layerCurve(g(ParamId.NoiseLevel), g(ParamId.NoiseDecay), t),
    fromTo: (g) => `${Math.round(g(ParamId.NoiseLevel) * 100)}% → ${g(ParamId.NoiseDecay) > 0.004 ? "0" : "held (follows the amp)"}`,
    about: "The noise layer's level and its own decay (D = 0 rides the amp for the whole note). The colour tilts its spectrum — white hiss to crackle and metal.",
    code: `// engine.js — Voice.renderAdding: the noise layer + its colour
const noise = this.nextNoise();  // white / pink / brown / blue / violet /
                                 // crackle (sparse impulses) / metal (S&H)
let noiseAmp = noiseLevel;
if (noiseEnvCoef > 0) { noiseAmp *= noiseEnv; noiseEnv *= noiseEnvCoef; }
mixed = toneAmp * osc + noiseAmp * noise;`,
  },
  {
    id: "click", label: "Click", color: "#63e6be",
    parts: (g) => {
      const τ = CLICK_DECAY[Math.max(0, Math.min(CLICK_DECAY.length - 1, Math.round(g(ParamId.ClickType))))];
      return ["y(t) = ", 0, ` · e^(−t/${Math.round(τ * 1000 * 10) / 10}ms)`];
    },
    vars: [{ sym: "L", param: ParamId.ClickLevel, step: 2, scale: 100, fmt: pctFmt }],
    types: [{ label: "Type", param: ParamId.ClickType }],
    active: (g) => g(ParamId.ClickLevel) > 0.001,
    duration: (g) => Math.min(0.12, CLICK_DECAY[Math.max(0, Math.min(CLICK_DECAY.length - 1, Math.round(g(ParamId.ClickType))))] * 8 + 0.01),
    curve: (g, t) => clamp01(g(ParamId.ClickLevel) * Math.exp(-t / CLICK_DECAY[Math.max(0, Math.min(CLICK_DECAY.length - 1, Math.round(g(ParamId.ClickType))))])),
    fromTo: (g) => `${Math.round(g(ParamId.ClickLevel) * 100)}% → 0 in a few ms`,
    about: "The transient snap at the very start of each hit — a few milliseconds long (the τ in the formula comes from the click type). L = 0 removes it. It genuinely ends, hence the short domain.",
    code: `// engine.js — Voice.renderAdding: the click layer (post-filter)
const CLICK_DECAY = [0.0015, 0.006, 0.012, 0.004, 0.008]; // per type, seconds
filtered += clickSample * clickEnv * clickLevel * CLICK_GAIN;
clickEnv *= clickCoef; // = exp(-1 / (CLICK_DECAY[type] * sampleRate))`,
  },
  {
    id: "filter", label: "Filter", color: "#4dabf7",
    parts: ["c(t) = ", 0, " Hz, Q = ", 1],
    vars: [
      { sym: "C", param: ParamId.FilterCutoff, step: 50, fmt: hzFmt },
      { sym: "Q", param: ParamId.FilterReso, step: 0.1, fmt: (v) => String(r2(v)) },
    ],
    types: [{ label: "Type", param: ParamId.FilterType }],
    active: () => true,
    duration: () => Infinity,
    curve: (g) => hzNorm(g(ParamId.FilterCutoff)),
    fromTo: (g) => `${Math.round(g(ParamId.FilterCutoff))} Hz steady`,
    about: "Where the filter sits (drawn on the same log-frequency scale as Pitch), for the whole note. Point an LFO at Filter to make it sweep — in Vowel type that literally makes it talk.",
    code: `// engine.js — Voice.renderAdding: the TPT state-variable filter
const cutoff = clamp(filterCutoff * cutoffMul, 20, nyquist); // LFO rides cutoffMul
const gCoef = Math.tan(Math.PI * cutoff / sampleRate);
const k = 1 / clamp(reso * resoMul, 0.3, 20);                // Q
filtered = svf.process(mixed, gCoef, k, type);               // LP / HP / BP
// Vowel type instead morphs three formant bandpasses A-E-I-O-U along Cutoff.`,
  },
  lfoTrace(1, ParamId.LfoTarget, ParamId.LfoRate, ParamId.LfoDepth, ParamId.Lfo1Shape, ParamId.Lfo1Sync, "#b197fc"),
  lfoTrace(2, ParamId.Lfo2Target, ParamId.Lfo2Rate, ParamId.Lfo2Depth, ParamId.Lfo2Shape, ParamId.Lfo2Sync, "#e599f7"),
  lfoTrace(3, ParamId.Lfo3Target, ParamId.Lfo3Rate, ParamId.Lfo3Depth, ParamId.Lfo3Shape, ParamId.Lfo3Sync, "#f783ac"),
  {
    id: "echo", label: "Echo", color: "#66d9e8",
    parts: (g, ctx) => {
      const s = Math.round(g(ParamId.EchoSync));
      return s > 0
        ? ["y(t) = ", 0, " · ", 1, `^(t/${r2(echoSec(g, ctx))}s)  — synced @ ${Math.round(ctx.bpm)} BPM`]
        : ["y(t) = ", 0, " · ", 1, "^(t/", 2, ")"];
    },
    vars: [
      { sym: "M", param: ParamId.EchoMix, step: 2, scale: 100, fmt: pctFmt },
      { sym: "F", param: ParamId.EchoFeedback, step: 2, scale: 100, fmt: pctFmt },
      { sym: "T", param: ParamId.EchoTime, step: 0.01, fmt: secFmt },
    ],
    types: [
      { label: "Sync", param: ParamId.EchoSync },
      { label: "Ping-pong", param: ParamId.EchoPing },
    ],
    active: (g) => g(ParamId.EchoMix) > 0.001,
    duration: (g, ctx) => {
      const f = clamp01(g(ParamId.EchoFeedback));
      const reps = f > 0.05 ? Math.min(10, Math.log(0.05) / Math.log(f)) : 1.5;
      return Math.min(8, Math.max(0.2, echoSec(g, ctx) * reps));
    },
    curve: (g, t, ctx) => clamp01(g(ParamId.EchoMix) * Math.pow(Math.max(0.02, g(ParamId.EchoFeedback)), t / echoSec(g, ctx))),
    fromTo: (g, ctx) => `${Math.round(g(ParamId.EchoMix) * 100)}% fading by ×${r2(g(ParamId.EchoFeedback))} every ${r2(echoSec(g, ctx))}s`,
    about: "The envelope of the echo's repeats: each pass T seconds later comes back F times as loud — the domain is how long the tail audibly rings. Sync locks the delay to a beat division at the live tempo (the T knob is ignored then, and the formula shows the synced time); ping-pong bounces repeats left/right. M = 0 turns it off.",
    code: `// engine.js — Channel.renderInto: the feedback delay
const beats = ECHO_SYNC_BEATS[sync] || 0;
const delaySec = beats > 0 ? (beats * 60) / tempo  // synced to the beat
                           : echoTime;             // free: the T knob
delayed = buf[w - delaySec * sampleRate];
buf[w] = input + delayed * feedback;               // each pass × F
out = input * (1 - mix) + delayed * mix;`,
  },
  {
    id: "reverb", label: "Reverb", color: "#9775fa",
    parts: ["y(t) = ", 0, " · e^(−t/(0.2+2·", 1, "))"],
    vars: [
      { sym: "M", param: ParamId.ReverbMix, step: 2, scale: 100, fmt: pctFmt },
      { sym: "S", param: ParamId.ReverbSize, step: 2, scale: 100, fmt: pctFmt },
    ],
    active: (g) => g(ParamId.ReverbMix) > 0.001,
    duration: (g) => Math.min(8, (0.2 + 2 * clamp01(g(ParamId.ReverbSize))) * 3),
    curve: (g, t) => clamp01(g(ParamId.ReverbMix) * Math.exp(-t / (0.2 + 2 * clamp01(g(ParamId.ReverbSize))))),
    fromTo: (g) => `${Math.round(g(ParamId.ReverbMix) * 100)}% in a ${Math.round(g(ParamId.ReverbSize) * 100)}% room`,
    about: "The reverb wash dying away — bigger rooms (S) ring longer, the mix (M) sets how much of the sound lives in it. M = 0 turns it off. (The drawn decay is a portrait; the real thing is 8 comb + 4 allpass filters.)",
    code: `// engine.js — Reverb (freeverb): 8 combs + 4 allpasses, ring time from S
this.roomSize = size * 0.28 + 0.7;   // comb feedback — bigger S rings longer
for (const c of combs) out += c.process(input, damp, this.roomSize);
for (const a of allpasses) out = a.process(out);
buf[i] = out * wet + buf[i] * dry;   // M sets wet/dry`,
  },
  {
    id: "drive", label: "Drive", color: "#e8590c",
    parts: ["y(t) = ", 0, " (steady)"],
    vars: [{ sym: "D", param: ParamId.Drive, step: 0.05, fmt: (v) => String(r2(v)) }],
    active: (g) => g(ParamId.Drive) > 0.001,
    duration: () => Infinity,
    curve: (g) => clamp01(g(ParamId.Drive) / 2),
    fromTo: (g) => `${r2(g(ParamId.Drive))} of 2 the whole time`,
    about: "Saturation pressed onto the whole sound — constant, so it draws as a level line. Point an LFO at Drive to make it seethe. 0 is clean.",
    code: `// engine.js — Voice.renderAdding: the saturator
const drive = clamp(driveKnob + driveLfo, 0, 2);
if (drive > 0) filtered = Math.tanh(filtered * (1 + drive * 5));`,
  },
  {
    id: "bitcrush", label: "Bitcrush", color: "#e64980",
    // No continuous knobs — both halves are discrete choices, so the formula is
    // computed from them: the quantiser's bit depth and the sample-and-hold divisor.
    parts: (g) => {
      const bits = CRUSH_BITS[Math.max(0, Math.min(CRUSH_BITS.length - 1, Math.round(g(ParamId.Crush))))];
      const ds = DOWNSAMPLE_FACTOR[Math.max(0, Math.min(DOWNSAMPLE_FACTOR.length - 1, Math.round(g(ParamId.Downsample))))];
      const q = bits > 0 ? `round(x·2^${bits})/2^${bits}` : "x";
      return [`y(t) = ${q}${ds > 1 ? `, held every ${ds} samples` : ""}  (steady)`];
    },
    vars: [],
    types: [
      { label: "Bits", param: ParamId.Crush },
      { label: "Rate ÷", param: ParamId.Downsample },
    ],
    active: (g) => Math.round(g(ParamId.Crush)) > 0 || Math.round(g(ParamId.Downsample)) > 0,
    duration: () => Infinity,
    curve: (g) => {
      const c = Math.max(0, Math.min(7, Math.round(g(ParamId.Crush)))) / 7;
      const d = Math.max(0, Math.min(7, Math.round(g(ParamId.Downsample)))) / 7;
      return clamp01(Math.max(c, d));
    },
    fromTo: (g) => {
      const bits = CRUSH_BITS[Math.max(0, Math.min(CRUSH_BITS.length - 1, Math.round(g(ParamId.Crush))))];
      const ds = DOWNSAMPLE_FACTOR[Math.max(0, Math.min(DOWNSAMPLE_FACTOR.length - 1, Math.round(g(ParamId.Downsample))))];
      return `${bits > 0 ? `${bits}-bit` : "full depth"} · rate ÷${ds}`;
    },
    about: "Lo-fi degradation, steady across the note (the line's height is how hard it bites): Bits quantises the wave to fewer levels, Rate ÷ holds each sample for several — telephone grit to broken-console. Both Off = inactive. Point an LFO at Crush to make the grit wobble.",
    code: `// engine.js — Voice.renderAdding: the bitcrusher
const CRUSH_BITS = [0, 12, 10, 8, 6, 5, 4, 3];       // per Bits choice
const DOWNSAMPLE_FACTOR = [1, 2, 3, 4, 6, 8, 12, 16]; // per Rate ÷ choice
if (dsFactor > 1) {                        // sample-and-hold decimation
  if (--dsCtr <= 0) { dsHold = mixed; dsCtr = dsFactor; }
  mixed = dsHold;
}
if (bits > 0) {                            // quantise to 2^bits levels
  const step = 2 / Math.pow(2, bits);
  mixed = Math.round(mixed / step) * step;
}`,
  },
  {
    id: "fold", label: "Fold", color: "#c0eb75",
    parts: ["y(t) = ", 0, " (steady)"],
    vars: [{ sym: "F", param: ParamId.Fold, step: 2, scale: 100, fmt: pctFmt }],
    active: (g) => g(ParamId.Fold) > 0.001,
    duration: () => Infinity,
    curve: (g) => clamp01(g(ParamId.Fold)),
    fromTo: (g) => `${Math.round(g(ParamId.Fold) * 100)}% the whole time`,
    about: "The wavefolder bending the wave back on itself — steady, so a level line. 0 is off.",
    code: `// engine.js — Voice.renderAdding: the wavefolder
if (fold > 0) osc = Math.sin(osc * (1 + fold * FOLD_GAIN) * 1.5707963);
// more gain → the sine folds the wave back on itself → extra harmonics`,
  },
  {
    id: "osc2", label: "Osc 2", color: "#74c0fc",
    parts: ["y(t) = ", 0, " at ", 1, " st"],
    vars: [
      { sym: "M", param: ParamId.Osc2Mix, step: 2, scale: 100, fmt: pctFmt },
      { sym: "dt", param: ParamId.Osc2Detune, step: 0.5, fmt: (v) => String(r2(v)) },
    ],
    types: [{ label: "Hard sync", param: ParamId.Sync }],
    active: (g) => g(ParamId.Osc2Mix) > 0.001,
    duration: () => Infinity,
    curve: (g) => clamp01(g(ParamId.Osc2Mix)),
    fromTo: (g) => `${Math.round(g(ParamId.Osc2Mix) * 100)}% detuned ${r2(g(ParamId.Osc2Detune))} semitones`,
    about: "A second oscillator blended in, detuned in semitones; hard sync snaps its cycle to the first oscillator for the classic ripping sync tone. M = 0 turns it off.",
    code: `// engine.js — Voice.renderAdding: the detuned second oscillator
osc2Ratio = Math.pow(2, detuneSemitones / 12);
osc += osc2Wave * mix;
osc2Phase += (freq * osc2Ratio) / sampleRate;
if (hardSync && osc1Wrapped) osc2Phase = 0; // snap to oscillator 1's cycle`,
  },
  {
    id: "fm", label: "FM / Ring", color: "#faa2c1",
    parts: ["y(t) = ", 0, " at ×", 1],
    vars: [
      { sym: "A", param: ParamId.OscModAmount, step: 2, scale: 100, fmt: pctFmt },
      { sym: "r", param: ParamId.OscModRatio, step: 0.05, fmt: (v) => String(r2(v)) },
    ],
    types: [{ label: "Type", param: ParamId.OscModType }],
    active: (g) => g(ParamId.OscModAmount) > 0.001 && Math.round(g(ParamId.OscModType)) !== 0,
    duration: () => Infinity,
    curve: (g) => clamp01(g(ParamId.OscModAmount)),
    fromTo: (g) => `${Math.round(g(ParamId.OscModAmount) * 100)}% at ratio ${r2(g(ParamId.OscModRatio))}`,
    about: "A second operator bending the tone — FM growl or ring-mod metal, at a frequency ratio r of the note. Amount 0 (or type Off) disables it.",
    code: `// engine.js — Voice.renderAdding: the second operator
modOut = Math.sin(2π * modPhase);           // a sine at freq × r
modPhase += (freq * ratio) / sampleRate;
// FM:   carrierPhase += modOut * amount * FM_INDEX;
// Ring: osc *= 1 - amount + amount * modOut;`,
  },
  {
    id: "comb", label: "Comb", color: "#8ce99a",
    parts: ["y(t) = ", 0, " · e^(−t/(0.1+2·", 1, ")) at ×", 2],
    vars: [
      { sym: "M", param: ParamId.CombMix, step: 2, scale: 100, fmt: pctFmt },
      { sym: "D", param: ParamId.CombDecay, step: 2, scale: 100, fmt: pctFmt },
      { sym: "tune", param: ParamId.CombTune, step: 0.05, fmt: (v) => String(r2(v)) },
    ],
    active: (g) => g(ParamId.CombMix) > 0.001,
    duration: (g) => Math.min(6, (0.1 + 2 * clamp01(g(ParamId.CombDecay))) * 3),
    curve: (g, t) => clamp01(g(ParamId.CombMix) * Math.exp(-t / (0.1 + 2 * clamp01(g(ParamId.CombDecay))))),
    fromTo: (g) => `${Math.round(g(ParamId.CombMix) * 100)}% ringing ${Math.round(g(ParamId.CombDecay) * 100)}%`,
    about: "The plucked-string resonator ringing at the note's pitch × tune — short D is a pluck, long D a sustained string. M = 0 turns it off. (The drawn decay is a portrait of the ring time; the real thing is a tuned delay loop.)",
    code: `// engine.js — KarplusComb: a tuned delay loop with damped feedback
const delaySamples = sampleRate / (freq * tune);  // the ring pitch
delayed = buf[w - delaySamples];
lp += (delayed - lp) * 0.5;                       // darker each pass
buf[w] = Math.tanh(input + lp * feedback);        // feedback = 0.85 + D * 0.14
out = dry * (1 - mix) + delayed * mix;`,
  },
  {
    id: "modal", label: "Modal", color: "#ffe066",
    // The material's REAL mode sum: switching material changes the τₖ set (and the
    // curve) — the formula names it.
    parts: (g) => {
      const mat = Math.max(0, Math.min(MODAL_NAMES.length - 1, Math.round(g(ParamId.ModalMaterial))));
      return ["y(t) = ", 0, ` · Σ gₖ·e^(−t/τₖ)  — ${MODAL_D[mat].length} ${MODAL_NAMES[mat]} modes, τ scaled by `, 1];
    },
    vars: [
      { sym: "M", param: ParamId.ModalMix, step: 2, scale: 100, fmt: pctFmt },
      { sym: "D", param: ParamId.ModalDecay, step: 2, scale: 100, fmt: pctFmt },
    ],
    types: [{ label: "Material", param: ParamId.ModalMaterial }],
    active: (g) => g(ParamId.ModalMix) > 0.001,
    duration: (g) => {
      const mat = Math.max(0, Math.min(MODAL_D.length - 1, Math.round(g(ParamId.ModalMaterial))));
      const scale = 0.45 * Math.pow(4, (clamp01(g(ParamId.ModalDecay)) - 0.5) * 2);
      return Math.min(8, scale * Math.max(...MODAL_D[mat]) * 3);
    },
    curve: (g, t) => modalCurve(g, t),
    fromTo: (g) => {
      const mat = Math.max(0, Math.min(MODAL_NAMES.length - 1, Math.round(g(ParamId.ModalMaterial))));
      return `${Math.round(g(ParamId.ModalMix) * 100)}% ringing as ${MODAL_NAMES[mat]}`;
    },
    about: "The resonator bank ringing at the note's modes — a SUM of decaying partials whose frequencies, gains (gₖ) and ring times (τₖ) come from the material's measured table (membrane, bell, bar, bowl, plate). Switching material swaps the whole τₖ/gₖ set, so the formula and the drawn curve change with it. D scales every mode's ring time.",
    code: `// engine.js — ModalBank.setup: the material's measured mode table
const t = MODAL_TABLES[material]; // { r: freq ratios, g: gains, d: decay weights }
for (let k = 0; k < t.r.length; k++) {
  const decay = MODAL_BASE_DECAY * t.d[k] * 4 ** ((D - 0.5) * 2); // τₖ
  const r = Math.exp(-1 / (decay * sampleRate));
  // each mode: y[n] = 2r·cos(ω)·y[n-1] − r²·y[n-2] + gₖ·x[n]
}`,
  },
  {
    id: "out", label: "Out", color: "#ced4da",
    parts: ["y(t) = ", 0, " at pan ", 1, " (steady)"],
    vars: [
      { sym: "vol", param: ParamId.Volume, step: 2, scale: 100, fmt: pctFmt },
      {
        sym: "pan", param: ParamId.Pan, step: 5, scale: 100,
        fmt: (v) => (Math.abs(v) < 0.005 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`),
      },
    ],
    active: (g) => g(ParamId.Volume) > 0.001,
    duration: () => Infinity,
    curve: (g) => clamp01(g(ParamId.Volume)),
    fromTo: (g) => {
      const p = g(ParamId.Pan);
      return `${Math.round(g(ParamId.Volume) * 100)}% ${Math.abs(p) < 0.005 ? "centred" : `panned ${p < 0 ? "left" : "right"} ${Math.round(Math.abs(p) * 100)}%`}`;
    },
    about: "The channel's place in the mix: its level (also what the mixer fader moves) and its stereo position, constant across the note. Volume 0 silences the sound entirely.",
    code: `// engine.js — Channel.renderInto: constant-power pan
const ang = (pan + 1) * 0.25 * Math.PI;
const gl = Math.cos(ang) * Math.SQRT2, gr = Math.sin(ang) * Math.SQRT2;
masterL[i] += sample * volume * gl;
masterR[i] += sample * volume * gr; // centred sums to the exact mono level`,
  },
  {
    id: "life", label: "Life", color: "#a5adba",
    // Not a curve over ONE note — dice rolled per HIT. Drawn as a steady line at the
    // hit probability; the formula reads as the per-hit rules.
    parts: ["per hit: P(play) = ", 0, ", duck = ", 1, ", jitter = ", 2, ", roll = ", 3],
    vars: [
      { sym: "chance", param: ParamId.HitChance, step: 2, scale: 100, fmt: pctFmt },
      { sym: "accent", param: ParamId.AccentAmount, step: 2, scale: 100, fmt: pctFmt },
      { sym: "human", param: ParamId.Humanize, step: 2, scale: 100, fmt: pctFmt },
      { sym: "ratchet", param: ParamId.Ratchet, step: 2, scale: 100, fmt: pctFmt },
    ],
    types: [{ label: "Choke", param: ParamId.ChokeGroup }],
    active: (g) =>
      g(ParamId.HitChance) < 0.999 || g(ParamId.AccentAmount) > 0.001 ||
      g(ParamId.Humanize) > 0.001 || g(ParamId.Ratchet) > 0.001 ||
      Math.round(g(ParamId.ChokeGroup)) > 0,
    duration: () => Infinity,
    curve: (g) => clamp01(g(ParamId.HitChance)),
    fromTo: (g) => `${Math.round(g(ParamId.HitChance) * 100)}% of hits play; ${Math.round(g(ParamId.Ratchet) * 100)}% burst into rolls`,
    about: "The per-HIT dice, not a curve over one note (drawn as a level line at the hit probability): chance a scheduled hit plays at all, how far non-accents duck, random level/pitch/cutoff jitter, and how often a hit bursts into a 2–4× roll. Choke lets this sound cut same-group sounds (closed hat chokes open hat). All neutral = inactive.",
    code: `// engine.js — perHit: the dice rolled for every scheduled hit
if (chance < 1 && Math.random() > chance) {
  if (Math.random() < GHOST_P) vel *= GHOST_LEVEL; // a quiet ghost…
  else return null;                                // …or dropped outright
}
if (!isAccent) vel *= 1 - ACCENT_DUCK * accent;    // non-accents duck
vel *= 1 + (Math.random() * 2 - 1) * 0.25 * human; // level jitter
if (Math.random() < ratchet) count = 2..4;         // a drum-roll burst`,
  },
];

/** The domain a finite trace lives on, as calculator notation ("t < 0.22s"), or null
    for a setting that persists across the whole note. */
export function traceDomain(tr: TraceSpec, get: ParamGet, ctx: TraceCtx): string | null {
  const d = tr.duration(get, ctx);
  if (!isFinite(d)) return null;
  return `t < ${d >= 1 ? `${Math.round(d * 100) / 100}s` : `${Math.round(d * 1000)}ms`}`;
}

/** A trace's formula pieces for the CURRENT values (static or live-computed). */
export function traceParts(tr: TraceSpec, get: ParamGet, ctx: TraceCtx): (string | number)[] {
  return typeof tr.parts === "function" ? tr.parts(get, ctx) : tr.parts;
}

/** The seconds the graph's x axis should span: the longest ACTIVE finite trace
    (persistent lines span whatever this is), clamped to a sane window. */
export function traceAxisSeconds(get: ParamGet, ctx: TraceCtx): number {
  let t = 0;
  for (const tr of SOUND_TRACES) {
    if (!tr.active(get)) continue;
    const d = tr.duration(get, ctx);
    if (isFinite(d)) t = Math.max(t, d);
  }
  return Math.max(0.25, Math.min(32, t || 0.5));
}
