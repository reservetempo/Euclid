// The pattern data: 6 voice LINES, each a chain of NODES. A node is one sound plus
// one Euclidean rhythm (hits/steps/start/split) that REPEATS `reps` times, so its
// length in steps is `reps × steps` (a 14-step pattern at 2 reps is 28 steps, NOT
// padded up to two 16-step bars). A node may also `wait` a number of quiet BARS FIRST
// — lead-in silence that delays the voice's entry — so its full length is
// `wait × 16 + reps × steps` steps. A node with no rhythm yet (steps 0) falls back to whole
// bars. When a node's window elapses the line moves to its next node, wrapping at the
// end of the chain.
//
// The loop is as long as the LONGEST line: every line plays its chain ONCE per loop
// and then rests until the loop comes round, so all lines realign at the top (a
// short voice sits out the rest of a long voice rather than repeating under it).
// Polymeter still lives at the STEP scale — a node whose `steps` doesn't divide a
// bar cycles at its own rate — and node chains let a voice change rhythm over the
// loop.
//
// A sound node may carry an intro and/or outro TRANSITION: a fade folded into its OWN
// window (adding no length). `intro` covers the first `reps` of the node — rising from
// silence (fromId = -1, a fade-in) or morphing from another sound (fromId = a previous
// node's sound). `outro` covers the last `reps` — falling to silence (toId = -1) or
// morphing into a next sound. `mode` picks the blend style. So a 4-bar loop can spend 2
// bars fading in and 2 bars steady, or all 4 bars fading — it's always ONE block.
// See engine.js fireStep for the per-hit blend.
//
// Nodes are no longer hand-placed: track.ts compiles each colour's loops (placement
// rules) into these chains, and project.ts serialises the track, not the chains.

import { EUCLID_VOICES, voicePattern, VOICE_DEFAULT } from "./euclid";
import { ParamId } from "./params";

export const NUM_LINES = EUCLID_VOICES; // one line per voice ring / logo letter
export const STEPS_PER_BAR = 16;        // 4/4 at 16th-note steps
export const MAX_REPS = 64;             // per node
export const EMPTY = -1;
// Safety ceiling on a SPEED warp's precomputed onset list: rates now go up to 32×, so an
// extreme rate over a huge span could otherwise mint hundreds of thousands of onsets.
// Hits past the cap are dropped (the span plays its first MAX onsets).
const MAX_WARP_ONSETS = 4096;

// Identity colour per voice line (inner ring → outer ring), and per logo letter —
// one six-colour rainbow for the whole app (rings, rows, node dots, wordmark).
export const VOICE_COLORS = [
  "#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#4dabf7", "#b197fc",
];

// How a transition blends its two ends. Sound↔sound: "morph" = one voice with
// parameters lerped between them (the sound itself mutates); "crossfade" = both
// voices, one fading out as the other in; "alternate" = every hit comes from ONE of
// the two, the coin weighting towards the destination; "filter" = both play while
// one's filter closes as the other's opens (a spectral crossfade).
// Silence↔sound (a fade-in/out, one endpoint id = EMPTY): "fade" = a pure level
// ramp; "filter" = the sound opens from (or closes into) a shut filter; "wash" =
// it condenses out of (or dissolves into) a reverb cloud; "thin" = its hits fill
// in from (or scatter into) near-silence; "drive"/"crush"/"echo" = the sound
// emerges from (or dissolves into) an FX extreme — heavy saturation, bit/rate
// crush, or a wash of delay — the same drive/FX palette as the voice params. And
// "speed" is timing, not tone: the hits themselves rush in / drag out (see the
// warp precompute in linesMessage) rather than the sound morphing.
export type TransitionMode =
  | "morph" | "crossfade" | "alternate" | "filter"
  | "fade" | "wash" | "thin" | "drive" | "crush" | "echo" | "speed";

/** All modes a silence↔sound transition can take (the loop fade picker's options). */
export const FADE_MODES: TransitionMode[] = ["fade", "filter", "wash", "thin", "drive", "crush", "echo", "speed"];

/** The active style SET of a transition: `modes` when present (a multi-select — several
    styles swept together, composed in the engine), else the single `mode`. `mode` always
    mirrors the first entry so old readers and single-mode paths keep working. */
export function envModes(env: { mode: TransitionMode; modes?: TransitionMode[] }): TransitionMode[] {
  return env.modes && env.modes.length ? env.modes : [env.mode];
}

/** Normalize + store a transition's style set: dedupe, canonical FADE_MODES order.
    "speed" stacks with the tonal styles (it warps the TIMING while they morph the tone),
    and sorts last — so `mode` (kept = the first entry) is always the primary TONAL style
    of a mixed set. Falls back to "fade" when empty. */
export function setEnvModes(env: { mode: TransitionMode; modes?: TransitionMode[] }, list: TransitionMode[]): void {
  let norm = FADE_MODES.filter((m) => list.includes(m));
  if (!norm.length) norm = ["fade"];
  env.modes = norm.length > 1 ? norm : undefined;
  env.mode = norm[0];
}

/** True when a transition's style set includes the SPEED timing warp. */
export function envHasSpeed(env: { mode: TransitionMode; modes?: TransitionMode[] }): boolean {
  return envModes(env).includes("speed");
}

/** A transition's TONAL styles (the snapshot-morphing set — everything but "speed"). */
export function envTonalModes(env: { mode: TransitionMode; modes?: TransitionMode[] }): TransitionMode[] {
  return envModes(env).filter((m) => m !== "speed");
}

/** Deterministic accent/ghost placement for a loop — a per-loop LIFE layer that
    overrides the sound's own random accent/ghost (see engine perHit). `everyN` marks
    every Nth hit (1-based, running continuously across the loop, not per pattern
    cycle); `ramp` swells the effect from one end of the loop to the other. `amount`
    is the strength (accent depth / how ghosted), `curve` bends a ramp from linear
    (0) toward exponential (1), and `dir` says which way a ramp grows. `offset` shifts
    which hit in each group of N is marked — 0 = the first (hits 0, N, 2N…), 1 = the
    second, and a NEGATIVE value counts from the end (-1 = the last of every group). */
export interface LifePlacement {
  mode: "everyN" | "ramp";
  every?: number;         // everyN: the N (>= 1)
  offset?: number;        // everyN: which hit in each group (0 = first; -1 = last)
  amount: number;         // 0..1 strength
  curve?: number;         // ramp: 0 linear .. 1 exponential
  dir?: "up" | "down";    // ramp: grow toward the end ("up") or the start ("down")
}

// The FUNCTION a transition's blend progress follows across its span — a graph
// calculator over the fade, cousin of the melody's GRAPH_PRESETS. t (span progress
// 0→1) maps to the blend position y∈[0,1] between the near sound and the far end:
//   ramp     — the classic line, bent by `curve` toward exponential (the old behavior)
//   scurve   — logistic ease: slow, steep middle, slow; `curve` = steepness
//   parabola — an arch: out to the far end and back (y 0→1→0); `curve` skews the peak
//   sine     — a smooth wave 0→1→0…, `cycles` swings (half-integers land at the far end)
//   cos      — the same wave starting AT the far end (1→0→1…) — a dip-and-return
//   zigzag   — the triangle cousin of sine: linear back-and-forth passes
//   wobble   — a ramp that oscillates on the way but always lands; `curve` = depth
//   steps    — a staircase: `cycles` flat levels jumping to the far end
//   halfwave — `cycles` half-sine humps (0→1→0) with FLAT space between them; `curve` =
//              the gap — 0 humps touch (|sin|), 1 thin spikes with mostly rest between
//   drawn    — a FREEHAND function: the user's smoothed drawing, sampled uniformly into
//              `points` (y values 0..1) and played back by linear interpolation
// For sine/cos/zigzag/steps, `curve` + `dir` WARP TIME instead (the same power bend),
// squeezing the waves/stairs toward one end — an accelerating oscillation.
export type BlendShapeId =
  | "ramp" | "scurve" | "parabola" | "sine" | "cos" | "zigzag" | "wobble" | "steps"
  | "halfwave" | "drawn";

/** Per-shape UI spec: what the `curve` knob means for it, and whether the ease
    direction / wave count apply (the UI hides the rows that don't). */
export interface BlendShapeSpec {
  id: BlendShapeId;
  label: string;
  curveLabel: string;    // the 0..1 `curve` knob's meaning for this shape
  usesDir: boolean;      // ease/skew direction applies
  usesCycles: boolean;   // the Waves/Steps count applies
  cyclesDefault: number; // seeded into `cycles` when the shape is picked
}

export const BLEND_SHAPES: BlendShapeSpec[] = [
  { id: "ramp",     label: "Line",     curveLabel: "Curve", usesDir: true,  usesCycles: false, cyclesDefault: 0 },
  { id: "scurve",   label: "S-curve",  curveLabel: "Steep", usesDir: false, usesCycles: false, cyclesDefault: 0 },
  { id: "parabola", label: "Parabola", curveLabel: "Skew",  usesDir: true,  usesCycles: false, cyclesDefault: 0 },
  { id: "sine",     label: "Sine",     curveLabel: "Warp",  usesDir: true,  usesCycles: true,  cyclesDefault: 1.5 },
  { id: "cos",      label: "Cos",      curveLabel: "Warp",  usesDir: true,  usesCycles: true,  cyclesDefault: 1 },
  { id: "zigzag",   label: "Zigzag",   curveLabel: "Warp",  usesDir: true,  usesCycles: true,  cyclesDefault: 1.5 },
  { id: "wobble",   label: "Wobble",   curveLabel: "Depth", usesDir: false, usesCycles: true,  cyclesDefault: 2 },
  { id: "steps",    label: "Steps",    curveLabel: "Warp",  usesDir: true,  usesCycles: true,  cyclesDefault: 4 },
  { id: "halfwave", label: "Half wave", curveLabel: "Gap",  usesDir: false, usesCycles: true,  cyclesDefault: 3 },
];

/** The freehand shape's spec. Not in BLEND_SHAPES (the generic pickers) — only surfaces
    with a drawing screen offer it, but blendShapeSpec still resolves it for rendering. */
export const DRAWN_SHAPE: BlendShapeSpec =
  { id: "drawn", label: "Drawn", curveLabel: "", usesDir: false, usesCycles: false, cyclesDefault: 0 };

export const blendShapeSpec = (id: BlendShapeId | undefined): BlendShapeSpec =>
  id === "drawn" ? DRAWN_SHAPE
    : BLEND_SHAPES.find((s) => s.id === (id ?? "ramp")) ?? BLEND_SHAPES[0];

/** Evaluate a freehand-drawn function (uniformly sampled y values) at t∈[0,1] by
    linear interpolation. MUST match drawnY in engine.js. */
export function drawnShapeY(points: number[], t: number): number {
  const n = points.length;
  if (!n) return t;
  if (n === 1) return Math.max(0, Math.min(1, points[0]));
  const x = Math.max(0, Math.min(1, t)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  const f = x - i;
  return Math.max(0, Math.min(1, points[i] + (points[i + 1] - points[i]) * f));
}

/** The classic power bend of a blend progress t∈[0,1] — must match bendT in engine.js:
    `curve` 0 (linear) → 1 (exponential); `dir` "out" eases out of the start then rushes
    the end, "in" the reverse. Endpoints (0→0, 1→1) are preserved. */
export function bendProgress(t: number, curve: number | undefined, dir: "in" | "out" | undefined): number {
  const c = Math.max(0, Math.min(1, curve || 0));
  t = Math.max(0, Math.min(1, t));
  if (c <= 0) return t;
  const exp = Math.pow(4, c);
  return dir === "in" ? 1 - Math.pow(1 - t, exp) : Math.pow(t, exp);
}

/** The graph-calculator TRANSFORM riding on top of a blend function (see blendShapeY):
    slope multiple, vertical shift, and a floor/ceiling — all defaulting to the identity
    so the basic shapes are untouched until edited. */
export interface GraphTransform {
  yGain?: number; // slope multiple (1 = as drawn; negative flips the direction)
  yBias?: number; // vertical shift added after the gain (0 = none)
  yMin?: number;  // clamp floor (0 = none)
  yMax?: number;  // clamp ceiling (1 = none)
}

/** Evaluate a transition's blend FUNCTION at span progress t∈[0,1] → blend position
    y∈[0,1] (see BlendShapeId for each shape). Single source of truth for the UI's curve
    graph and the speed warp; MUST match shapeT in engine.js (the per-hit morphs). */
export function blendShape(
  env: { shape?: BlendShapeId; curve?: number; dir?: "in" | "out"; cycles?: number; points?: number[] }, t: number,
): number {
  t = Math.max(0, Math.min(1, t));
  const c = Math.max(0, Math.min(1, env.curve || 0));
  const cyc = (def: number) => Math.max(0.25, Math.min(999, env.cycles ?? def));
  switch (env.shape) {
    case "drawn":
      return env.points && env.points.length ? drawnShapeY(env.points, t) : bendProgress(t, c, env.dir);
    case "scurve": {
      const k = 4 + c * 12;
      const s = (x: number) => 1 / (1 + Math.exp(-k * (x - 0.5)));
      const lo = s(0), hi = s(1);
      return (s(t) - lo) / (hi - lo);
    }
    case "parabola": {
      // A smooth arch out and back; `curve` skews the peak late (dir "in") or early.
      const peak = Math.min(0.9, Math.max(0.1, 0.5 + (env.dir === "in" ? 1 : -1) * c * 0.35));
      const x = t <= peak ? t / peak : (1 - t) / (1 - peak);
      return Math.max(0, Math.min(1, x * (2 - x)));
    }
    case "sine":
      return 0.5 - 0.5 * Math.cos(2 * Math.PI * cyc(1.5) * bendProgress(t, c, env.dir));
    case "cos":
      return 0.5 + 0.5 * Math.cos(2 * Math.PI * cyc(1) * bendProgress(t, c, env.dir));
    case "zigzag": {
      const ph = (cyc(1.5) * bendProgress(t, c, env.dir)) % 1;
      return ph < 0.5 ? ph * 2 : 2 - ph * 2;
    }
    case "wobble": {
      // A ramp with a damped swing riding it — lands exactly; `curve` = swing depth.
      const depth = 0.15 + 0.85 * c;
      const w = t + 0.5 * depth * Math.sin(2 * Math.PI * cyc(2) * t) * (1 - t);
      return Math.max(0, Math.min(1, w));
    }
    case "steps": {
      const n = Math.max(2, Math.round(env.cycles ?? 4));
      return Math.min(1, Math.floor(bendProgress(t, c, env.dir) * n) / (n - 1));
    }
    case "halfwave": {
      // `cycles` half-sine humps, each centred in its slot with flat rest around it;
      // `curve` = the gap — 0 humps touch (|sin|), 1 thin spikes (width floors at 10%).
      const n = cyc(3);
      const w = 1 - 0.9 * c; // hump width as a fraction of its slot
      const ph = (t * n) % 1;
      const lo = (1 - w) / 2;
      return ph < lo || ph > lo + w ? 0 : Math.sin(Math.PI * ((ph - lo) / w));
    }
    default: // "ramp" / unset — the old bent line
      return bendProgress(t, c, env.dir);
  }
}

/** blendShape with the graph-calculator transform applied on top: y·gain + shift,
    clamped to [min, max] and then to [0,1]. The transition Graph tab edits these like a
    graph calculator — the defaults are the identity, so a plain shape is unchanged.
    MUST match shapeY in engine.js. */
export function blendShapeY(
  env: { shape?: BlendShapeId; curve?: number; dir?: "in" | "out"; cycles?: number; points?: number[] } & GraphTransform,
  t: number,
): number {
  let y = blendShape(env, t) * (env.yGain ?? 1) + (env.yBias ?? 0);
  const lo = env.yMin ?? 0, hi = env.yMax ?? 1;
  y = Math.max(lo, Math.min(hi, y));
  return Math.max(0, Math.min(1, y));
}

/** The editable sweep endpoints + blend shape shared by both fade sides (see
    TRANSITION_SWEEP for the swept parameter per mode):
    - `from` = the swept quantity's value at the near/steady end (undefined = the sound's
      own value, so the fade behaves as before until edited).
    - `to` = its value at the far/silent end (undefined = the mode's built-in extreme).
    - `shape` picks the blend FUNCTION the progress follows (see BlendShapeId; unset =
      "ramp", the old line), `cycles` its wave/stair count where periodic.
    - `curve` is the shape's 0..1 knob — the ramp's linear→exponential bend, the s-curve's
      steepness, the parabola's skew, the wobble's depth, the waves' time warp. For the
      "speed" mode it bends the timing glide (see warpOnsets); for every other mode the
      snapshot morph (see shapeT in engine.js).
    - `dir` orients that bend — "out" eases toward the far end, "in" toward the near end.
    - `rate` (speed only) is the FAR end's hit-rate multiple of the tempo (near end = 1×). */
export interface TransitionShape {
  rate?: number; curve?: number; from?: number; to?: number; dir?: "in" | "out";
  shape?: BlendShapeId; cycles?: number;
  points?: number[]; // "drawn" shape only: the freehand function, uniformly sampled y∈[0,1]
}

/** A row-wide FX SWEEP window, in engine STEP positions over the loop: while the global
    loop position is within [from, to), every steady hit on the lane is morphed toward (or
    out of) the mode's FX extreme by the window's global progress. `side` "out" runs the
    sound → the effect, "in" runs the effect → the sound. `fromV`/`toV` optionally override
    the swept param's near/far values; `curve`/`dir` bend the ramp (see engine bendT). Rides
    over the node chain without splitting it — a whole-row automation, not a per-node fade. */
export interface SweepWindow extends GraphTransform {
  from: number; // inclusive start step
  to: number;   // exclusive end step
  mode: TransitionMode;
  modes?: TransitionMode[]; // multi-select style set (see envModes); mode = its first entry
  side: "in" | "out";
  fromV?: number;
  toV?: number;
  curve?: number;
  dir?: "in" | "out";
  shape?: BlendShapeId; // blend function over the window (unset = "ramp")
  cycles?: number;      // wave/stair count for the periodic shapes
  points?: number[];    // "drawn" shape: the freehand function, uniformly sampled y∈[0,1]
  rate?: number;        // "speed" style: the far end's hit-rate multiple of the tempo
  // "morph" style (a per-loop transition, see LoopTransition in track.ts): the FULL
  // parameter snapshot of the TRANSFORMED sound — every hit in the window is lerped
  // between the lane's sound and this target by the window's progress. The Volume slot
  // holds a RATIO of the loop's own volume (not an absolute level) so mute/solo and the
  // loudness makeup keep working — see loopTransitionWindows and sweptSnap in engine.js.
  morphSnap?: number[];
  // "speed" only, engine message only (built in linesMessage, never serialised): the
  // window's re-timed hit onsets replacing the grid — fractional lane steps `o` (absolute)
  // firing source node `ni`'s sound. See warpSweepOnsets.
  warp?: { o: number; ni: number }[];
}

/** An intro fade folded into a node's start: covers the first `reps` of its window,
    rising from silence (fromId < 0) or morphing from another sound (fromId = its id).
    `modes`, when present, is a multi-select style set composed together in the engine
    (silence-end fades only); `mode` mirrors its first entry. */
export interface IntroEnv extends TransitionShape { reps: number; mode: TransitionMode; modes?: TransitionMode[]; fromId: number; }
/** An outro fade folded into a node's end: covers the last `reps` of its window,
    falling to silence (toId < 0) or morphing into another sound (toId = its id). */
export interface OutroEnv extends TransitionShape { reps: number; mode: TransitionMode; modes?: TransitionMode[]; toId: number; }

/** Per-fade-mode description of the ONE parameter each silence-end fade sweeps, and the
    UI range/format for its From→To endpoints. The `farDefault` mirrors the engine's
    built-in "silent variant" extreme (see silentVariant in engine.js) so the UI shows the
    same target the engine falls back to when `to` is unset. Secondary linked params
    (crush's Downsample, echo's Feedback, wash's Size) stay automatic in the engine — the
    UI edits the primary swept value only. "speed" is timing, not a swept param, so it has
    no entry (its Rate/Curve are edited directly). */
export interface SweepSpec {
  paramId: ParamId;
  label: string;
  min: number;
  max: number;
  step: number;
  /** The engine's hard-coded far-end value (may depend on the sound, e.g. filter LP vs HP). */
  farDefault: (snap: number[]) => number;
  /** Display a swept value (native units). */
  format: (v: number) => string;
}

const hz = (v: number) => `${Math.round(v)} Hz`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
export const TRANSITION_SWEEP: Partial<Record<TransitionMode, SweepSpec>> = {
  fade:   { paramId: ParamId.Volume,      label: "Level",  min: 0,   max: 1,    step: 0.01, farDefault: () => 0,   format: pct },
  filter: { paramId: ParamId.FilterCutoff, label: "Cutoff", min: 60,  max: 12000, step: 10,
            farDefault: (s) => (Math.round(s[ParamId.FilterType] ?? 0) === 1 ? 9000 : 120), format: hz },
  wash:   { paramId: ParamId.ReverbMix,   label: "Reverb", min: 0,   max: 1,    step: 0.01, farDefault: () => 1,   format: pct },
  thin:   { paramId: ParamId.HitChance,   label: "Hits",   min: 0,   max: 1,    step: 0.01, farDefault: () => 0,   format: pct },
  drive:  { paramId: ParamId.Drive,       label: "Drive",  min: 0,   max: 2,    step: 0.01, farDefault: () => 1.5, format: (v) => v.toFixed(2) },
  crush:  { paramId: ParamId.Crush,       label: "Crush",  min: 0,   max: 8,    step: 1,    farDefault: () => 4,   format: (v) => String(Math.round(v)) },
  echo:   { paramId: ParamId.EchoMix,     label: "Echo",   min: 0,   max: 1,    step: 0.01, farDefault: () => 0.6, format: pct },
};

// One node of a line: an assigned sound plus its rhythm and repeat count. soundId =
// EMPTY when no sound is assigned (a REST that still occupies its window, so the
// line's timing holds). A transition node morphs `transition.fromId`→`toId`.
export interface VoiceNode {
  soundId: number;
  snapshot: number[];
  color: string;
  name: string;
  pitch: [number, number];
  hits: number;
  steps: number;
  rotation: number;
  split?: number; // primary-gap override for an uneven hit split (undefined = even)
  // Hand-edited pattern override (the Loop tab's sequencer grid): 0/1 per step,
  // replacing the Euclid-derived pattern when its length matches `steps`. Cleared
  // whenever hits/steps/start/split are edited (the circles win again).
  patternOv?: number[];
  reps: number;   // how many times the pattern repeats (length = reps × steps)
  wait?: number;  // lead-in silence: quiet BARS BEFORE the pattern starts (adds
                  // wait × 16 steps to the length; the voice waits, then plays). 0/unset = none.
  gain?: number;  // loudness makeup (×): measured after a shuffle so every generated
                  // sound lands at a consistent level. Applied to Volume in the engine
                  // message only — the snapshot (and mixer fader) keep their meaning.
  // Transitions folded into this node's OWN window (see IntroEnv/OutroEnv). They cover
  // the first (intro) / last (outro) `reps` of the node and add no length; a node keeps
  // its sound throughout — the envelopes only shape how its ends blend.
  intro?: IntroEnv;
  outro?: OutroEnv;
  // Per-loop LIFE layer: deterministic accent / ghost placement that overrides the
  // sound's own random rolls in the engine (see perHit). Unset = the sound's own feel.
  accent?: LifePlacement;
  ghost?: LifePlacement;
  // A melody note's absolute pitch in Hz (the one re-pitched instrument playing a scale
  // degree). Set only on generated melody nodes; the engine swaps P.Pitch to it. Unset
  // on ordinary loop nodes, which keep their sound's own pitch.
  pitchHz?: number;
  // Inline-shuffle editor state, so a reloaded node keeps shuffling where it left:
  preset?: string;                          // active preset (Reset target + label)
  ranges?: { lo: number[]; hi: number[] };  // live shuffle window per param
}

export function emptyNode(): VoiceNode {
  const d = VOICE_DEFAULT;
  return {
    soundId: EMPTY, snapshot: [], color: "#888888", name: "", pitch: [60, 1000],
    hits: d.hits, steps: d.steps, rotation: d.rotation, reps: 1,
  };
}

/** The step unit a node's reps/wait are counted in: its own step count, or one bar
    when it has no rhythm yet (steps 0). */
function nodeUnit(n: VoiceNode): number {
  return n.steps >= 1 ? n.steps : STEPS_PER_BAR;
}

/** A node's lead-in silence in 16th-note steps: `wait` quiet BARS before the pattern
    starts (0 when unset). Counted in whole bars (not the node's own step unit) so a
    voice's entry lines up with the bar grid. The engine mutes hits inside this window. */
export function waitLen(n: VoiceNode): number {
  return Math.max(0, (n.wait ?? 0) | 0) * STEPS_PER_BAR;
}

/** A node's length in 16th-note steps: its lead-in silence plus `reps × steps` (or
    `reps` whole bars when the node has no rhythm yet, steps 0). Single source of truth
    for the engine message, the loop math, and the section-loop window. */
export function nodeLen(n: VoiceNode): number {
  return Math.max(1, n.reps | 0) * nodeUnit(n) + waitLen(n);
}

/** Keep a node's intro/outro fades within its own reps: each ≥ 1 rep, and the two
    together no longer than the node (they must not overlap in the middle). When they
    would overlap, `keep` says which one just changed and wins the space; the other
    shrinks, and is dropped if nothing is left for it. Call after any reps change. */
export function clampEnvelopes(n: VoiceNode, keep: "intro" | "outro" = "outro"): void {
  const reps = Math.max(1, n.reps | 0);
  if (n.intro) n.intro.reps = Math.max(1, Math.min(reps, Math.round(n.intro.reps)));
  if (n.outro) n.outro.reps = Math.max(1, Math.min(reps, Math.round(n.outro.reps)));
  if (n.intro && n.outro && n.intro.reps + n.outro.reps > reps) {
    if (keep === "intro") {
      n.outro.reps = reps - n.intro.reps;
      if (n.outro.reps < 1) n.outro = undefined;
    } else {
      n.intro.reps = reps - n.outro.reps;
      if (n.intro.reps < 1) n.intro = undefined;
    }
  }
}

/** Precompute a SPEED transition's re-timed hit onsets — the heart of the
    accelerando/ritardando. The node keeps its Euclidean pattern, but time is warped
    across the `spanSteps`-long span so the effective hit rate glides between the tempo
    (1×) and a far-end multiple (`rate`). The span is ANCHORED to the grid at the steady
    boundary (span END for an intro, span START for an outro) so the hand-off is seamless
    — only the far hits are displaced (rushed/dragged). The glide follows the env's blend
    FUNCTION (see blendShape): the ramp's curve bend as before, but a sine shape makes
    the tempo itself oscillate, steps a quantized accelerando, etc.

    Returns the onset TIMES as fractional step offsets within the sounding window (0 = the
    first sounding step). Done here on the main thread — it's deterministic (pattern + span
    + rate + curve); only per-hit Life (accent/ghost/humanize) stays random in the engine.

    Method: integrate the instantaneous rate outward from the anchor to build the pattern
    distance Ψ(s) (pattern-steps between the anchor and a point `s` real-steps away). Each
    time Ψ crosses an integer `m`, that pattern-step (m before/after the anchor) sounds if
    the pattern marks it, at real offset `s` from the anchor. The anchor event (m=0) is
    owned by the steady section for an intro (excluded) but by the span for an outro. */
function warpOnsets(
  pattern: number[], vs: number, spanSteps: number, activeLen: number,
  env: TransitionShape, side: "intro" | "outro",
): number[] {
  const onsets: number[] = [];
  if (!pattern.length || vs < 1 || spanSteps < 1) return onsets;
  const rate = env.rate ?? 2;
  const mult = rate > 0 ? rate : 1;
  // Rate at real distance `s` from the anchor: 1× at the anchor, `mult` at the far end,
  // gliding along the env's blend function (shape/curve/dir/cycles).
  const rateAt = (s: number) => {
    const x = Math.max(0, Math.min(1, s / spanSteps));
    return 1 + (mult - 1) * blendShapeY(env, x);
  };
  const anchorStep = side === "intro" ? spanSteps : activeLen - spanSteps;
  const bit = (pstep: number) => pattern[((Math.round(pstep) % vs) + vs) % vs];
  // Outro owns its anchor event (span start); intro's belongs to the steady section.
  let nextM = 1;
  if (side === "outro" && bit(anchorStep)) onsets.push(anchorStep);
  const N = Math.max(64, Math.ceil(spanSteps * 32)); // integration resolution
  const ds = spanSteps / N;
  let psi = 0;
  for (let i = 1; i <= N; i++) {
    const s0 = (i - 1) * ds, s1 = i * ds;
    const psiNext = psi + 0.5 * (rateAt(s0) + rateAt(s1)) * ds; // trapezoid
    while (nextM <= psiNext && onsets.length < MAX_WARP_ONSETS) {
      const frac = psiNext > psi ? (nextM - psi) / (psiNext - psi) : 0;
      const s = s0 + frac * ds;
      const o = side === "intro" ? spanSteps - s : anchorStep + s;
      const pstep = side === "intro" ? anchorStep - nextM : anchorStep + nextM;
      if (bit(pstep)) onsets.push(o);
      nextM++;
    }
    psi = psiNext;
  }
  onsets.sort((a, b) => a - b);
  return onsets;
}

/** Re-time the hits inside a SPEED row-sweep window — the sweep cousin of warpOnsets,
    but over the LANE's composite hit grid (the window may cross node boundaries).
    `hits[i]` is the source node index at relative step i (−1 = none). The hit rate
    glides between 1× at the window's STEADY end and `rate`× at its far end — side "out"
    anchors at the window START (hits rush/drag toward the end), side "in" at its END
    (a fast/slow start settles onto the grid) — following the sweep's blend function,
    like every other transition. The window's hit sequence CYCLES like a pattern (the
    grid slice wraps, mirroring warpOnsets' modular pattern): rushing fires MORE hits —
    the sequence comes round faster — and slowing (rate < 1) stretches them apart into
    fewer, longer-spaced hits, so the window stays musically filled either way.
    Returns onsets as fractional steps RELATIVE to the window start, sorted, each firing
    its source node's sound. */
function warpSweepOnsets(hits: number[], span: number, sw: SweepWindow): { o: number; ni: number }[] {
  const out: { o: number; ni: number }[] = [];
  if (span < 1) return out;
  const rate = sw.rate ?? 2;
  const mult = rate > 0 ? rate : 1;
  const rateAt = (s: number) => 1 + (mult - 1) * blendShapeY(sw, Math.max(0, Math.min(1, s / span)));
  const at = (rel: number) => hits[((Math.round(rel) % span) + span) % span];
  // side "out" is anchored at the window start, which owns its own event; side "in" is
  // anchored at the window END — the first steady step AFTER it, owned by the grid — so
  // integration counts m = 1.. on both sides and only "out" fires its anchor.
  let nextM = 1;
  if (sw.side === "out" && at(0) >= 0) out.push({ o: 0, ni: at(0) });
  const N = Math.max(64, Math.ceil(span * 32)); // integration resolution
  const ds = span / N;
  let psi = 0;
  for (let i = 1; i <= N; i++) {
    const s0 = (i - 1) * ds, s1 = i * ds;
    const psiNext = psi + 0.5 * (rateAt(s0) + rateAt(s1)) * ds; // trapezoid
    while (nextM <= psiNext && out.length < MAX_WARP_ONSETS) {
      const frac = psiNext > psi ? (nextM - psi) / (psiNext - psi) : 0;
      const s = s0 + frac * ds;
      const rel = sw.side === "out" ? nextM : span - nextM;
      const ni = at(rel);
      if (ni >= 0) out.push({ o: sw.side === "out" ? s : span - s, ni });
      nextM++;
    }
    psi = psiNext;
  }
  out.sort((a, b) => a.o - b.o);
  return out;
}

/** The lane's sweeps as shipped to the engine: windows whose style set includes "speed"
    get their `warp` onset list attached (see warpSweepOnsets), built from the lane's
    compiled message nodes. Hits inside a node's OWN speed intro/outro span stay with the
    node's warp, and where speed windows overlap the EARLIER window owns the shared steps
    (list order) so nothing double-fires. */
function sweepsMessage(
  sweeps: SweepWindow[] | undefined, nodes: LineMessage["nodes"],
): SweepWindow[] | undefined {
  if (!sweeps || !sweeps.length) return undefined;
  let total = 0;
  for (const n of nodes) total += Math.max(1, n.lenSteps | 0);
  // Per-step source node index (−1 = no hit), built lazily — only speed windows need it.
  let grid: Int32Array | null = null;
  const buildGrid = () => {
    const g = new Int32Array(total).fill(-1);
    let acc = 0;
    nodes.forEach((n, ni) => {
      const len = Math.max(1, n.lenSteps | 0);
      const vs = n.steps | 0;
      const wait = Math.max(0, n.waitSteps | 0);
      const aLen = Math.max(1, len - wait);
      const iSpan = n.intro && n.intro.warp ? Math.min(aLen, Math.max(1, n.intro.steps | 0)) : 0;
      const oSpan = n.outro && n.outro.warp ? Math.min(aLen, Math.max(1, n.outro.steps | 0)) : 0;
      if (n.soundId !== EMPTY && vs >= 1 && n.pattern && n.pattern.length) {
        for (let p = wait; p < len; p++) {
          const active = p - wait;
          if (iSpan > 0 && active < iSpan) continue;         // node's own speed intro
          if (oSpan > 0 && active >= aLen - oSpan) continue; // node's own speed outro
          if (n.pattern[active % vs]) g[acc + p] = ni;
        }
      }
      acc += len;
    });
    return g;
  };
  const claimed = new Uint8Array(total);
  return sweeps.map((sw) => {
    const modes = sw.modes && sw.modes.length ? sw.modes : [sw.mode];
    if (!modes.includes("speed")) return sw;
    const from = Math.max(0, Math.min(total, Math.round(sw.from)));
    const to = Math.max(from, Math.min(total, Math.round(sw.to)));
    const span = to - from;
    if (span < 1) return sw;
    if (!grid) grid = buildGrid();
    const hits: number[] = new Array(span);
    for (let i = 0; i < span; i++) {
      hits[i] = claimed[from + i] ? -1 : grid[from + i];
      claimed[from + i] = 1;
    }
    const warp = warpSweepOnsets(hits, span, sw).map((h) => ({ o: from + h.o, ni: h.ni }));
    return { ...sw, warp };
  });
}

// One engine LANE: a node chain plus the colour it belongs to. Placement is now
// procedural (see track.ts): a colour may compile to several lanes (overlapping loops)
// or one (priority-resolved solo loops). Mute/solo live per COLOUR on the track, not
// here — many lanes can share a colour.
export interface VoiceLine {
  nodes: VoiceNode[]; // always at least one
  color?: number;     // which colour (0..NUM_LINES-1) this lane belongs to
  sweeps?: SweepWindow[]; // row-wide FX sweep windows riding over this lane's steady hits
}

// Engine-shaped line: per node the sound id, its own step count, its length in
// STEPS (precomputed), the precomputed hit pattern, and (transitions only) the
// from/to sound ids to morph between.
export interface LineMessage {
  nodes: {
    soundId: number;
    steps: number;
    lenSteps: number;
    waitSteps: number; // leading silent steps inside lenSteps (lead-in; hits muted here)
    pattern: number[];
    // Intro/outro fade spans, in STEPS within the sounding window (after any lead-in).
    // For the "speed" mode, `warp` holds the precomputed re-timed hit onsets (fractional
    // step offsets within the sounding window) that replace the grid pattern in the span.
    intro?: { steps: number; mode: TransitionMode; modes?: TransitionMode[]; fromId: number; rate?: number; curve?: number; from?: number; to?: number; dir?: "in" | "out"; shape?: BlendShapeId; cycles?: number; warp?: number[] };
    outro?: { steps: number; mode: TransitionMode; modes?: TransitionMode[]; toId: number; rate?: number; curve?: number; from?: number; to?: number; dir?: "in" | "out"; shape?: BlendShapeId; cycles?: number; warp?: number[] };
    pitchHz?: number; // melody notes only — absolute pitch the engine tunes to
    // Per-loop deterministic accent / ghost placement (see LifePlacement); the engine
    // uses these instead of the sound's random accent/ghost when present.
    accent?: LifePlacement;
    ghost?: LifePlacement;
  }[];
  sweeps?: SweepWindow[]; // row-wide FX sweep windows over this lane (step positions)
}

export class LineArrangement {
  // The COMPILED lanes (see track.ts compile()) — variable length; empty until a track
  // is compiled in. Each lane carries its colour; every lane is padded to barLimit.
  lines: VoiceLine[] = [];
  // The whole-track bar limit the lanes were padded to (loop length in bars).
  barLimit = 0;
  // Key context for the shuffle's pitch snap (Key mode) — global, kept in sync with the
  // track (see track.ts) so the shuffle menu still reads it here.
  root = 0;  // 0 = C
  scale = 0; // 0 = Major

  /** Replace the lanes with a freshly compiled set. `lanes` come straight from
      compile(); each is padded to `barLimit` bars. */
  setLanes(lanes: { color: number; nodes: VoiceNode[]; sweeps?: SweepWindow[] }[], barLimit: number): void {
    this.lines = lanes.map((l) => ({ nodes: l.nodes.length ? l.nodes : [emptyNode()], color: l.color, sweeps: l.sweeps }));
    this.barLimit = Math.max(0, Math.round(barLimit));
  }

  /** Length of one pass of a lane, in 16th steps (sum of its node windows). */
  lineSteps(li: number): number {
    let s = 0;
    for (const n of this.lines[li].nodes) s += nodeLen(n);
    return s;
  }

  /** True when the lane has at least one node that makes sound. */
  lineActive(li: number): boolean {
    return this.lines[li].nodes.some((n) => n.soundId !== EMPTY);
  }

  /** The loop length in steps: the whole-track bar limit (every lane is padded to it).
      Returns 0 when no lane makes sound (nothing to play or export). */
  loopSteps(): number {
    const active = this.lines.some((_, i) => this.lineActive(i));
    if (!active) return 0;
    // Lanes are padded to barLimit; fall back to the longest lane if a bar limit
    // hasn't been set yet (e.g. a bare load before the first compile).
    let longest = 0;
    for (let i = 0; i < this.lines.length; i++) longest = Math.max(longest, this.lineSteps(i));
    return this.barLimit > 0 ? this.barLimit * STEPS_PER_BAR : longest;
  }

  /** Lines serialised for the worklet scheduler (patterns precomputed here so the
      worklet stays pattern-only). Every node ships, including silent rests. Speed row
      sweeps get their re-timed onsets attached from the compiled nodes (sweepsMessage). */
  linesMessage(): LineMessage[] {
    return this.lines.map((ln) => {
      const nodes = ln.nodes.map((n) => {
        const unit = n.steps >= 1 ? n.steps : STEPS_PER_BAR;
        const reps = Math.max(1, n.reps | 0);
        const pattern = n.steps >= 1 && n.soundId !== EMPTY
          ? (n.patternOv && n.patternOv.length === n.steps
              ? n.patternOv.map((b) => (b ? 1 : 0))
              : voicePattern(n.hits, n.steps, n.rotation, n.split).map((b) => (b ? 1 : 0)))
          : [];
        const activeLen = Math.max(1, nodeLen(n) - waitLen(n));
        const iSteps = n.intro ? Math.min(n.intro.reps, reps) * unit : 0;
        const oSteps = n.outro ? Math.min(n.outro.reps, reps) * unit : 0;
        return {
          soundId: n.soundId,
          steps: n.steps,
          lenSteps: nodeLen(n),
          waitSteps: waitLen(n),
          pattern,
          intro: n.intro
            ? {
                steps: iSteps, mode: n.intro.mode, modes: n.intro.modes, fromId: n.intro.fromId,
                curve: n.intro.curve, from: n.intro.from, to: n.intro.to, dir: n.intro.dir,
                shape: n.intro.shape, cycles: n.intro.cycles,
                ...(envHasSpeed(n.intro)
                  ? { rate: n.intro.rate,
                      warp: warpOnsets(pattern, n.steps, iSteps, activeLen, n.intro, "intro") }
                  : {}),
              }
            : undefined,
          outro: n.outro
            ? {
                steps: oSteps, mode: n.outro.mode, modes: n.outro.modes, toId: n.outro.toId,
                curve: n.outro.curve, from: n.outro.from, to: n.outro.to, dir: n.outro.dir,
                shape: n.outro.shape, cycles: n.outro.cycles,
                ...(envHasSpeed(n.outro)
                  ? { rate: n.outro.rate,
                      warp: warpOnsets(pattern, n.steps, oSteps, activeLen, n.outro, "outro") }
                  : {}),
              }
            : undefined,
          pitchHz: n.pitchHz,
          accent: n.accent,
          ghost: n.ghost,
        };
      });
      return { sweeps: sweepsMessage(ln.sweeps, nodes), nodes };
    });
  }
}
