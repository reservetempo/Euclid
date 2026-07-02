// Whole-project save/load: the 6 voice lines (node chains), every drum's sound,
// and tempo. Plain JSON, used for both localStorage autosave and files.
//
// v8 replaced the old 6-grids + 20-slot-order arrangement with per-voice node
// lines; deserialize() migrates older saves by walking the old order list and
// turning each run of a grid into one node per voice (bars ≈ the run's length).

import { DrumType } from "./drums";
import { DrumKit } from "./drumKit";
import {
  LineArrangement, VoiceNode, emptyNode, NUM_LINES, STEPS_PER_BAR, MAX_BARS, EMPTY,
} from "./lines";

export interface NodeJSON {
  soundId: number;
  snapshot: number[];
  color: string;
  name: string;
  pitch: [number, number];
  hits: number;
  steps: number;
  rotation: number;
  split?: number;
  bars: number;
  preset?: string;
  ranges?: { lo: number[]; hi: number[] };
}

export interface LineJSON {
  nodes: NodeJSON[];
  mute?: boolean;
  solo?: boolean;
}

// --- legacy (pre-v8) shapes, kept only for migration --------------------------
interface LegacyVoiceJSON {
  soundId: number; snapshot: number[]; color: string; name: string;
  pitch: [number, number]; hits: number; steps: number; rotation: number;
  split?: number; mute?: boolean; solo?: boolean;
  preset?: string; ranges?: { lo: number[]; hi: number[] };
}
interface LegacyBlockJSON {
  euclid?: boolean;
  voices?: LegacyVoiceJSON[];
}

export interface ProjectJSON {
  version: number; // 8 = node lines; 1-7 = legacy grids/order (migrated on load)
  tempo: number;
  lines?: LineJSON[];             // v8
  root?: number;                  // v8: global key context for pitch-snap shuffles
  scale?: number;
  drums?: Record<number, number[]>; // background editor kit (all versions)
  ranges?: Record<number, { lo: number[]; hi: number[] }>;
  presets?: Record<number, string>;
  soundName?: string;
  // Legacy fields (v1-v7), read only by the migration:
  blocks?: LegacyBlockJSON[];
  order?: number[];
}

const cloneNode = (n: VoiceNode): NodeJSON => ({
  soundId: n.soundId, snapshot: n.snapshot.slice(), color: n.color, name: n.name,
  pitch: [n.pitch[0], n.pitch[1]], hits: n.hits, steps: n.steps, rotation: n.rotation,
  split: n.split, bars: n.bars, preset: n.preset,
  ranges: n.ranges ? { lo: n.ranges.lo.slice(), hi: n.ranges.hi.slice() } : undefined,
});

export function serialize(
  arr: LineArrangement, kit: DrumKit, tempo: number, drums: DrumType[], soundName: string
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
    version: 8,
    tempo,
    root: arr.root,
    scale: arr.scale,
    lines: arr.lines.map((ln) => ({
      mute: ln.mute, solo: ln.solo,
      nodes: ln.nodes.map(cloneNode),
    })),
    drums: drumSnaps,
    ranges: drumRanges,
    presets: drumPresets,
    soundName,
  };
}

// Restore one node from JSON, tolerating holes (older shapes, hand-edited files).
function readNode(sv: Partial<NodeJSON> | null | undefined, bars: number): VoiceNode {
  const n = emptyNode();
  if (!sv) { n.bars = bars; return n; }
  n.soundId = typeof sv.soundId === "number" ? sv.soundId : EMPTY;
  n.snapshot = Array.isArray(sv.snapshot) ? sv.snapshot.slice() : [];
  n.color = sv.color ?? "#888888";
  n.name = String(sv.name ?? "");
  n.pitch = Array.isArray(sv.pitch) && sv.pitch.length === 2 ? [sv.pitch[0], sv.pitch[1]] : [60, 1000];
  n.hits = sv.hits ?? 0;
  n.steps = sv.steps ?? 0;
  n.rotation = sv.rotation ?? 0;
  n.split = typeof sv.split === "number" ? sv.split : undefined;
  n.bars = Math.max(1, Math.min(MAX_BARS, Math.round(typeof sv.bars === "number" ? sv.bars : bars)));
  n.preset = typeof sv.preset === "string" ? sv.preset : undefined;
  n.ranges = sv.ranges && Array.isArray(sv.ranges.lo) && Array.isArray(sv.ranges.hi)
    ? { lo: sv.ranges.lo.slice(), hi: sv.ranges.hi.slice() }
    : undefined;
  return n;
}

// --- migration: grids + order (v6/v7) → node lines -----------------------------
// The old loop order played runs of grids, every voice switching together. Per
// voice slot, each run becomes one node copied from that grid's voice (or a silent
// rest node when the voice was empty there), with bars ≈ the run's length — so a
// migrated project sounds like it used to, and can then diverge per line.
function migrateLegacy(json: ProjectJSON, arr: LineArrangement): void {
  const blocks = Array.isArray(json.blocks) ? json.blocks : [];
  const order = (Array.isArray(json.order) ? json.order : []).filter(
    (g) => typeof g === "number" && g >= 0 && g < blocks.length && blocks[g]?.euclid
  );

  // Reference steps of a grid = its first assigned voice's step count (the old
  // engine's run unit); grids with no assigned voices count one bar.
  const refSteps = (g: LegacyBlockJSON): number => {
    for (const v of g.voices ?? []) if (v && v.soundId >= 0 && (v.steps | 0) >= 1) return v.steps | 0;
    return STEPS_PER_BAR;
  };

  // Collapse the order into runs of the same grid.
  const runs: { grid: number; bars: number }[] = [];
  for (let i = 0; i < order.length; ) {
    const gi = order[i];
    let slots = 1;
    while (i + slots < order.length && order[i + slots] === gi) slots++;
    const steps = slots * refSteps(blocks[gi]);
    runs.push({ grid: gi, bars: Math.max(1, Math.round(steps / STEPS_PER_BAR)) });
    i += slots;
  }
  // No usable order: fall back to the first Euclidean grid as a single run.
  if (runs.length === 0) {
    const gi = blocks.findIndex((b) => b?.euclid && (b.voices ?? []).some((v) => v && v.soundId >= 0));
    if (gi >= 0) runs.push({ grid: gi, bars: Math.max(1, Math.round(refSteps(blocks[gi]) / STEPS_PER_BAR)) });
  }
  if (runs.length === 0) return; // nothing to migrate — keep the blank lines

  for (let li = 0; li < NUM_LINES; li++) {
    const nodes: VoiceNode[] = [];
    for (const run of runs) {
      const v = blocks[run.grid]?.voices?.[li];
      nodes.push(readNode(v && v.soundId >= 0 ? { ...v, bars: run.bars } : null, run.bars));
      // Line-level mute/solo: adopt any voice-level flag seen for this slot.
      if (v?.mute) arr.lines[li].mute = true;
      if (v?.solo) arr.lines[li].solo = true;
    }
    arr.lines[li].nodes = nodes;
  }
}

/** Apply a loaded project into the live arrangement + kit. Returns the tempo. */
export function deserialize(
  json: ProjectJSON, arr: LineArrangement, kit: DrumKit, drums: DrumType[]
): number {
  // Reset to blank lines first so partial loads leave a sane state.
  for (let i = 0; i < NUM_LINES; i++) {
    arr.lines[i].nodes = [emptyNode()];
    arr.lines[i].mute = false;
    arr.lines[i].solo = false;
  }
  arr.root = 0;
  arr.scale = 0;
  const v = json && json.version;
  if (!json || typeof v !== "number" || v < 1 || v > 8) return 120;

  if (v >= 8 && Array.isArray(json.lines)) {
    json.lines.forEach((lj, i) => {
      if (i >= NUM_LINES || !lj) return;
      const nodes = (Array.isArray(lj.nodes) ? lj.nodes : []).map((n) => readNode(n, 1));
      if (nodes.length) arr.lines[i].nodes = nodes;
      arr.lines[i].mute = !!lj.mute;
      arr.lines[i].solo = !!lj.solo;
    });
    arr.root = typeof json.root === "number" ? ((json.root % 12) + 12) % 12 : 0;
    arr.scale = typeof json.scale === "number" ? json.scale : 0;
  } else {
    migrateLegacy(json, arr);
  }

  for (const d of drums) {
    // Ranges first so values clamp against the right window (see DrumParameters).
    const name = json.presets?.[d];
    if (name) kit.adoptPresetByName(d, name);
    const r = json.ranges?.[d];
    if (r && Array.isArray(r.lo) && Array.isArray(r.hi)) kit.get(d).restoreRanges(r.lo, r.hi);
    const snap = json.drums?.[d];
    if (snap) kit.get(d).restore(snap);
  }

  return typeof json.tempo === "number" ? json.tempo : 120;
}
