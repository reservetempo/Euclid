// The pattern data: 6 voice LINES, each a chain of NODES. A node is one sound plus
// one Euclidean rhythm (hits/steps/start/split) that holds its line for `bars` bars;
// when its bars elapse the line moves to its next node, wrapping at the end. Every
// line advances independently — different lines can have different total lengths
// (and nodes different step counts), so the whole piece is a long-form polymeter
// with no global "pattern switch": each voice flows through its own node chain.
//
// This replaces the previous 6-grids + 20-slot-order arrangement (every voice used
// to switch grids together); see project.ts for the migration of old saves.

import { EUCLID_VOICES, voicePattern, VOICE_DEFAULT } from "./euclid";

export const NUM_LINES = EUCLID_VOICES; // one line per voice ring / logo letter
export const STEPS_PER_BAR = 16;        // 4/4 at 16th-note steps
export const MAX_BARS = 64;             // per node
export const EMPTY = -1;

// Cap on the combined loop length (steps) reported by loopSteps(): the LCM of the
// line lengths realigns everything, but wildly coprime bar counts would blow it up.
const LOOP_LCM_CAP = 16384;

const gcdInt = (a: number, b: number): number => { a = Math.abs(a | 0); b = Math.abs(b | 0); while (b) { const t = a % b; a = b; b = t; } return a || 1; };
const lcmInt = (a: number, b: number): number => (!a || !b ? Math.max(a, b) || 1 : Math.min(LOOP_LCM_CAP, (a / gcdInt(a, b)) * b));

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

  /** Steps until every ACTIVE line realigns (LCM of their lengths, capped) — the
      display/export "loop length". Lines wrap independently in the engine, so this
      is bookkeeping, not a scheduling unit. */
  loopSteps(): number {
    let l = 0;
    for (let i = 0; i < NUM_LINES; i++) {
      if (!this.lineActive(i)) continue;
      l = l === 0 ? this.lineSteps(i) : lcmInt(l, this.lineSteps(i));
    }
    return l;
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
