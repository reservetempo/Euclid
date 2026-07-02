// The pattern data: 6 voice LINES, each a chain of NODES. A node is one sound plus
// one Euclidean rhythm (hits/steps/start/split) that holds its line for `bars` bars;
// when its bars elapse the line moves to its next node, wrapping at the end. The
// loop is as long as the LONGEST line: every line plays its chain ONCE per loop and
// then rests until the loop comes round, so all lines realign at the top (a 1-bar
// voice sits out the other 3 bars of a 4-bar voice rather than repeating under it).
// Polymeter still lives at the STEP scale — a node whose `steps` doesn't divide its
// bar window cycles at its own rate — and node chains let a voice change its rhythm
// across the loop.
//
// This replaces the previous 6-grids + 20-slot-order arrangement (every voice used
// to switch grids together); see project.ts for the migration of old saves.

import { EUCLID_VOICES, voicePattern, VOICE_DEFAULT } from "./euclid";

export const NUM_LINES = EUCLID_VOICES; // one line per voice ring / logo letter
export const STEPS_PER_BAR = 16;        // 4/4 at 16th-note steps
export const MAX_BARS = 64;             // per node
export const EMPTY = -1;

// Identity colour per voice line (inner ring → outer ring), and per logo letter —
// one six-colour rainbow for the whole app (rings, rows, node dots, wordmark).
export const VOICE_COLORS = [
  "#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#4dabf7", "#b197fc",
];

// One node of a line: an assigned saved sound plus its rhythm and its duration in
// bars. soundId = EMPTY when no sound is assigned yet — the node still occupies its
// bars (a rest), so the line's timing holds while you sketch.
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
  bars: number;   // how many bars this node holds the line before the next node
  // Inline-shuffle editor state, so a reloaded node keeps shuffling where it left:
  preset?: string;                          // active preset (Reset target + label)
  ranges?: { lo: number[]; hi: number[] };  // live shuffle window per param
}

export function emptyNode(): VoiceNode {
  const d = VOICE_DEFAULT;
  return {
    soundId: EMPTY, snapshot: [], color: "#888888", name: "", pitch: [60, 1000],
    hits: d.hits, steps: d.steps, rotation: d.rotation, bars: 1,
  };
}

// One voice line: its node chain plus line-level mix state (mute/solo silence the
// whole chain — the mixer works per line, not per node).
export interface VoiceLine {
  nodes: VoiceNode[]; // always at least one
  mute?: boolean;
  solo?: boolean;
}

// Engine-shaped line: per node the sound id, its own step count, its length in
// STEPS (bars × 16, precomputed), and the precomputed hit pattern.
export interface LineMessage {
  nodes: { soundId: number; steps: number; lenSteps: number; pattern: number[] }[];
}

export class LineArrangement {
  readonly lines: VoiceLine[] = Array.from({ length: NUM_LINES }, () => ({ nodes: [emptyNode()] }));
  // Key context for the shuffle's pitch snap (Key mode) — global, not per grid.
  root = 0;  // 0 = C
  scale = 0; // 0 = Major

  /** Length of one pass of a line, in 16th steps (sum of its node bars). */
  lineSteps(li: number): number {
    let bars = 0;
    for (const n of this.lines[li].nodes) bars += Math.max(1, n.bars | 0);
    return bars * STEPS_PER_BAR;
  }

  /** True when the line has at least one node with a sound (it makes noise). */
  lineActive(li: number): boolean {
    return this.lines[li].nodes.some((n) => n.soundId !== EMPTY);
  }

  /** The loop length in steps: the LONGEST line's chain. Every line plays its chain
      once per loop and then rests until it restarts, so all lines realign at the top
      — this IS the scheduling boundary (mirrored in engine.js fireStep). Returns 0
      when no line has a sound (nothing to play or export). */
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
      worklet stays pattern-only). Every node ships, including silent ones — they
      hold their bars as rests. */
  linesMessage(): LineMessage[] {
    return this.lines.map((ln) => ({
      nodes: ln.nodes.map((n) => ({
        soundId: n.soundId,
        steps: n.steps,
        lenSteps: Math.max(1, n.bars | 0) * STEPS_PER_BAR,
        pattern: n.soundId !== EMPTY && n.steps >= 1
          ? voicePattern(n.hits, n.steps, n.rotation, n.split).map((b) => (b ? 1 : 0))
          : [],
      })),
    }));
  }
}
