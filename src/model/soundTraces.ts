// GRAPH MODE's model: the sound's settings as TIME FUNCTIONS. Each trace maps a few
// snapshot params onto one curve y(t) — the pitch envelope falling onto its base pitch,
// the amp ADSR, a layer's own decay, an LFO's wobble, the echo's dying repeats — with
// an editable FORMULA (each variable bound to a param), discrete TYPE rows for every
// real engine choice behind it (LFO wave/destination/sync, noise colour, filter type,
// echo sync/ping-pong, click type, modal material…), and a colour of its own so the
// lines read apart on one graph.
//
// A setting that persists for the whole note (pitch, filter, LFOs, steady FX) draws
// across the ENTIRE axis; one that genuinely ends (a click, a decaying layer, an echo
// tail) stops where it ends and states its DOMAIN next to the formula, calculator
// style ("t < 0.22s"). A trace whose level/amount is zero is INACTIVE (not drawn);
// giving its level a value brings it to life. The x axis is seconds and adapts to the
// longest active finite trace (a 1s echo stretches the axis to show its tail).

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

export interface TraceSpec {
  id: string;
  label: string;
  color: string;
  /** Formula text pieces interleaved with indices into `vars`. */
  parts: (string | number)[];
  vars: TraceVar[];
  /** Discrete "function type" rows (LFO wave + destination + sync, noise colour…). */
  types?: TraceType[];
  /** Whether the setting is audible at all (zero level/amount = inactive, not drawn). */
  active: (get: ParamGet) => boolean;
  /** Seconds the trace spans; Infinity = it persists for the whole note (drawn across
      the whole axis and excluded from the axis-length computation). */
  duration: (get: ParamGet) => number;
  /** Normalised y (0..1) at absolute time t seconds. */
  curve: (get: ParamGet, t: number) => number;
  /** A "from → to" recap of the values ("1190 Hz → 340 Hz"), for the editor. */
  fromTo?: (get: ParamGet) => string;
  /** What this trace is, for the editor's caption. */
  about: string;
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

/** An LFO trace (the three differ only in their param ids). The LFO runs as long as
    the note does, so it spans the whole axis; its wave, DESTINATION and tempo-sync are
    all editable types — the full function, not just its depth. */
function lfoTrace(
  n: 1 | 2 | 3, target: ParamId, rate: ParamId, depth: ParamId, shape: ParamId, sync: ParamId, color: string,
): TraceSpec {
  return {
    id: `lfo${n}`,
    label: `LFO ${n}`,
    color,
    parts: ["y(t) = ", 0, " · wave(", 1, "·t)"],
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
    curve: (g, t) => clamp01(0.5 + 0.5 * g(depth) * lfoWave(g(shape), g(rate) * t)),
    fromTo: (g) => `±${Math.round(g(depth) * 100)}% at ${r2(g(rate))} Hz` + (Math.round(g(sync)) > 0 ? " (rate overridden by Sync at the live tempo)" : ""),
    about: "A repeating wobble applied to its destination for the note's whole life — the wave is the function's shape, Dest picks WHAT it bends (pitch vibrato, filter wah, amp tremolo…), Sync beat-locks the rate. Depth 0 turns it off.",
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
  },
  {
    id: "tone", label: "Tone", color: "#ffd43b",
    parts: ["y(t) = ", 0, " · e^(−t/", 1, ")"],
    vars: [
      { sym: "L", param: ParamId.ToneLevel, step: 2, scale: 100, fmt: pctFmt },
      { sym: "D", param: ParamId.ToneDecay, step: 0.01, fmt: secFmt },
    ],
    active: (g) => g(ParamId.ToneLevel) > 0.001,
    // Its OWN decay ends it early; D = 0 follows the amp (persists with the note).
    duration: (g) => (g(ParamId.ToneDecay) > 0.004 ? Math.min(8, g(ParamId.ToneDecay) * 4) : Infinity),
    curve: (g, t) => layerCurve(g(ParamId.ToneLevel), g(ParamId.ToneDecay), t),
    fromTo: (g) => `${Math.round(g(ParamId.ToneLevel) * 100)}% → ${g(ParamId.ToneDecay) > 0.004 ? "0" : "held (follows the amp)"}`,
    about: "The oscillator layer's own level and decay clock (D = 0 rides the amp envelope for the whole note instead). L = 0 removes the tone entirely — noise-only sounds.",
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
  },
  {
    id: "click", label: "Click", color: "#63e6be",
    parts: ["y(t) = ", 0, " · e^(−t/τ)"],
    vars: [{ sym: "L", param: ParamId.ClickLevel, step: 2, scale: 100, fmt: pctFmt }],
    types: [{ label: "Type", param: ParamId.ClickType }],
    active: (g) => g(ParamId.ClickLevel) > 0.001,
    duration: (g) => Math.min(0.12, CLICK_DECAY[Math.max(0, Math.min(CLICK_DECAY.length - 1, Math.round(g(ParamId.ClickType))))] * 8 + 0.01),
    curve: (g, t) => clamp01(g(ParamId.ClickLevel) * Math.exp(-t / CLICK_DECAY[Math.max(0, Math.min(CLICK_DECAY.length - 1, Math.round(g(ParamId.ClickType))))])),
    fromTo: (g) => `${Math.round(g(ParamId.ClickLevel) * 100)}% → 0 in a few ms`,
    about: "The transient snap at the very start of each hit — a few milliseconds long (τ comes from the click type). L = 0 removes it. It genuinely ends, hence the short domain.",
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
  },
  lfoTrace(1, ParamId.LfoTarget, ParamId.LfoRate, ParamId.LfoDepth, ParamId.Lfo1Shape, ParamId.Lfo1Sync, "#b197fc"),
  lfoTrace(2, ParamId.Lfo2Target, ParamId.Lfo2Rate, ParamId.Lfo2Depth, ParamId.Lfo2Shape, ParamId.Lfo2Sync, "#e599f7"),
  lfoTrace(3, ParamId.Lfo3Target, ParamId.Lfo3Rate, ParamId.Lfo3Depth, ParamId.Lfo3Shape, ParamId.Lfo3Sync, "#f783ac"),
  {
    id: "echo", label: "Echo", color: "#66d9e8",
    parts: ["y(t) = ", 0, " · ", 1, "^(t/", 2, ")"],
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
    duration: (g) => {
      const f = clamp01(g(ParamId.EchoFeedback));
      const reps = f > 0.05 ? Math.min(10, Math.log(0.05) / Math.log(f)) : 1.5;
      return Math.min(8, Math.max(0.2, g(ParamId.EchoTime) * reps));
    },
    curve: (g, t) => clamp01(g(ParamId.EchoMix) * Math.pow(Math.max(0.02, g(ParamId.EchoFeedback)), t / Math.max(0.02, g(ParamId.EchoTime)))),
    fromTo: (g) => `${Math.round(g(ParamId.EchoMix) * 100)}% fading by ×${r2(g(ParamId.EchoFeedback))} every ${r2(g(ParamId.EchoTime))}s`,
    about: "The envelope of the echo's repeats: each pass T seconds later comes back F times as loud — the domain is how long the tail audibly rings. Sync locks T to the beat; ping-pong bounces repeats left/right. M = 0 turns it off.",
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
    about: "The reverb wash dying away — bigger rooms (S) ring longer, the mix (M) sets how much of the sound lives in it. M = 0 turns it off.",
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
    about: "The plucked-string resonator ringing at the note's pitch × tune — short D is a pluck, long D a sustained string. M = 0 turns it off.",
  },
  {
    id: "modal", label: "Modal", color: "#ffe066",
    parts: ["y(t) = ", 0, " · e^(−t/(0.45·4^(2(", 1, "−½))))"],
    vars: [
      { sym: "M", param: ParamId.ModalMix, step: 2, scale: 100, fmt: pctFmt },
      { sym: "D", param: ParamId.ModalDecay, step: 2, scale: 100, fmt: pctFmt },
    ],
    types: [{ label: "Material", param: ParamId.ModalMaterial }],
    active: (g) => g(ParamId.ModalMix) > 0.001,
    duration: (g) => Math.min(8, 0.45 * Math.pow(4, (clamp01(g(ParamId.ModalDecay)) - 0.5) * 2) * 3),
    curve: (g, t) => clamp01(g(ParamId.ModalMix) * Math.exp(-t / (0.45 * Math.pow(4, (clamp01(g(ParamId.ModalDecay)) - 0.5) * 2)))),
    fromTo: (g) => `${Math.round(g(ParamId.ModalMix) * 100)}% ringing`,
    about: "The bell/bar/membrane resonator bank ringing at the note's modes — the material is the type, D scales how long it rings. M = 0 turns it off.",
  },
];

/** The domain a finite trace lives on, as calculator notation ("t < 0.22s"), or null
    for a setting that persists across the whole note. */
export function traceDomain(tr: TraceSpec, get: ParamGet): string | null {
  const d = tr.duration(get);
  if (!isFinite(d)) return null;
  return `t < ${d >= 1 ? `${Math.round(d * 100) / 100}s` : `${Math.round(d * 1000)}ms`}`;
}

/** The seconds the graph's x axis should span: the longest ACTIVE finite trace
    (persistent lines span whatever this is), clamped to a sane window. */
export function traceAxisSeconds(get: ParamGet): number {
  let t = 0;
  for (const tr of SOUND_TRACES) {
    if (!tr.active(get)) continue;
    const d = tr.duration(get);
    if (isFinite(d)) t = Math.max(t, d);
  }
  return Math.max(0.25, Math.min(32, t || 0.5));
}
