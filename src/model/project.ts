// Whole-project save/load: the 6 grids, the 20-slot order list, every drum's
// sound, and tempo. Plain JSON, used for both localStorage autosave and files.

import { DrumType } from "./drums";
import { DrumKit } from "./drumKit";
import { WipArrangement, NUM_BLOCKS, NUM_ROWS, NUM_STEPS, ORDER_SLOTS, EMPTY } from "./melodyGrid";

// A Steps-view paint lane: a saved sound with a stable id grid cells reference
// (see app.ts Lane). Pre-v5 saves stored this id under `drum` (it was the channel).
export interface LaneJSON {
  soundId: number; // stable sound id (v5+)
  drum?: number; // legacy id field (pre-v5) — read into soundId on load
  name: string;
  snapshot: number[];
  color?: string; // absent in older saves
  pitch?: [number, number]; // absent in older saves
  mute?: boolean; // mixer state; absent in older saves
  solo?: boolean;
}

// A Euclidean voice (circle) of a grid: assigned sound + hits/steps/start. (v6+)
export interface EuclidVoiceJSON {
  soundId: number;
  snapshot: number[];
  color: string;
  name: string;
  pitch: [number, number];
  hits: number;
  steps: number;
  rotation: number;
  mute?: boolean; // mixer state; absent in older saves
  solo?: boolean;
}

export interface ProjectJSON {
  version: 3 | 4 | 5 | 6;
  tempo: number;
  blocks: {
    cells: number[]; root: number; scale: number; keyEnabled?: boolean; keyedDrums?: number[];
    euclid?: boolean; voices?: EuclidVoiceJSON[]; // v6+
  }[];
  order: number[];
  drums: Record<number, number[]>; // drum type -> param snapshot
  // drum type -> live shuffle window (v3+); absent saves fall back to factory ranges.
  ranges?: Record<number, { lo: number[]; hi: number[] }>;
  presets?: Record<number, string>; // drum type -> active preset name (label/Reset target)
  soundName?: string; // name of the current sound being designed in the Sounds view
  lanesPerBlock?: LaneJSON[][]; // v4: one paint-lane list per grid
  lanes?: LaneJSON[]; // v1-v3: a single global lane list (migrated into block 0)
}

const cloneLane = (l: LaneJSON): LaneJSON => ({
  soundId: l.soundId, name: l.name, snapshot: l.snapshot.slice(), color: l.color, pitch: l.pitch,
  mute: l.mute, solo: l.solo,
});

export function serialize(
  arr: WipArrangement, kit: DrumKit, tempo: number, drums: DrumType[], lanesPerBlock: LaneJSON[][],
  soundName: string
): ProjectJSON {
  const drumSnaps: Record<number, number[]> = {};
  const drumRanges: Record<number, { lo: number[]; hi: number[] }> = {};
  const drumPresets: Record<number, string> = {};
  for (const d of drums) {
    drumSnaps[d] = kit.get(d).capture();
    drumRanges[d] = kit.get(d).captureRanges();
    drumPresets[d] = kit.get(d).presetName();
  }
  return {
    version: 6,
    tempo,
    // Persist the editable grid state (NOT blocksMessage, which is engine-shaped and
    // drops the Euclidean voice config).
    blocks: arr.blocks.map((g) => ({
      cells: Array.from(g.cells),
      root: g.root,
      scale: g.scale,
      keyEnabled: g.keyEnabled,
      keyedDrums: [...g.keyedDrums],
      euclid: g.euclid,
      voices: g.voices.map((v) => ({
        soundId: v.soundId, snapshot: v.snapshot.slice(), color: v.color, name: v.name,
        pitch: [v.pitch[0], v.pitch[1]] as [number, number], hits: v.hits, steps: v.steps, rotation: v.rotation,
        mute: v.mute, solo: v.solo,
      })),
    })),
    order: arr.orderArray(),
    drums: drumSnaps,
    ranges: drumRanges,
    presets: drumPresets,
    soundName,
    lanesPerBlock: lanesPerBlock.map((list) => list.map(cloneLane)),
  };
}

const normLane = (l: LaneJSON): LaneJSON => {
  const pitchVal = l.snapshot[0] ?? 200; // ParamId.Pitch = 0
  return {
    soundId: l.soundId ?? l.drum ?? 0, // pre-v5 stored the id under `drum`
    name: String(l.name ?? ""),
    snapshot: l.snapshot.slice(),
    color: l.color ?? "#888888",
    pitch: Array.isArray(l.pitch) && l.pitch.length === 2 ? [l.pitch[0], l.pitch[1]] : [pitchVal * 0.5, pitchVal * 2],
    mute: !!l.mute,
    solo: !!l.solo,
  };
};

/** Apply a loaded project into the live arrangement + kit, repopulating
    `lanesPerBlock` in place (one list per grid). Returns the tempo. */
export function deserialize(
  json: ProjectJSON, arr: WipArrangement, kit: DrumKit, drums: DrumType[], lanesPerBlock: LaneJSON[][]
): number {
  for (const list of lanesPerBlock) list.length = 0;
  const v = json && (json as { version: number }).version;
  if (!json || (v !== 1 && v !== 2 && v !== 3 && v !== 4 && v !== 5 && v !== 6)) return 120;

  // v4+: a lane list per grid. v1-v3: one global list -> migrate into block 0.
  if (json.lanesPerBlock) {
    json.lanesPerBlock.forEach((list, b) => {
      if (b >= NUM_BLOCKS) return;
      for (const l of list ?? []) if (l && Array.isArray(l.snapshot)) lanesPerBlock[b].push(normLane(l));
    });
  } else {
    for (const l of json.lanes ?? []) {
      if (l && Array.isArray(l.snapshot)) lanesPerBlock[0].push(normLane(l));
    }
  }

  for (let b = 0; b < NUM_BLOCKS; b++) {
    const src = json.blocks?.[b];
    const dst = arr.blocks[b];
    if (!src) continue;
    for (let i = 0; i < NUM_ROWS * NUM_STEPS; i++) {
      dst.cells[i] = src.cells?.[i] ?? EMPTY;
    }
    dst.root = ((src.root % 12) + 12) % 12;
    dst.scale = src.scale ?? 0;
    dst.keyEnabled = src.keyEnabled !== false; // older saves had no key toggle -> on
    // Key targeting: use the saved set if present; otherwise (older saves) seed it
    // with every channel painted in this block, preserving the all-rows-keyed default.
    dst.keyedDrums.clear();
    if (Array.isArray(src.keyedDrums)) {
      for (const d of src.keyedDrums) dst.keyedDrums.add(d);
    } else {
      for (let i = 0; i < NUM_ROWS * NUM_STEPS; i++) {
        const d = dst.cells[i];
        if (d >= 0) dst.keyedDrums.add(d);
      }
    }
    // Euclidean mode (v6+); older saves stay manual with empty voices.
    dst.euclid = !!src.euclid;
    if (Array.isArray(src.voices)) {
      src.voices.forEach((sv, i) => {
        if (i >= dst.voices.length || !sv) return;
        const dv = dst.voices[i];
        dv.soundId = typeof sv.soundId === "number" ? sv.soundId : EMPTY;
        dv.snapshot = Array.isArray(sv.snapshot) ? sv.snapshot.slice() : [];
        dv.color = sv.color ?? "#888888";
        dv.name = String(sv.name ?? "");
        dv.pitch = Array.isArray(sv.pitch) && sv.pitch.length === 2 ? [sv.pitch[0], sv.pitch[1]] : [60, 1000];
        dv.hits = sv.hits ?? 4;
        dv.steps = sv.steps ?? 8;
        dv.rotation = sv.rotation ?? 0;
        dv.mute = !!sv.mute;
        dv.solo = !!sv.solo;
      });
    }
  }

  for (let i = 0; i < ORDER_SLOTS; i++) {
    arr.order[i] = json.order?.[i] ?? EMPTY;
  }

  for (const d of drums) {
    // Ranges first so values clamp against the right window; restore() pads any
    // short (pre-LFO2/3) snapshot with defaults, and absent ranges keep the
    // factory window the kit was constructed with.
    const name = json.presets?.[d];
    if (name) kit.adoptPresetByName(d, name);
    const r = json.ranges?.[d];
    if (r && Array.isArray(r.lo) && Array.isArray(r.hi)) kit.get(d).restoreRanges(r.lo, r.hi);
    const snap = json.drums?.[d];
    if (snap) kit.get(d).restore(snap);
  }

  return typeof json.tempo === "number" ? json.tempo : 120;
}
