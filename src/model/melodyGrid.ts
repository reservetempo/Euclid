// The pattern data: six 16-step melody patterns plus a 20-slot "order" list that
// determines the playback sequence. Each pattern is 5 keys (rows) tall; the UI
// draws its 16 steps as two stacked 8-wide grids so it fits a phone screen. Each
// pattern has an identity colour used in the order view and the pattern picker.
// The loop plays the order list top to bottom, playing each referenced pattern's
// 16 steps, then repeats.

import { EUCLID_VOICES, voicePattern, VOICE_DEFAULT } from "./euclid";

export const NUM_ROWS = 5;
export const NUM_STEPS = 16;
export const NUM_BLOCKS = 6;
export const ORDER_SLOTS = 20;
export const EMPTY = -1;

// Integer gcd/lcm for the continuous-polymeter loop length, capped to match the engine
// (public/worklet/engine.js LCM_CAP) so coprime step counts can't blow the length up.
const LCM_CAP = 1024;
const gcdInt = (a: number, b: number): number => { a = Math.abs(a | 0); b = Math.abs(b | 0); while (b) { const t = a % b; a = b; b = t; } return a || 1; };
const lcmInt = (a: number, b: number): number => (!a || !b ? Math.max(a, b) || 1 : Math.min(LCM_CAP, (a / gcdInt(a, b)) * b));

// One voice (circle) of a grid in Euclidean mode: an assigned saved sound plus its
// hits/steps/start. soundId = -1 when the slot is empty (no circle drawn / no audio).
export interface EuclidVoice {
  soundId: number;
  snapshot: number[];
  color: string;
  name: string;
  pitch: [number, number];
  hits: number;
  steps: number;
  rotation: number;
  split?: number; // primary-gap override for an uneven hit split (undefined = even spread)
  mute?: boolean; // mixer: silenced (same semantics as Lane)
  solo?: boolean; // mixer: when any channel is soloed, only soloed ones are audible
  // Inline-shuffle editor state, so a reloaded voice keeps shuffling from where it left:
  preset?: string;                          // active preset (Reset target + label)
  ranges?: { lo: number[]; hi: number[] };  // live shuffle window per param
}

function emptyVoice(): EuclidVoice {
  const d = VOICE_DEFAULT;
  return { soundId: EMPTY, snapshot: [], color: "#888888", name: "", pitch: [60, 1000], hits: d.hits, steps: d.steps, rotation: d.rotation };
}

// Identity colour per grid (distinct from the per-cell drum colours).
export const GRID_COLORS = [
  "#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#4dabf7", "#b197fc",
];

export class MelodyGrid {
  // cells[row * NUM_STEPS + step] = drum index, or EMPTY.
  readonly cells: Int16Array = new Int16Array(NUM_ROWS * NUM_STEPS).fill(EMPTY);
  root = 0; // 0 = C
  scale = 0; // 0 = Major
  // When false, the row->note mapping is bypassed: each painted cell plays its
  // saved sound as-is (no key/pitch change). Root/scale are ignored while off.
  // Defaults off: new patterns play sounds as-is until you turn the key on.
  keyEnabled = false;
  // Which sound channels the key applies to while it's on (key targeting). A cell
  // whose channel isn't in here plays as-is even with the key on. Populated when the
  // key is turned on (seeded with the grid's current sounds) and toggled per sound.
  readonly keyedDrums = new Set<number>();

  isKeyed(drum: number): boolean {
    return this.keyedDrums.has(drum);
  }

  toggleKeyed(drum: number): void {
    if (this.keyedDrums.has(drum)) this.keyedDrums.delete(drum);
    else this.keyedDrums.add(drum);
  }

  // --- Euclidean mode ---------------------------------------------------
  // When true, the grid is a Euclidean sequencer: the manual cells are ignored and
  // `voices` (5 circles) play their Euclidean patterns instead. Cells are kept so
  // toggling back to Manual restores the painted pattern untouched. New grids open in
  // Euclidean mode by default.
  euclid = true;
  readonly voices: EuclidVoice[] = Array.from({ length: EUCLID_VOICES }, () => emptyVoice());

  /** Length of the Euclidean loop: the largest active voice's step count (>=1). */
  euclidLen(): number {
    let len = 1;
    for (const v of this.voices) if (v.soundId !== EMPTY && v.steps > len) len = v.steps;
    return len;
  }

  /** Steps of the reference (first assigned) voice — the length that chains to the next
      section in the loop order. Falls back to the Euclidean loop length. */
  refSteps(): number {
    for (const v of this.voices) if (v.soundId !== EMPTY && v.steps >= 1) return v.steps;
    return this.euclidLen();
  }

  /** LCM of the active voices' step counts (capped): the length at which every voice's
      polymeter phase realigns, so a single-grid loop repeats without a phase reset. */
  euclidLcm(): number {
    let l = 1;
    for (const v of this.voices) if (v.soundId !== EMPTY && v.steps >= 1) l = lcmInt(l, v.steps);
    return Math.max(1, l);
  }

  private idx(row: number, step: number): number {
    return row * NUM_STEPS + step;
  }

  getCell(row: number, step: number): number {
    return this.cells[this.idx(row, step)];
  }

  setCell(row: number, step: number, drumIndex: number): void {
    if (!MelodyGrid.isValid(row, step)) return;
    this.cells[this.idx(row, step)] = drumIndex;
  }

  clearAll(): void {
    this.cells.fill(EMPTY);
  }

  setRoot(semitone: number): void {
    this.root = ((semitone % 12) + 12) % 12;
  }

  static isValid(row: number, step: number): boolean {
    return row >= 0 && row < NUM_ROWS && step >= 0 && step < NUM_STEPS;
  }
}

export interface BlockMessage {
  cells: number[];
  root: number;
  scale: number;
  keyEnabled: boolean;
  keyedDrums: number[]; // channels the key targets (see MelodyGrid.keyedDrums)
  euclid: boolean;      // when true the engine plays `voices`, not cells
  len: number;          // steps in this grid (16 manual, else the Euclidean loop length)
  // Per-voice precomputed Euclidean pattern (1/0) + its sound id, for the engine.
  voices: { soundId: number; steps: number; pattern: number[] }[];
}

export class WipArrangement {
  readonly blocks: MelodyGrid[] = [];
  // order[slot] = grid index (0..NUM_BLOCKS-1) or EMPTY.
  readonly order: Int8Array = new Int8Array(ORDER_SLOTS).fill(EMPTY);

  constructor() {
    for (let b = 0; b < NUM_BLOCKS; b++) this.blocks.push(new MelodyGrid());
    this.order[0] = 0; // start with grid 1 in the loop
  }

  /** Grids serialised for the worklet scheduler. Euclidean patterns are precomputed
      here so the worklet stays pattern-only. */
  blocksMessage(): BlockMessage[] {
    return this.blocks.map((g) => ({
      cells: Array.from(g.cells),
      root: g.root,
      scale: g.scale,
      keyEnabled: g.keyEnabled,
      keyedDrums: [...g.keyedDrums],
      euclid: g.euclid,
      len: g.euclid ? g.euclidLen() : NUM_STEPS,
      voices: g.euclid
        ? g.voices
            .filter((v) => v.soundId !== EMPTY)
            .map((v) => ({
              soundId: v.soundId,
              steps: v.steps,
              pattern: voicePattern(v.hits, v.steps, v.rotation, v.split).map((b) => (b ? 1 : 0)),
            }))
        : [],
    }));
  }

  orderArray(): number[] {
    return Array.from(this.order);
  }

  /** Drop a grid into the first empty order slot. Returns the slot, or -1 if full. */
  addToLoop(gridIndex: number): number {
    for (let i = 0; i < ORDER_SLOTS; i++) {
      if (this.order[i] === EMPTY) {
        this.order[i] = gridIndex;
        return i;
      }
    }
    return -1;
  }

  /** Number of filled slots (sections that will play). */
  filledSlots(): number {
    let n = 0;
    for (let i = 0; i < ORDER_SLOTS; i++) if (this.order[i] !== EMPTY) n++;
    return n;
  }

  /** Total 16th-note steps in one loop pass. Consecutive slots of the same grid form one
      continuous run of `slots * referenceSteps` steps; a single grid filling the whole
      order loops at the LCM of its voice steps (continuous polymeter). Mirrors the
      engine's buildTimeline (public/worklet/engine.js). */
  loopSteps(): number {
    const runs: { gi: number; len: number }[] = [];
    let i = 0;
    while (i < ORDER_SLOTS) {
      const gi = this.order[i];
      if (!(gi >= 0 && gi < this.blocks.length)) { i++; continue; }
      let slots = 1, j = i + 1;
      while (j < ORDER_SLOTS && this.order[j] === gi) { slots++; j++; }
      const b = this.blocks[gi];
      const ref = b.euclid ? b.refSteps() : NUM_STEPS;
      runs.push({ gi, len: slots * ref });
      i = j;
    }
    if (runs.length === 0) return 0;
    if (runs.length === 1) {
      const b = this.blocks[runs[0].gi];
      return b.euclid ? Math.max(b.euclidLcm(), b.refSteps()) : runs[0].len;
    }
    return runs.reduce((s, r) => s + r.len, 0);
  }
}
