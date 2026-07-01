// The pattern data: six 16-step melody patterns plus a 20-slot "order" list that
// determines the playback sequence. Each pattern is 5 keys (rows) tall; the UI
// draws its 16 steps as two stacked 8-wide grids so it fits a phone screen. Each
// pattern has an identity colour used in the order view and the pattern picker.
// The loop plays the order list top to bottom, playing each referenced pattern's
// 16 steps, then repeats.

import { EUCLID_VOICES, euclidPattern, VOICE_DEFAULT } from "./euclid";

export const NUM_ROWS = 5;
export const NUM_STEPS = 16;
export const NUM_BLOCKS = 6;
export const ORDER_SLOTS = 20;
export const EMPTY = -1;

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
  mute?: boolean; // mixer: silenced (same semantics as Lane)
  solo?: boolean; // mixer: when any channel is soloed, only soloed ones are audible
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
              pattern: euclidPattern(v.hits, v.steps, v.rotation).map((b) => (b ? 1 : 0)),
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

  /** Total 16th-note steps in one loop pass (each filled slot contributes its grid's
      length: 16 for manual, the Euclidean loop length otherwise). */
  loopSteps(): number {
    let total = 0;
    for (let i = 0; i < ORDER_SLOTS; i++) {
      const g = this.order[i];
      if (g >= 0 && g < this.blocks.length) {
        const b = this.blocks[g];
        total += b.euclid ? b.euclidLen() : NUM_STEPS;
      }
    }
    return total;
  }
}
