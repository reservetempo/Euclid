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
    (0) toward exponential (1), and `dir` says which way a ramp grows. */
export interface LifePlacement {
  mode: "everyN" | "ramp";
  every?: number;         // everyN: the N (>= 1)
  amount: number;         // 0..1 strength
  curve?: number;         // ramp: 0 linear .. 1 exponential
  dir?: "up" | "down";    // ramp: grow toward the end ("up") or the start ("down")
}

/** The editable sweep endpoints + blend shape shared by both fade sides (see
    TRANSITION_SWEEP for the swept parameter per mode):
    - `from` = the swept quantity's value at the near/steady end (undefined = the sound's
      own value, so the fade behaves as before until edited).
    - `to` = its value at the far/silent end (undefined = the mode's built-in extreme).
    - `curve` bends the blend from linear (0) toward exponential (1). For the "speed" mode
      it bends the timing glide (see warpOnsets); for every other mode it bends the
      snapshot morph (see bendT in engine.js).
    - `dir` shapes that curve — "out" eases toward the far end, "in" toward the near end.
    - `rate` (speed only) is the FAR end's hit-rate multiple of the tempo (near end = 1×). */
export interface TransitionShape { rate?: number; curve?: number; from?: number; to?: number; dir?: "in" | "out"; }

/** A row-wide FX SWEEP window, in engine STEP positions over the loop: while the global
    loop position is within [from, to), every steady hit on the lane is morphed toward (or
    out of) the mode's FX extreme by the window's global progress. `side` "out" runs the
    sound → the effect, "in" runs the effect → the sound. `fromV`/`toV` optionally override
    the swept param's near/far values; `curve`/`dir` bend the ramp (see engine bendT). Rides
    over the node chain without splitting it — a whole-row automation, not a per-node fade. */
export interface SweepWindow {
  from: number; // inclusive start step
  to: number;   // exclusive end step
  mode: TransitionMode;
  modes?: TransitionMode[]; // multi-select style set (see envModes); mode = its first entry
  side: "in" | "out";
  fromV?: number;
  toV?: number;
  curve?: number;
  dir?: "in" | "out";
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
    — only the far hits are displaced (rushed/dragged). `curve` bends the glide from
    linear (0) toward exponential (1).

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
  rate: number, curve: number, side: "intro" | "outro",
): number[] {
  const onsets: number[] = [];
  if (!pattern.length || vs < 1 || spanSteps < 1) return onsets;
  const mult = rate > 0 ? rate : 1;
  const c = Math.max(0, Math.min(1, curve));
  const exp = Math.pow(4, c); // 1 (linear) .. 4 (exponential) glide bend
  // Rate at real distance `s` from the anchor: 1× at the anchor, `mult` at the far end.
  const rateAt = (s: number) => {
    const x = Math.max(0, Math.min(1, s / spanSteps));
    return 1 + (mult - 1) * Math.pow(x, exp);
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
    while (nextM <= psiNext) {
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
    intro?: { steps: number; mode: TransitionMode; modes?: TransitionMode[]; fromId: number; rate?: number; curve?: number; from?: number; to?: number; dir?: "in" | "out"; warp?: number[] };
    outro?: { steps: number; mode: TransitionMode; modes?: TransitionMode[]; toId: number; rate?: number; curve?: number; from?: number; to?: number; dir?: "in" | "out"; warp?: number[] };
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
      worklet stays pattern-only). Every node ships, including silent rests. */
  linesMessage(): LineMessage[] {
    return this.lines.map((ln) => ({
      sweeps: ln.sweeps && ln.sweeps.length ? ln.sweeps : undefined,
      nodes: ln.nodes.map((n) => {
        const unit = n.steps >= 1 ? n.steps : STEPS_PER_BAR;
        const reps = Math.max(1, n.reps | 0);
        const pattern = n.steps >= 1 && n.soundId !== EMPTY
          ? voicePattern(n.hits, n.steps, n.rotation, n.split).map((b) => (b ? 1 : 0))
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
                ...(envHasSpeed(n.intro)
                  ? { rate: n.intro.rate,
                      warp: warpOnsets(pattern, n.steps, iSteps, activeLen, n.intro.rate ?? 2, n.intro.curve ?? 0, "intro") }
                  : {}),
              }
            : undefined,
          outro: n.outro
            ? {
                steps: oSteps, mode: n.outro.mode, modes: n.outro.modes, toId: n.outro.toId,
                curve: n.outro.curve, from: n.outro.from, to: n.outro.to, dir: n.outro.dir,
                ...(envHasSpeed(n.outro)
                  ? { rate: n.outro.rate,
                      warp: warpOnsets(pattern, n.steps, oSteps, activeLen, n.outro.rate ?? 2, n.outro.curve ?? 0, "outro") }
                  : {}),
              }
            : undefined,
          pitchHz: n.pitchHz,
          accent: n.accent,
          ghost: n.ghost,
        };
      }),
    }));
  }
}
