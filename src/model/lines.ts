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
// This replaces the previous 6-grids + 20-slot-order arrangement (every voice used
// to switch grids together); see project.ts for the migration of old saves.

import { EUCLID_VOICES, voicePattern, VOICE_DEFAULT } from "./euclid";

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
// in from (or scatter into) near-silence.
export type TransitionMode =
  | "morph" | "crossfade" | "alternate" | "filter"
  | "fade" | "wash" | "thin";

/** All modes a transition can take, by kind (sound↔sound vs silence↔sound). */
export const PAIR_MODES: TransitionMode[] = ["morph", "crossfade", "alternate", "filter"];
export const FADE_MODES: TransitionMode[] = ["fade", "filter", "wash", "thin"];

/** An intro fade folded into a node's start: covers the first `reps` of its window,
    rising from silence (fromId < 0) or morphing from another sound (fromId = its id). */
export interface IntroEnv { reps: number; mode: TransitionMode; fromId: number; }
/** An outro fade folded into a node's end: covers the last `reps` of its window,
    falling to silence (toId < 0) or morphing into another sound (toId = its id). */
export interface OutroEnv { reps: number; mode: TransitionMode; toId: number; }

/** Which way an intro blends: in from silence, or morphing from a previous sound. */
export function introKind(fromId: number): "in" | "pair" { return fromId < 0 ? "in" : "pair"; }
/** Which way an outro blends: out to silence, or morphing into a next sound. */
export function outroKind(toId: number): "out" | "pair" { return toId < 0 ? "out" : "pair"; }

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

/** A node's length expressed in bars (for the loop view label) — may be fractional
    (28 steps = 1.75 bars). */
export function nodeBars(n: VoiceNode): number {
  return nodeLen(n) / STEPS_PER_BAR;
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

// One engine LANE: a node chain plus the colour it belongs to. Placement is now
// procedural (see track.ts): a colour may compile to several lanes (overlapping loops)
// or one (priority-resolved solo loops). Mute/solo live per COLOUR on the track, not
// here — many lanes can share a colour.
export interface VoiceLine {
  nodes: VoiceNode[]; // always at least one
  color?: number;     // which colour (0..NUM_LINES-1) this lane belongs to
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
    intro?: { steps: number; mode: TransitionMode; fromId: number };
    outro?: { steps: number; mode: TransitionMode; toId: number };
  }[];
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
  setLanes(lanes: { color: number; nodes: VoiceNode[] }[], barLimit: number): void {
    this.lines = lanes.map((l) => ({ nodes: l.nodes.length ? l.nodes : [emptyNode()], color: l.color }));
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
      nodes: ln.nodes.map((n) => {
        const unit = n.steps >= 1 ? n.steps : STEPS_PER_BAR;
        const reps = Math.max(1, n.reps | 0);
        return {
          soundId: n.soundId,
          steps: n.steps,
          lenSteps: nodeLen(n),
          waitSteps: waitLen(n),
          pattern: n.steps >= 1 && n.soundId !== EMPTY
            ? voicePattern(n.hits, n.steps, n.rotation, n.split).map((b) => (b ? 1 : 0))
            : [],
          intro: n.intro
            ? { steps: Math.min(n.intro.reps, reps) * unit, mode: n.intro.mode, fromId: n.intro.fromId }
            : undefined,
          outro: n.outro
            ? { steps: Math.min(n.outro.reps, reps) * unit, mode: n.outro.mode, toId: n.outro.toId }
            : undefined,
        };
      }),
    }));
  }
}
