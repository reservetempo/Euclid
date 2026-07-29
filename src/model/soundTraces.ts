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

import { ParamId, ENGINE_TABLES, choiceLabels, PITCH_DRAW_BASE, PITCH_DRAW_SLOTS } from "./params";
import { LFO_NONE, ENV_SHAPES, PITCH_SHAPES, MODFX_TYPES, WAVETABLES } from "./paramSpec";
import { BlendShapeId, blendShape, blendShapeSpec } from "./lines";

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

/** Span of the frequency axis, in octaves — what the full height of the graph is worth. */
const HZ_AXIS_OCTAVES = Math.log2(12000 / 20);

/** The frequency axis, both ways. Exported because the draw overlay has to read a canvas y
    back as a real frequency: a drawn contour is only honest if the height you drew at means
    the same Hz the graph would have drawn it at. */
export const hzToNorm = hzNorm;
export const normToHz = (y: number) => 20 * Math.pow(2, clamp01(y) * HZ_AXIS_OCTAVES);

// The engine's own tables, read from the parameter registry rather than copied: the graph
// is only honest if it draws from the numbers the DSP actually uses (see params.ts).
const CLICK_DECAY = ENGINE_TABLES.CLICK_DECAY;
const CRUSH_BITS = ENGINE_TABLES.CRUSH_BITS;
const DOWNSAMPLE_FACTOR = ENGINE_TABLES.DOWNSAMPLE_FACTOR;
const LFO_SYNC_BEATS = ENGINE_TABLES.LFO_SYNC_BEATS;
const ECHO_SYNC_BEATS = ENGINE_TABLES.ECHO_SYNC_BEATS;
const MODAL_TABLES = ENGINE_TABLES.MODAL_TABLES;
const MODAL_NAMES = choiceLabels(ParamId.ModalMaterial);
// Unison voice COUNT per index (the label for index 0 is "Off"; the count is 1).
const UNISON_VOICES = ENGINE_TABLES.UNISON_VOICES;
// Display spellings of the sync divisions: the registry's labels with typographic dots,
// and "1 bar" for the longest LFO division — prettier than "1/16." and "1/1" in a formula.
const LFO_SYNC_NAMES = choiceLabels(ParamId.Lfo1Sync)
  .map((s) => s.replace(".", "·"))
  .map((s) => (s === "1/1" ? "1 bar" : s));

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

// Envelope-contour shapes for the pitch sweep + the layer decays. Stored index →
// BlendShapeId (null = "Exp", the legacy exponential) — the registry's own mapping, the
// same one the engine is handed.
const ENV_SHAPE_IDS = ENGINE_TABLES.ENV_SHAPE_IDS as (BlendShapeId | null)[];
const envShapeIdx = (v: number) => Math.max(0, Math.min(ENV_SHAPE_IDS.length - 1, Math.round(v)));
const envShapeId = (v: number): BlendShapeId | null => ENV_SHAPE_IDS[envShapeIdx(v)];

// The PITCH sweep's own contour list: the eight above at the same indices, plus "drawn". It
// needs its own lookup because clamping a Drawn index against the 8-entry table would land
// on Wobble and the graph would draw a curve the engine isn't playing.
const PITCH_SHAPE_IDS = ENGINE_TABLES.PITCH_SHAPE_IDS as (BlendShapeId | null)[];
const pitchShapeIdx = (v: number) => Math.max(0, Math.min(PITCH_SHAPE_IDS.length - 1, Math.round(v)));
const isPitchDrawn = (v: number): boolean => PITCH_SHAPE_IDS[pitchShapeIdx(v)] === "drawn";

/** The drawn pitch contour's octave offset at u ∈ [0,1] across the graph's width — the
    main-thread twin of drawnOctaves in engine.js. Linear interpolation over the PitchDraw
    slots, unclamped because an octave offset is signed. */
function drawnOctaves(get: ParamGet, u: number): number {
  const n = PITCH_DRAW_SLOTS;
  const x = Math.max(0, Math.min(1, u)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  const a = get((PITCH_DRAW_BASE + i) as ParamId);
  const b = get((PITCH_DRAW_BASE + i + 1) as ParamId);
  return a + (b - a) * (x - i);
}

/** The Hz the drawn contour reaches at its lowest and highest sample, for the recap line. */
function drawnRange(get: ParamGet): { lo: number; hi: number } {
  const p = get(ParamId.Pitch);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < PITCH_DRAW_SLOTS; i++) {
    const v = get((PITCH_DRAW_BASE + i) as ParamId);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo: p * Math.pow(2, lo), hi: p * Math.pow(2, hi) };
}

/** A shaped decay envelope value (1 → 0/…) at time t over a window of D seconds — mirrors
    the engine: null shape = the legacy e^(−t/D); otherwise 1 − blendShape(t/D), so it starts
    at 1 and (for the monotonic shapes) leaves at 0, while sine/wobble rise-and-fall en route. */
function shapedDecay(shape: BlendShapeId | null, curve: number, cycles: number, t: number, D: number): number {
  const d = Math.max(0.001, D);
  return shape === null ? Math.exp(-t / d) : 1 - blendShape({ shape, curve, cycles }, Math.min(1, t / d));
}

/** Where a shaped envelope's decay/curve/cycles knobs sit in its trace's own `vars` array —
    the formula text interleaves these indices, so they must match that array's order. */
interface ShapeVarIdx {
  decay: number;
  curve: number;
  cycles: number;
}

/** The formula-text pieces for a shaped envelope (used by pitch + the layer decays): the
    exponential form for Exp, else "<shape>(t/D)" with the shape's curve knob and (for the
    periodic shapes) its wave count. */
function shapeParts(
  shapeVal: number, lead: (string | number)[], tail: string, at: ShapeVarIdx,
): (string | number)[] {
  const shape = envShapeId(shapeVal);
  if (shape === null) return [...lead, "e^(−t/", at.decay, ")", tail];
  const nm = ENV_SHAPES[envShapeIdx(shapeVal)].toLowerCase();
  const spec = blendShapeSpec(shape);
  const out = [...lead, `${nm}(t/`, at.decay, ")", tail, `  ·  ${spec.curveLabel} `, at.curve];
  return spec.usesCycles ? [...out, ", waves ", at.cycles] : out;
}

/** The chosen material's index into the mode tables, clamped. */
const modalIndex = (get: ParamGet) =>
  Math.max(0, Math.min(MODAL_TABLES.length - 1, Math.round(get(ParamId.ModalMaterial))));

/** The modal ring envelope: the material's real mode sum Σ gₖ·e^(−t/τₖ), τₖ scaled by
    the decay knob (0.45s base · 4^(2(D−½)) · the material's per-mode weight). */
function modalCurve(get: ParamGet, t: number): number {
  const mat = modalIndex(get);
  const scale = ENGINE_TABLES.MODAL_BASE_DECAY * Math.pow(4, (clamp01(get(ParamId.ModalDecay)) - 0.5) * 2);
  const ds = MODAL_TABLES[mat].d, gs = MODAL_TABLES[mat].g;
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
    active: (g) => g(depth) > 0.001 && Math.round(g(target)) !== LFO_NONE, // hide when routed to "None"
    duration: () => Infinity, // the wobble runs as long as the note does
    curve: (g, t, ctx) => clamp01(0.5 + 0.5 * g(depth) * lfoWave(g(shape), lfoHz(g, rate, sync, ctx) * t)),
    fromTo: (g, ctx) => `±${Math.round(g(depth) * 100)}% at ${r2(lfoHz(g, rate, sync, ctx))} Hz`,
    about: "A repeating wobble applied to its destination for the note's whole life — the wave is the function's shape and Dest picks WHAT it bends. The bends fall into two families. Bipolar ones swing symmetrically around the current value: Pitch (vibrato, ±½ octave at full depth), Filter (wah, ±2 octaves), Amp (tremolo down to silence), Ring (through-zero AM), Wave (the square's pulse width — silent on sine/tri/saw), and WTPos (sweeps a wavetable's scan — needs a Table chosen). The \"amount\" ones instead DRIVE their effect up from wherever it sits, so they bite even from off: Drive pumps saturation, Reso pushes the filter into squelchy resonance, Crush pumps the bit-crush grit, and Noise INJECTS noise — blending the noise level up toward full (and ducking the tone) so the crest can hand the whole sound over to noise, even when the noise layer is silent: a rhythmic noise burst rather than a tremolo. Sync beat-locks one cycle to that note length at the live tempo (the Rate knob is ignored then, and the formula shows the synced rate). Depth 0 turns it off.",
    code: `// engine.js — Voice.renderAdding: the per-sample LFO
const beats = LFO_SYNC_BEATS[sync] || 0;
lfoInc = (beats > 0 ? tempo / (60 * beats)   // synced: one cycle per division
                    : lfoRate) / sampleRate; // free: the Rate knob in Hz
v = shape === S_AND_H ? heldRandom : lfoWave(shape, lfoPhase); // -1..1
lfoPhase += lfoInc;
const u = 0.5 + 0.5 * v;                      // unipolar 0..1, for the "amount" dests
switch (target) {
  case PITCH:  pitchMul  *= Math.pow(2, v * depth * 0.5);        break; // vibrato
  case FILTER: cutoffMul *= Math.pow(2, v * depth * 2);          break; // wah
  case AMP:    ampMul    *= 1 - depth * (0.5 * (1 - v));         break; // tremolo
  case RING:   ringMul   *= 1 + v * depth;                       break; // through-zero AM
  case WAVE:   pwOff     += v * depth * 0.45;                    break; // pulse width (square)
  case DRIVE:  driveAdd  += u * depth * 2;                       break; // pump saturation
  case RESO:   resoMul   *= Math.pow(2, u * depth * 2.5);        break; // into resonance
  case CRUSH:  crushShift += u * depth * 8;                      break; // pump bit-crush
  case NOISE:  noiseInj  += u * depth;                           break; // inject/override noise
  // NOISE at the mix: noiseAmp += (1 - noiseAmp) * inj; toneAmp *= 1 - 0.7 * inj;
}`,
  };
}

/** The trace set, in display order. Colours are hand-picked to stay apart on dark. */
export const SOUND_TRACES: TraceSpec[] = [
  {
    id: "pitch", label: "Pitch", color: "#ff6b6b",
    // Drawn has no formula to print — the drawing IS the formula — so it states the one
    // thing the graph can't show on its own: that t is normalised by the axis width, and
    // that A/D/curve/waves are out of the picture.
    parts: (g, ctx) => isPitchDrawn(g(ParamId.PitchEnvShape))
      ? ["f(t) = ", 0, " · 2^draw(t / ", `${r2(traceAxisSeconds(g, ctx))}s`, ") Hz"]
      : shapeParts(g(ParamId.PitchEnvShape), ["f(t) = ", 0, " · (1 + ", 1, " · "], ") Hz",
        { decay: 2, curve: 3, cycles: 4 }),
    vars: [
      { sym: "P", param: ParamId.Pitch, step: 5, fmt: hzFmt },
      { sym: "A", param: ParamId.PitchEnvAmount, step: 0.1, fmt: (v) => String(r2(v)) },
      { sym: "D", param: ParamId.PitchEnvDecay, step: 0.01, fmt: secFmt },
      { sym: "curve", param: ParamId.PitchEnvCurve, step: 2, scale: 100, fmt: pctFmt },
      { sym: "waves", param: ParamId.PitchEnvCycles, step: 0.25, fmt: (v) => String(r2(v)) },
    ],
    types: [{ label: "Shape", param: ParamId.PitchEnvShape }],
    active: (g) => g(ParamId.ToneLevel) > 0.001,
    // Infinity even in Drawn mode, and that is load-bearing: the drawn contour is stretched
    // over traceAxisSeconds, so reporting a finite duration here would feed the very span
    // that sets its own length.
    duration: () => Infinity, // the tone holds its base pitch for the whole note
    // Drawn: the freehand contour, read as octave offsets across the graph's full width.
    // Everything else: the classic sweep over the D window.
    curve: (g, t, ctx) => {
      if (isPitchDrawn(g(ParamId.PitchEnvShape))) {
        const span = traceAxisSeconds(g, ctx);
        return hzNorm(g(ParamId.Pitch) * Math.pow(2, drawnOctaves(g, span > 0 ? t / span : 0)));
      }
      return hzNorm(g(ParamId.Pitch) * (1 + g(ParamId.PitchEnvAmount)
        * shapedDecay(envShapeId(g(ParamId.PitchEnvShape)), g(ParamId.PitchEnvCurve), g(ParamId.PitchEnvCycles), t, g(ParamId.PitchEnvDecay))));
    },
    fromTo: (g) => {
      const p = g(ParamId.Pitch);
      const nm = PITCH_SHAPES[pitchShapeIdx(g(ParamId.PitchEnvShape))];
      if (isPitchDrawn(g(ParamId.PitchEnvShape))) {
        const r = drawnRange(g);
        return `${Math.round(r.lo)} Hz … ${Math.round(r.hi)} Hz  (${nm})`;
      }
      return `${Math.round(p * (1 + g(ParamId.PitchEnvAmount)))} Hz → ${Math.round(p)} Hz  (${nm})`;
    },
    about: "The tone's frequency for the note's whole life. It starts at P·(1+A) and moves toward the base pitch P over the D window (negative A rises up into the note instead). SHAPE picks HOW it travels: Exp is the classic exponential drop; Line is a straight sloped ramp whose angle the curve bends toward exponential; S-curve/Parabola bend differently; and Sine/Cos/Triangle/Wobble make the pitch rise AND fall across the sweep (waves = how many times). DRAWN is the odd one out: instead of a formula it plays a curve you sketch by hand, stretched across the WHOLE width of this graph rather than over D — so shaping the sound longer (a longer tail, a bigger reverb) stretches the contour with it. Because it carries its own full excursion, Drawn ignores A, D, curve and waves entirely; its samples are octave offsets from P, so the contour still transposes with the base pitch and still follows the key. For a continuous wobble over the whole note instead, point an LFO at Pitch.",
    code: `// engine.js — Voice.renderAdding: the per-sample pitch (env runs 1→0)
let freq = basePitch * (1 + pitchEnvAmount * pitchEnv) * pitchMul;
if (pitchEnvShape === null) pitchEnv *= pitchEnvCoef;      // Exp: exp(−t/D)
else pitchEnv = 1 - shapeT(min(1, t/D), {shape, curve, cycles}); // shaped contour
// "Drawn": Amount is forced to 0, so the sweep above is exactly 1 and the hand-drawn
// contour (octave offsets, stretched over the graph's width) just multiplies on top.
if (pitchDrawn) freq *= 2 ** drawnOctaves(pitchDraw, pitchDrawT++, pitchDrawDur);`,
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
      return Math.min(62, Math.max(g(ParamId.AmpAttack) + g(ParamId.AmpDecay), gate) + g(ParamId.AmpRelease) + 0.02);
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
    about: "The master loudness shape every hit rides from trigger to silence — the single biggest thing deciding whether a sound reads as a drum or a pad. It climbs over the attack (atk, bent by a-curve — under 50 is plucky and immediate, over 50 a slow swell), falls to the sustain level over the decay (dec, bent by d-curve — low is a gated hold-then-drop, high the natural percussive tail), holds at that level while the note is gated on, then fades over the release (rel). With sustain at 0 the hit dies during its decay and never holds — the normal drum case; raise sustain for held notes and drones.",
    code: `// engine.js — the shaped ADSR (t = each segment's 0..1 phase)
attack:  value = Math.pow(t, aExp);                    // a-curve → aExp = 4^(2s−1)
decay:   value = sus + (1 - sus) * Math.pow(1 - t, dExp);
release: value = start * Math.pow(1 - t, dExp);
// note-off after the hold:
if (samplesPlayed >= gateSeconds * sampleRate) adsr.noteOff();`,
  },
  {
    id: "tone", label: "Tone", color: "#ffd43b",
    parts: (g) => shapeParts(g(ParamId.ToneEnvShape), ["y(t) = ", 0, " · "], "",
      { decay: 1, curve: 2, cycles: 3 }),
    vars: [
      { sym: "L", param: ParamId.ToneLevel, step: 2, scale: 100, fmt: pctFmt },
      { sym: "D", param: ParamId.ToneDecay, step: 0.01, fmt: secFmt },
      { sym: "curve", param: ParamId.ToneEnvCurve, step: 2, scale: 100, fmt: pctFmt },
      { sym: "waves", param: ParamId.ToneEnvCycles, step: 0.25, fmt: (v) => String(r2(v)) },
    ],
    types: [{ label: "Wave", param: ParamId.Waveform }, { label: "Shape", param: ParamId.ToneEnvShape }],
    active: (g) => g(ParamId.ToneLevel) > 0.001,
    // Its OWN decay ends it early; D = 0 follows the amp (persists with the note).
    duration: (g) => (g(ParamId.ToneDecay) > 0.004 ? Math.min(8, g(ParamId.ToneDecay) * 4) : Infinity),
    curve: (g, t) => clamp01(g(ParamId.ToneLevel) * (g(ParamId.ToneDecay) > 0.004
      ? shapedDecay(envShapeId(g(ParamId.ToneEnvShape)), g(ParamId.ToneEnvCurve), g(ParamId.ToneEnvCycles), t, g(ParamId.ToneDecay))
      : 1)),
    fromTo: (g) => `${Math.round(g(ParamId.ToneLevel) * 100)}% → ${g(ParamId.ToneDecay) > 0.004 ? `0 (${ENV_SHAPES[envShapeIdx(g(ParamId.ToneEnvShape))]})` : "held (follows the amp)"}`,
    about: "The pitched oscillator layer — the part of the hit that has a note. L is its level; D gives it its OWN decay clock, separate from the amp envelope, so the tone can die faster (a short thump under a long sizzle) or ring on longer. D = 0 means it simply rides the amp envelope for the whole note. SHAPE bends that decay contour — Exp is the classic exponential fall, Line a straight slope, S-curve/Parabola bow differently, and Sine/Cos/Triangle/Wobble make the layer swell and duck as it fades (waves = how many times). L = 0 removes the tone entirely, leaving a noise-only sound.",
    code: `// engine.js — Voice.renderAdding: the tone layer's own clock (env 1→0)
let toneAmp = toneLevel;
if (toneEnvCoef > 0) {          // D > 0: its own decay
  toneAmp *= toneEnv;
  if (toneEnvShape === null) toneEnv *= toneEnvCoef;        // Exp: exp(−t/D)
  else toneEnv = 1 - shapeT(min(1, t/D), {shape, curve, cycles}); // shaped
}                               // D = 0: rides the amp ADSR instead
mixed = toneAmp * osc + noiseAmp * noise;`,
  },
  {
    id: "noise", label: "Noise", color: "#a9e34b",
    parts: (g) => shapeParts(g(ParamId.NoiseEnvShape), ["y(t) = ", 0, " · "], "",
      { decay: 1, curve: 2, cycles: 3 }),
    vars: [
      { sym: "L", param: ParamId.NoiseLevel, step: 2, scale: 100, fmt: pctFmt },
      { sym: "D", param: ParamId.NoiseDecay, step: 0.01, fmt: secFmt },
      { sym: "curve", param: ParamId.NoiseEnvCurve, step: 2, scale: 100, fmt: pctFmt },
      { sym: "waves", param: ParamId.NoiseEnvCycles, step: 0.25, fmt: (v) => String(r2(v)) },
    ],
    types: [{ label: "Colour", param: ParamId.NoiseType }, { label: "Shape", param: ParamId.NoiseEnvShape }],
    active: (g) => g(ParamId.NoiseLevel) > 0.001,
    duration: (g) => (g(ParamId.NoiseDecay) > 0.004 ? Math.min(8, g(ParamId.NoiseDecay) * 4) : Infinity),
    curve: (g, t) => clamp01(g(ParamId.NoiseLevel) * (g(ParamId.NoiseDecay) > 0.004
      ? shapedDecay(envShapeId(g(ParamId.NoiseEnvShape)), g(ParamId.NoiseEnvCurve), g(ParamId.NoiseEnvCycles), t, g(ParamId.NoiseDecay))
      : 1)),
    fromTo: (g) => `${Math.round(g(ParamId.NoiseLevel) * 100)}% → ${g(ParamId.NoiseDecay) > 0.004 ? `0 (${ENV_SHAPES[envShapeIdx(g(ParamId.NoiseEnvShape))]})` : "held (follows the amp)"}`,
    about: "The un-pitched noise layer — the hiss, sizzle and crackle where hats, snares and cymbals live. L is its level; D gives it its own decay clock (D = 0 rides the amp for the whole note), so the sizzle can outlast or undercut the tone. SHAPE bends that decay the same way the tone's does — Exp fall, Line slope, or Sine/Wobble swell-and-duck. The colour tilts its spectrum, from flat white hiss through warm pink and dark brown to bright blue/violet, sparse crackle and gritty metal. L = 0 turns the layer off.",
    code: `// engine.js — Voice.renderAdding: the noise layer + its colour (env 1→0)
const noise = this.nextNoise();  // white / pink / brown / blue / violet /
                                 // crackle (sparse impulses) / metal (S&H)
let noiseAmp = noiseLevel;
if (noiseEnvCoef > 0) {
  noiseAmp *= noiseEnv;
  if (noiseEnvShape === null) noiseEnv *= noiseEnvCoef;      // Exp: exp(−t/D)
  else noiseEnv = 1 - shapeT(min(1, t/D), {shape, curve, cycles}); // shaped
}
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
    about: "The transient snap at the very start of each hit — only a few milliseconds long (the τ in the formula is set by the click type), layered on top for extra point and definition so the sound cuts through even when its body is soft. L is how loud it is; L = 0 removes it. Match the type to the sound — Knock for kicks, Tick/Snap for hats and snares, Blip/Clank for blips and percussion. Unlike most layers it genuinely ends almost at once, which is why its curve occupies only a sliver at the far left of the graph.",
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
    about: "Where the filter sits across the note — its cutoff C (drawn on the same log-frequency scale as Pitch) and resonance Q (the emphasis peak right at the cutoff). It draws as a steady line because on its own the filter holds still for the whole note; the Type decides what that line means — LP darkens by cutting highs, HP thins by cutting lows, BP narrows to a band, and Vowel morphs through the A–E–I–O–U vowels as the cutoff moves. High Q makes the filter sing and zing on a sweep. Point an LFO at Filter to make the cutoff sweep — that's wah and dubstep wobble, and in Vowel type it literally makes the sound talk.",
    code: `// engine.js — Voice.renderAdding: the TPT state-variable filter
const cutoff = clamp(filterCutoff * cutoffMul, 20, nyquist); // LFO rides cutoffMul
const gCoef = Math.tan(Math.PI * cutoff / sampleRate);
const k = 1 / clamp(reso * resoMul, 0.3, 20);                // Q
filtered = svf.process(mixed, gCoef, k, type);               // LP / HP / BP
// Vowel type instead morphs three formant bandpasses A-E-I-O-U along Cutoff.`,
  },
  lfoTrace(1, ParamId.Lfo1Target, ParamId.Lfo1Rate, ParamId.Lfo1Depth, ParamId.Lfo1Shape, ParamId.Lfo1Sync, "#b197fc"),
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
    about: "The dying tail of the echo repeats: each pass arrives T seconds after the last and comes back F (feedback) times as loud, so the curve traces how the repeats fade — the domain is how long the tail stays audible. Higher F means more repeats and a longer trail; M (mix) sets how loud the echoes are against the dry hit, and M = 0 turns it off. Sync locks the delay to a beat division at the live tempo (the T knob is ignored then, and the formula shows the synced time) so repeats land on the grid; ping-pong bounces the repeats left/right for a wide stereo delay.",
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
    about: "The reverb wash dying away after each hit — the tail that places the sound in a space. Bigger rooms (S) ring longer, so the curve decays more slowly; the mix (M) sets how much of the sound lives in that space, and M = 0 turns it off. A touch adds air and depth; a lot blurs the hit into a long ambient cloud that fills the gaps between hits. (The drawn decay is a simple portrait — the real reverb is 8 comb + 4 allpass filters.)",
    code: `// engine.js — Reverb (freeverb): 8 combs + 4 allpasses, ring time from S
this.roomSize = size * 0.28 + 0.7;   // comb feedback — bigger S rings longer
for (const c of combs) out += c.process(input, damp, this.roomSize);
for (const a of allpasses) out = a.process(out);
buf[i] = out * wet + buf[i] * dry;   // M sets wet/dry`,
  },
  {
    id: "modfx", label: "Mod FX", color: "#ff922b",
    parts: (g) => {
      const ty = MODFX_TYPES[Math.max(0, Math.min(3, Math.round(g(ParamId.ModFxType))))];
      return ["y(t) = ", 0, ` wet · ${ty} @ `, 1, "Hz  (steady)"];
    },
    vars: [
      { sym: "M", param: ParamId.ModFxMix, step: 2, scale: 100, fmt: pctFmt },
      { sym: "rate", param: ParamId.ModFxRate, step: 0.1, fmt: (v) => String(r2(v)) },
      { sym: "depth", param: ParamId.ModFxDepth, step: 2, scale: 100, fmt: pctFmt },
      { sym: "fb", param: ParamId.ModFxFeedback, step: 2, scale: 100, fmt: pctFmt },
    ],
    types: [{ label: "Type", param: ParamId.ModFxType }],
    active: (g) => Math.round(g(ParamId.ModFxType)) !== 0 && g(ParamId.ModFxMix) > 0.001,
    duration: () => Infinity,
    curve: (g) => clamp01(g(ParamId.ModFxMix)),
    fromTo: (g) => `${Math.round(g(ParamId.ModFxMix) * 100)}% ${MODFX_TYPES[Math.max(0, Math.min(3, Math.round(g(ParamId.ModFxType))))]} at ${r2(g(ParamId.ModFxRate))} Hz`,
    about: "A modulated stereo effect placed after the echo and reverb — Chorus (lush detuned width), Flanger (a swirling jet-plane comb sweep) or Phaser (softer sweeping notches). It sweeps back and forth at Rate, as far as Depth, with feedback (fb) adding resonance for a sharper flanger/phaser (chorus ignores fb). The wet level holds constant across the note, so it draws as a flat line at the mix amount. Mix 0 or Type Off = inactive. It's the finishing 'movement and width' effect — a little for stereo width, a lot for obvious motion.",
    code: `// engine.js — Channel.renderInto: the stereo modulation FX (after reverb)
this.modfx.setup(modType, rate, depth, feedback);
this.modfx.render(scratch, n, wetL, wetR); // quadrature LFO L/R → real width
masterL[i] += s * gl * (1 - mix) + wetL[i] * mix; // blended by Mix`,
  },
  {
    id: "drive", label: "Drive", color: "#e8590c",
    parts: ["y(t) = ", 0, " (steady)"],
    vars: [{ sym: "D", param: ParamId.Drive, step: 0.05, fmt: (v) => String(r2(v)) }],
    active: (g) => g(ParamId.Drive) > 0.001,
    duration: () => Infinity,
    curve: (g) => clamp01(g(ParamId.Drive) / 2),
    fromTo: (g) => `${r2(g(ParamId.Drive))} of 2 the whole time`,
    about: "A tanh saturator pressed onto the whole post-filter sound: low amounts fatten and glue the layers together, high amounts overdrive into buzz and clip the peaks (its makeup is bounded so it thickens rather than just getting louder). Constant across the note, so it draws as a level line — point an LFO at Drive and it now pumps the saturation up hard on each crest (a rhythmic grind), and reach for it to make a thin tone sit bigger in the mix. 0 is clean.",
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
    about: "Lo-fi digital degradation, steady across the note (the line's height is how hard it bites). Bits quantises the wave to fewer levels — 12-bit is a subtle vintage grit, each step down (10, 8, 6…) harsher, 3-bit fully destroyed. Rate ÷ holds each sample for several in a row, dulling and dirtying the top end like a cheap old sampler (telephone grit to broken-console). Both Off = inactive; the two stack for a full lo-fi treatment, and they're grittier and more digital than Drive's warm saturation. Point an LFO at Crush to make the grit pump in time.",
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
    about: "A wavefolder: instead of clipping the peaks flat, it folds the waveform back on itself through a sine shaper, so more input keeps adding new harmonics — subtle amounts add a metallic sheen, high amounts turn even a plain sine into a bright, hollow, almost-vocal buzz. Steady across the note, so it draws as a level line; it pairs especially well with a slow Pitch or Filter LFO, which sweeps the folds. 0 is off (the dry wave is untouched).",
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
    about: "A second oscillator blended in under the first at level M, tuned apart by dt semitones — drawn as a steady line at its mix. Tiny detune (a fraction of a semitone) gives a fat, slowly beating unison; -12 adds a sub octave for weight; +7 a fifth (that cowbell clang). Hard sync instead snaps its cycle back to the first oscillator every time oscillator 1 restarts, for the classic ripping, vowel-y sync tone — sweep the detune to hear it tear. M = 0 turns it off.",
    code: `// engine.js — Voice.renderAdding: the detuned second oscillator
osc2Ratio = Math.pow(2, detuneSemitones / 12);
osc += osc2Wave * mix;
osc2Phase += (freq * osc2Ratio) / sampleRate;
if (hardSync && osc1Wrapped) osc2Phase = 0; // snap to oscillator 1's cycle`,
  },
  {
    id: "fm", label: "FM / Ring", color: "#faa2c1",
    parts: ["y(t) = ", 0, " at ×", 1, ", fb ", 2],
    vars: [
      { sym: "A", param: ParamId.OscModAmount, step: 2, scale: 100, fmt: pctFmt },
      { sym: "r", param: ParamId.OscModRatio, step: 0.05, fmt: (v) => String(r2(v)) },
      { sym: "fb", param: ParamId.FmFeedback, step: 2, scale: 100, fmt: pctFmt },
    ],
    types: [{ label: "Type", param: ParamId.OscModType }],
    active: (g) => g(ParamId.OscModAmount) > 0.001 && Math.round(g(ParamId.OscModType)) !== 0,
    duration: () => Infinity,
    curve: (g) => clamp01(g(ParamId.OscModAmount)),
    fromTo: (g) => `${Math.round(g(ParamId.OscModAmount) * 100)}% at ratio ${r2(g(ParamId.OscModRatio))}${g(ParamId.FmFeedback) > 0.001 ? `, fb ${Math.round(g(ParamId.FmFeedback) * 100)}%` : ""}`,
    about: "A second operator that bends the main oscillator for tones a single wave can't make — FM (growl, bells, electric pianos) or Ring (metallic, inharmonic, robotic clang), chosen by Type. It runs at a frequency ratio r of the note: whole-number ratios (1×, 2×, 3×) stay harmonic and musical, in-between ratios (1.5×, 2.7×…) go clangy and bell-like. A (amount) is how hard it pushes — from a subtle sheen up to a gnarly, noisy growl. Feedback (fb) folds the FM operator back on itself, morphing its sine toward a saw and then noise for a grittier, brighter FM (fb affects FM only). Amount 0, or Type Off, disables it. It draws as a steady line at the amount, since the modulation holds across the whole note.",
    code: `// engine.js — Voice.renderAdding: the second operator (with self-feedback)
this.fbMod = Math.sin(2π * modPhase + fmFeedback * this.fbMod); // fb: sine → saw → noise
modOut = this.fbMod;
modPhase += (freq * ratio) / sampleRate;    // a sine at freq × r
// FM:   carrierPhase += modOut * amount * FM_INDEX;
// Ring: osc *= 1 - amount + amount * modOut;`,
  },
  {
    id: "unison", label: "Unison", color: "#3bc9db",
    parts: (g) => {
      const n = UNISON_VOICES[Math.max(0, Math.min(3, Math.round(g(ParamId.Unison))))];
      return ["y(t) = ", 0, ` spread · ${n} voices  (steady)`];
    },
    vars: [{ sym: "spread", param: ParamId.UnisonDetune, step: 2, scale: 100, fmt: pctFmt }],
    types: [{ label: "Voices", param: ParamId.Unison }],
    active: (g) => Math.round(g(ParamId.Unison)) > 0,
    duration: () => Infinity,
    curve: (g) => clamp01(g(ParamId.UnisonDetune)),
    fromTo: (g) => `${UNISON_VOICES[Math.max(0, Math.min(3, Math.round(g(ParamId.Unison))))]} voices, ${Math.round(g(ParamId.UnisonDetune) * 100)}% spread`,
    about: "Stacks several slightly detuned copies of the main oscillator — 3, 5 or 7 voices — for a much thicker, wider supersaw-style sound, drawn as a steady line at the detune spread. More voices are bigger and more chorused (and cost more, with a softer transient). Spread sets how far the copies drift apart in pitch: a touch fattens, a lot swirls into a wide, seasick detune — too much starts to sound out of tune. Voices Off = the single classic oscillator.",
    code: `// engine.js — Voice.renderAdding: the unison stack (primary osc)
for (let u = 0; u < unisonCount; u++) {
  let ph = uPhase[u] + fmOff; ph -= Math.floor(ph);
  sum += this.osc(ph, waveform, pw, dt * uDetune[u]); // detune spread in cents
}
osc = sum * unisonNorm; // normalise by 1/√count`,
  },
  {
    id: "wavetable", label: "Wavetable", color: "#da77f2",
    parts: (g) => {
      const fam = WAVETABLES[Math.max(0, Math.min(4, Math.round(g(ParamId.WaveTable))))];
      return ["y(t) = scan ", 0, `  — ${fam} table  (steady)`];
    },
    vars: [{ sym: "scan", param: ParamId.WavePosition, step: 2, scale: 100, fmt: pctFmt }],
    types: [{ label: "Table", param: ParamId.WaveTable }],
    active: (g) => Math.round(g(ParamId.WaveTable)) > 0,
    duration: () => Infinity,
    curve: (g) => clamp01(g(ParamId.WavePosition)),
    fromTo: (g) => `${WAVETABLES[Math.max(0, Math.min(4, Math.round(g(ParamId.WaveTable))))]} table at ${Math.round(g(ParamId.WavePosition) * 100)}% scan`,
    about: "Replaces the analog Sine/Tri/Square/Saw with a scannable digital wavetable — a bank of morphing frames. The Table picks the family (Formant, Harmonic, Vocal or Digital), each with its own evolving character, and Scan crossfades through the frames to morph the timbre, from one tone into a very different one across the sweep. Point an LFO at WTPos (or sweep Scan per hit) for that continuously-evolving, Serum-style digital motion. Table Off = the normal analog oscillator.",
    code: `// engine.js — Voice.renderAdding: the wavetable oscillator (wtFamily > 0)
osc = this.wtFamily > 0
  ? wtSample(this.wtFamily - 1, this.wtPos + wtPosOff, ph, dt) // scan crossfades frames
  : this.osc(ph, this.waveform, pw, dt);                       // else the analog wave`,
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
    about: "A plucked-string resonator (Karplus–Strong): it rings at the note's pitch × tune, turning a click or noise burst into a struck or plucked string tone. M (mix) blends it against the dry sound; D sets the ring — short D is a dead, muted pluck, long D a sustained, singing string (the curve is a portrait of that ring time). Because tune tracks the pitch, the ring stays in key as the notes change; whole ratios stay musical, odd ones go metallic. M = 0 turns it off.",
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
      const mat = modalIndex(g);
      return ["y(t) = ", 0, ` · Σ gₖ·e^(−t/τₖ)  — ${MODAL_TABLES[mat].d.length} ${MODAL_NAMES[mat]} modes, τ scaled by `, 1];
    },
    vars: [
      { sym: "M", param: ParamId.ModalMix, step: 2, scale: 100, fmt: pctFmt },
      { sym: "D", param: ParamId.ModalDecay, step: 2, scale: 100, fmt: pctFmt },
    ],
    types: [{ label: "Material", param: ParamId.ModalMaterial }],
    active: (g) => g(ParamId.ModalMix) > 0.001,
    duration: (g) => {
      const mat = modalIndex(g);
      const scale = ENGINE_TABLES.MODAL_BASE_DECAY * Math.pow(4, (clamp01(g(ParamId.ModalDecay)) - 0.5) * 2);
      return Math.min(8, scale * Math.max(...MODAL_TABLES[mat].d) * 3);
    },
    curve: (g, t) => modalCurve(g, t),
    fromTo: (g) => `${Math.round(g(ParamId.ModalMix) * 100)}% ringing as ${MODAL_NAMES[modalIndex(g)]}`,
    about: "The resonator bank ringing at the note's modes — a SUM of decaying partials whose frequencies, gains (gₖ) and ring times (τₖ) come from the material's measured table, turning a plain hit into a struck metallic or wooden object (bells, glocks, tabla, gongs). Membrane is a drumhead, Bell inharmonic metal, Bar tuned like a marimba, Bowl rounded and singing, Plate a dense inharmonic wash. Switching material swaps the whole τₖ/gₖ set, so the formula and the drawn curve change with it. D scales every mode's ring time together — short for a damped thud, long for a bell-like sustain. M = 0 turns it off.",
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
    about: "The channel's place in the final mix: its overall level (vol — the same thing the mixer fader moves) and its stereo position (pan, constant-power so the centre isn't louder than the sides), both steady across the note. Spread voices across the field for width, but keep bass and kicks near centre so they stay solid — very low sounds are pulled back toward centre automatically. Volume 0 silences the sound entirely.",
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

/** {@link traceAxisSeconds} straight off a snapshot — the form the engine bridge wants, since
    a drawn pitch contour is stretched over exactly this width (EngineSound.span). */
export function snapshotAxisSeconds(snap: number[], bpm: number): number {
  return traceAxisSeconds((id) => snap[id] ?? 0, { bpm });
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
  return Math.max(0.25, Math.min(62, t || 0.5));
}
