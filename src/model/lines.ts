// The pattern data: 6 voice LINES, each a chain of NODES. A node is one sound plus
// one Euclidean rhythm (hits/steps/start/split) that REPEATS `reps` times, so its
// length in steps is `reps × steps` (a 14-step pattern at 2 reps is 28 steps, NOT
// padded up to two 16-step bars). A node with no rhythm yet (steps 0) falls back to
// `reps` whole bars. When a node's window elapses the line moves to its next node,
// wrapping at the end of the chain.
//
// The loop is as long as the LONGEST line: every line plays its chain ONCE per loop
// and then rests until the loop comes round, so all lines realign at the top (a
// short voice sits out the rest of a long voice rather than repeating under it).
// Polymeter still lives at the STEP scale — a node whose `steps` doesn't divide a
// bar cycles at its own rate — and node chains let a voice change rhythm over the
// loop.
//
// A node may instead be a TRANSITION: it carries `transition:{fromId,toId}` and
// morphs the sound of the previous node into the next across its window (the engine
// lerps their snapshots per hit). See engine.js fireStep.
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
  transition?: { fromId: number; toId: number }; // morph A→B over this node's window
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

/** A node's length in 16th-note steps: `reps × steps`, or `reps` whole bars when the
    node has no rhythm yet (steps 0). Single source of truth for the engine message,
    the loop math, and the section-loop window. */
export function nodeLen(n: VoiceNode): number {
  const unit = n.steps >= 1 ? n.steps : STEPS_PER_BAR;
  return Math.max(1, n.reps | 0) * unit;
}

/** A node's length expressed in bars (for the loop view label) — may be fractional
    (28 steps = 1.75 bars). */
export function nodeBars(n: VoiceNode): number {
  return nodeLen(n) / STEPS_PER_BAR;
}

// One voice line: its node chain plus line-level mix state (mute/solo silence the
// whole chain — the mixer works per line, not per node).
export interface VoiceLine {
  nodes: VoiceNode[]; // always at least one
  mute?: boolean;
  solo?: boolean;
}

// Engine-shaped line: per node the sound id, its own step count, its length in
// STEPS (precomputed), the precomputed hit pattern, and (transitions only) the
// from/to sound ids to morph between.
export interface LineMessage {
  nodes: {
    soundId: number;
    steps: number;
    lenSteps: number;
    pattern: number[];
    transition?: { fromId: number; toId: number };
  }[];
}

export class LineArrangement {
  readonly lines: VoiceLine[] = Array.from({ length: NUM_LINES }, () => ({ nodes: [emptyNode()] }));
  // Key context for the shuffle's pitch snap (Key mode) — global, not per grid.
  root = 0;  // 0 = C
  scale = 0; // 0 = Major

  /** Length of one pass of a line, in 16th steps (sum of its node windows). */
  lineSteps(li: number): number {
    let s = 0;
    for (const n of this.lines[li].nodes) s += nodeLen(n);
    return s;
  }

  /** True when the line has at least one node that makes sound (a real sound or a
      transition between two sounds). */
  lineActive(li: number): boolean {
    return this.lines[li].nodes.some((n) => n.soundId !== EMPTY || !!n.transition);
  }

  /** The loop length in steps: the LONGEST line's chain. Every line plays its chain
      once per loop and then rests until it restarts, so all lines realign at the top
      — this IS the scheduling boundary (mirrored in engine.js fireStep). Returns 0
      when no line makes sound (nothing to play or export). */
  loopSteps(): number {
    let active = false;
    let l = 0;
    for (let i = 0; i < NUM_LINES; i++) {
      if (this.lineActive(i)) active = true;
      const s = this.lineSteps(i);
      if (s > l) l = s;
    }
    return active ? l : 0;
  }

  /** Lines serialised for the worklet scheduler (patterns precomputed here so the
      worklet stays pattern-only). Every node ships, including silent rests. */
  linesMessage(): LineMessage[] {
    return this.lines.map((ln) => ({
      nodes: ln.nodes.map((n) => ({
        soundId: n.soundId,
        steps: n.steps,
        lenSteps: nodeLen(n),
        pattern: n.steps >= 1 && (n.soundId !== EMPTY || n.transition)
          ? voicePattern(n.hits, n.steps, n.rotation, n.split).map((b) => (b ? 1 : 0))
          : [],
        transition: n.transition ? { fromId: n.transition.fromId, toId: n.transition.toId } : undefined,
      })),
    }));
  }
}
