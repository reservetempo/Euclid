// Whole-project save/load: the procedural TRACK (six colours of loops + a bar limit),
// every drum's sound, and tempo. Plain JSON, used for both localStorage autosave and
// files.
//
// The project is serialized as version 12: a procedural placement model (see track.ts)
// where each colour is an ordered list of loops carrying a placement rule. Only version
// 12 loads; any other version loads with a BLANK track (its tempo and drum kit are still
// restored). The format is not back-compatible with earlier generations of the app.

import { DrumType } from "./drums";
import { DrumKit } from "./drumKit";
import { IntroEnv, OutroEnv, LifePlacement, TransitionMode, BlendShapeId, BLEND_SHAPES, FADE_MODES, MAX_REPS, NUM_LINES, VOICE_COLORS } from "./lines";
import {
  Track, ColorTrack, Loop, PlacementRule, EveryRule, RowSweep, LoopTransition,
  DEFAULT_BAR_LIMIT, randomSeed, MelodyItem,
} from "./track";
import { MelodyNode, MelodyNote, emptyMelody, melodySeed, MELODY_COLOR_INDEX } from "./melody";

export interface RuleJSON {
  every: EveryRule;
  forBars: number;
  lengths?: number[];
  retrigger?: boolean;
  mode: "overlap" | "solo";
  seed: number;
  seedHistory: number[];
}

/** A per-loop transition (see LoopTransition in track.ts). */
export interface LoopTransitionJSON {
  on: boolean;
  bars: number[];
  snapshot: number[];
  shape?: BlendShapeId;
  curve?: number;
  dir?: "in" | "out";
  cycles?: number;
  points?: number[]; // "drawn" shape: the freehand blend function samples
  yGain?: number;
  yBias?: number;
  yMin?: number;
  yMax?: number;
  speedOn?: boolean;
  rate?: number;
}

export interface LoopJSON {
  soundId: number;
  snapshot: number[];
  color: string;
  name: string;
  label?: string;
  pitch: [number, number];
  hits: number;
  steps: number;
  rotation: number;
  split?: number;
  patternOv?: number[]; // hand-edited pattern override (the Loop tab's sequencer grid)
  rhythm?: boolean; // melody instrument: re-time notes onto the Euclid pattern
  gain?: number;
  intro?: { reps: number; mode: TransitionMode; modes?: TransitionMode[]; fromId: number; rate?: number; curve?: number; from?: number; to?: number; dir?: "in" | "out"; shape?: BlendShapeId; cycles?: number };
  outro?: { reps: number; mode: TransitionMode; modes?: TransitionMode[]; toId: number; rate?: number; curve?: number; from?: number; to?: number; dir?: "in" | "out"; shape?: BlendShapeId; cycles?: number };
  accent?: LifePlacement;
  ghost?: LifePlacement;
  preset?: string;
  ranges?: { lo: number[]; hi: number[] };
  transitions?: LoopTransitionJSON[]; // per-loop sound → transformed-sound transitions
  rule: RuleJSON;
}

export interface RowSweepJSON {
  on: boolean;
  fromBar: number;
  toBar: number;
  mode: TransitionMode;
  modes?: TransitionMode[];
  side: "in" | "out";
  from?: number;
  to?: number;
  curve?: number;
  dir?: "in" | "out";
  shape?: BlendShapeId;
  cycles?: number;
  rate?: number;
}

export interface ColorJSON {
  loops: LoopJSON[];
  mute?: boolean;
  solo?: boolean;
  sweeps?: RowSweepJSON[]; // the row's transition list
}

export interface ProjectJSON {
  version: number; // 12 = current format; anything else loads blank
  tempo: number;
  barLimit?: number;
  root?: number;
  scale?: number;
  colors?: ColorJSON[];
  drums?: Record<number, number[]>;
  ranges?: Record<number, { lo: number[]; hi: number[] }>;
  presets?: Record<number, string>;
  soundName?: string;
  melodies?: MelodyItemJSON[];  // the melody row: a list of placeable per-instrument melodies
}

/** One melody in the list: its re-pitched instrument (sound + placement rule) and notes. */
export interface MelodyItemJSON {
  inst: LoopJSON;
  node: MelodyJSON;
}

// A melody node serialises recursively (a note may carry a branch node).
export interface MelodyNoteJSON {
  degree: number; weight: number; lengthSteps: number; restSteps: number; branch?: MelodyJSON;
}
export interface MelodyJSON {
  scale: number; root: number; octave: number;
  notes: MelodyNoteJSON[]; seed: number; seedHistory: number[];
}

function cloneMelody(m: MelodyNode): MelodyJSON {
  return {
    scale: m.scale, root: m.root, octave: m.octave,
    seed: m.seed, seedHistory: m.seedHistory.slice(),
    notes: m.notes.map((n): MelodyNoteJSON => ({
      degree: n.degree, weight: n.weight, lengthSteps: n.lengthSteps, restSteps: n.restSteps,
      branch: n.branch ? cloneMelody(n.branch) : undefined,
    })),
  };
}

const cloneTransition = (t: LoopTransition): LoopTransitionJSON => ({
  on: t.on, bars: t.bars.slice(), snapshot: t.snapshot.slice(),
  shape: t.shape, curve: t.curve, dir: t.dir, cycles: t.cycles,
  points: t.points ? t.points.slice() : undefined,
  yGain: t.yGain, yBias: t.yBias, yMin: t.yMin, yMax: t.yMax,
  speedOn: t.speedOn, rate: t.rate,
});

const cloneLoop = (l: Loop): LoopJSON => ({
  soundId: l.soundId, snapshot: l.snapshot.slice(), color: l.color, name: l.name, label: l.label,
  pitch: [l.pitch[0], l.pitch[1]], hits: l.hits, steps: l.steps, rotation: l.rotation,
  split: l.split, patternOv: l.patternOv ? l.patternOv.slice() : undefined,
  rhythm: l.rhythm, gain: l.gain,
  transitions: l.transitions && l.transitions.length ? l.transitions.map(cloneTransition) : undefined,
  intro: l.intro ? { reps: l.intro.reps, mode: l.intro.mode, modes: l.intro.modes?.slice(), fromId: l.intro.fromId, rate: l.intro.rate, curve: l.intro.curve, from: l.intro.from, to: l.intro.to, dir: l.intro.dir, shape: l.intro.shape, cycles: l.intro.cycles } : undefined,
  outro: l.outro ? { reps: l.outro.reps, mode: l.outro.mode, modes: l.outro.modes?.slice(), toId: l.outro.toId, rate: l.outro.rate, curve: l.outro.curve, from: l.outro.from, to: l.outro.to, dir: l.outro.dir, shape: l.outro.shape, cycles: l.outro.cycles } : undefined,
  accent: l.accent ? { ...l.accent } : undefined,
  ghost: l.ghost ? { ...l.ghost } : undefined,
  preset: l.preset,
  ranges: l.ranges ? { lo: l.ranges.lo.slice(), hi: l.ranges.hi.slice() } : undefined,
  rule: {
    every: l.rule.every,
    forBars: l.rule.forBars,
    lengths: l.rule.lengths ? l.rule.lengths.slice() : undefined,
    retrigger: l.rule.retrigger,
    mode: l.rule.mode,
    seed: l.rule.seed,
    seedHistory: l.rule.seedHistory.slice(),
  },
});

const cloneSweep = (s: RowSweep): RowSweepJSON => ({
  on: s.on, fromBar: s.fromBar, toBar: s.toBar, mode: s.mode, modes: s.modes?.slice(), side: s.side,
  from: s.from, to: s.to, curve: s.curve, dir: s.dir, shape: s.shape, cycles: s.cycles, rate: s.rate,
});

export function serialize(
  track: Track, kit: DrumKit, tempo: number, drums: DrumType[], soundName: string
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
    version: 12,
    tempo,
    barLimit: track.barLimit,
    root: track.root,
    scale: track.scale,
    colors: track.colors.map((c) => ({
      mute: c.mute, solo: c.solo,
      sweeps: c.sweeps && c.sweeps.length ? c.sweeps.map(cloneSweep) : undefined,
      loops: c.loops.map(cloneLoop),
    })),
    drums: drumSnaps,
    ranges: drumRanges,
    presets: drumPresets,
    soundName,
    melodies: track.melodies.map((m) => ({ inst: cloneLoop(m.inst), node: cloneMelody(m.node) })),
  };
}

const KNOWN_MODES: TransitionMode[] = ["morph", "crossfade", "alternate", "filter", "fade", "wash", "thin", "drive", "crush", "echo", "speed"];

/** Validate a stored multi-select style set against `allowed`: keep canonical order,
    dedupe. ("speed" stacks like any other style — it warps timing while the tonal set
    morphs tone.) Returns [] when nothing valid is stored (the single `mode` field then
    stands alone). */
function readModes(mv: unknown, allowed: TransitionMode[]): TransitionMode[] {
  if (!Array.isArray(mv)) return [];
  return allowed.filter((m) => (mv as unknown[]).includes(m));
}

/** Validate a stored blend-shape id (see BlendShapeId in lines.ts); "ramp" (the default)
    normalizes to undefined so plain saves stay lean and old readers see nothing new.
    "drawn" is valid only where a points list travels with it (loop transitions). */
function readShape(sv: unknown): BlendShapeId | undefined {
  if (sv === "drawn") return "drawn";
  return sv !== "ramp" && BLEND_SHAPES.some((s) => s.id === sv) ? (sv as BlendShapeId) : undefined;
}

/** Validate a stored freehand-function sample list: 2..257 finite numbers, clamped
    to 0..1. Undefined for anything else. */
function readPoints(pv: unknown): number[] | undefined {
  if (!Array.isArray(pv) || pv.length < 2 || pv.length > 257) return undefined;
  const out = pv.map((x) => Number(x));
  if (out.some((x) => !isFinite(x))) return undefined;
  return out.map((x) => Math.max(0, Math.min(1, x)));
}

/** Validate a stored wave/stair count for the periodic blend shapes. */
function readCycles(cv: unknown): number | undefined {
  return typeof cv === "number" && isFinite(cv) ? Math.max(0.25, Math.min(999, cv)) : undefined;
}

function readEnv(ev: unknown, side: "intro"): IntroEnv | undefined;
function readEnv(ev: unknown, side: "outro"): OutroEnv | undefined;
function readEnv(ev: unknown, side: "intro" | "outro"): IntroEnv | OutroEnv | undefined {
  if (!ev || typeof ev !== "object") return undefined;
  const e = ev as Record<string, unknown>;
  const idKey = side === "intro" ? "fromId" : "toId";
  const id = typeof e[idKey] === "number" ? (e[idKey] as number) : -1;
  const reps = typeof e.reps === "number" ? Math.max(1, Math.min(MAX_REPS, Math.round(e.reps as number))) : 1;
  // A multi-select style set only exists on silence-end fades; its first entry is the mode.
  const modes = id < 0 ? readModes(e.modes, FADE_MODES) : [];
  const mode: TransitionMode = modes[0]
    ?? (KNOWN_MODES.includes(e.mode as TransitionMode)
      ? (e.mode as TransitionMode)
      : (id < 0 ? "fade" : "morph"));
  // Speed carries a far-end rate multiple (clamped 0.05..32) whenever it's in the set
  // (alone or stacked with tonal styles). The glide curve (0..1) and its direction apply
  // to EVERY mode (speed bends its timing, the rest their snapshot morph); the From→To
  // sweep endpoints are raw param values (native units, undefined = use the sound's own
  // value / the mode's built-in extreme).
  const rate = mode === "speed" || modes.includes("speed")
    ? (typeof e.rate === "number" && isFinite(e.rate) ? Math.max(0.05, Math.min(32, e.rate)) : 2)
    : undefined;
  const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : undefined);
  const curve = typeof e.curve === "number" && isFinite(e.curve) ? Math.max(0, Math.min(1, e.curve)) : undefined;
  const dir = e.dir === "in" || e.dir === "out" ? e.dir : undefined;
  const from = num(e.from);
  const to = num(e.to);
  const modeSet = modes.length > 1 ? modes : undefined;
  const shape = readShape(e.shape);
  const cycles = readCycles(e.cycles);
  return side === "intro"
    ? { reps, mode, modes: modeSet, fromId: id, rate, curve, from, to, dir, shape, cycles }
    : { reps, mode, modes: modeSet, toId: id, rate, curve, from, to, dir, shape, cycles };
}

/** Validate a stored per-loop accent/ghost LifePlacement (see lines.ts); returns
    undefined for anything malformed so old/absent saves keep the sound's own feel. */
function readLife(lv: unknown): LifePlacement | undefined {
  if (!lv || typeof lv !== "object") return undefined;
  const e = lv as Record<string, unknown>;
  const mode = e.mode === "ramp" ? "ramp" : e.mode === "everyN" ? "everyN" : undefined;
  if (!mode) return undefined;
  const clamp01 = (x: unknown, def: number) =>
    typeof x === "number" && isFinite(x) ? Math.max(0, Math.min(1, x)) : def;
  const out: LifePlacement = { mode, amount: clamp01(e.amount, 1) };
  if (mode === "everyN") {
    out.every = typeof e.every === "number" && isFinite(e.every) ? Math.max(1, Math.round(e.every)) : 2;
    if (typeof e.offset === "number" && isFinite(e.offset)) out.offset = Math.round(e.offset);
  } else {
    out.curve = clamp01(e.curve, 0);
    out.dir = e.dir === "down" ? "down" : "up";
  }
  return out;
}

function readEvery(ev: unknown): EveryRule {
  if (ev && typeof ev === "object") {
    const e = ev as Record<string, unknown>;
    if (e.kind === "nth") {
      const n = Math.max(1, Math.round(Number(e.n) || 1));
      const start = Math.max(1, Math.round(Number(e.start) || 1));
      return start > 1 ? { kind: "nth", n, start } : { kind: "nth", n };
    }
    if (e.kind === "pow2") return { kind: "pow2" };
    if (e.kind === "fill") return { kind: "fill" };
    if (e.kind === "weight") return { kind: "weight", weight: Math.max(0, Math.min(1, Number(e.weight) || 0)) };
    if (e.kind === "dice") return { kind: "dice", weight: Math.max(1, Math.min(6, Math.round(Number(e.weight) || 3))) };
    if (e.kind === "at") {
      const bars = Array.isArray(e.bars)
        ? (e.bars as unknown[]).map((x) => Math.max(1, Math.round(Number(x) || 1))).filter((n) => n >= 1)
        : [];
      return { kind: "at", bars };
    }
  }
  return { kind: "nth", n: 4 };
}

function readRule(rv: unknown): PlacementRule {
  const r = (rv && typeof rv === "object" ? rv : {}) as Record<string, unknown>;
  const hist = Array.isArray(r.seedHistory) ? (r.seedHistory as unknown[]).map((x) => (Number(x) >>> 0)) : [];
  const lens = Array.isArray(r.lengths)
    ? (r.lengths as unknown[]).map((x) => Math.max(1, Math.round(Number(x) || 1))).filter((n) => n >= 1)
    : [];
  const forBars = lens.length ? lens[0] : Math.max(1, Math.round(Number(r.forBars) || 1));
  return {
    every: readEvery(r.every),
    forBars,
    lengths: lens.length > 1 ? lens : undefined, // a single length is just forBars
    retrigger: r.retrigger === true ? true : undefined,
    mode: r.mode === "overlap" ? "overlap" : "solo",
    seed: typeof r.seed === "number" ? (r.seed >>> 0) : randomSeed(),
    seedHistory: hist,
  };
}

// Row sweeps take the full silence-fade palette, "speed" included (its warp is rebuilt
// from the compiled lanes on load — see sweepsMessage in lines.ts; only `rate` persists).
const SWEEP_MODES: TransitionMode[] = ["fade", "filter", "wash", "thin", "drive", "crush", "echo", "speed"];

/** Validate a stored per-row RowSweep; returns undefined for anything malformed. */
function readSweep(sv: unknown): RowSweep | undefined {
  if (!sv || typeof sv !== "object") return undefined;
  const s = sv as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : undefined);
  const modes = readModes(s.modes, SWEEP_MODES);
  const mode = modes[0]
    ?? (SWEEP_MODES.includes(s.mode as TransitionMode) ? (s.mode as TransitionMode) : "filter");
  const hasSpeed = mode === "speed" || modes.includes("speed");
  return {
    on: s.on === true,
    fromBar: Math.max(1, Math.round(Number(s.fromBar) || 1)),
    toBar: Math.max(1, Math.round(Number(s.toBar) || 8)),
    mode,
    modes: modes.length > 1 ? modes : undefined,
    side: s.side === "in" ? "in" : "out",
    from: num(s.from),
    to: num(s.to),
    curve: typeof s.curve === "number" && isFinite(s.curve) ? Math.max(0, Math.min(1, s.curve)) : undefined,
    dir: s.dir === "in" || s.dir === "out" ? s.dir : undefined,
    shape: readShape(s.shape),
    cycles: readCycles(s.cycles),
    rate: hasSpeed
      ? (typeof s.rate === "number" && isFinite(s.rate) ? Math.max(0.05, Math.min(32, s.rate)) : 2)
      : undefined,
  };
}

/** A row's transition list from the stored `sweeps` array. Undefined when the row has none. */
function readSweeps(cj: ColorJSON): RowSweep[] | undefined {
  const raw = Array.isArray(cj.sweeps) ? cj.sweeps : [];
  const out = raw.map(readSweep).filter((s): s is RowSweep => !!s);
  return out.length ? out : undefined;
}

/** Validate a stored per-loop transition; returns undefined for anything malformed. */
function readTransition(tv: unknown): LoopTransition | undefined {
  if (!tv || typeof tv !== "object") return undefined;
  const t = tv as Record<string, unknown>;
  const bars = Array.isArray(t.bars)
    ? (t.bars as unknown[]).map((x) => Math.round(Number(x) || 0)).filter((n) => n >= 1)
    : [];
  const snapshot = Array.isArray(t.snapshot) ? (t.snapshot as number[]).slice() : [];
  if (!snapshot.length) return undefined;
  const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : undefined);
  const clampNum = (v: unknown, lo: number, hi: number) => {
    const n = num(v);
    return n === undefined ? undefined : Math.max(lo, Math.min(hi, n));
  };
  const speedOn = t.speedOn === true ? true : undefined;
  const points = readPoints(t.points);
  let shape = readShape(t.shape);
  if (shape === "drawn" && !points) shape = undefined; // a drawing IS its points
  return {
    on: t.on !== false,
    bars,
    snapshot,
    shape,
    curve: clampNum(t.curve, 0, 1),
    dir: t.dir === "in" || t.dir === "out" ? t.dir : undefined,
    cycles: readCycles(t.cycles),
    points: shape === "drawn" ? points : undefined,
    yGain: clampNum(t.yGain, -100, 100),
    yBias: clampNum(t.yBias, -10, 10),
    yMin: clampNum(t.yMin, 0, 1),
    yMax: clampNum(t.yMax, 0, 1),
    speedOn,
    rate: speedOn ? (clampNum(t.rate, 0.05, 32) ?? 2) : undefined,
  };
}

/** The stored per-loop transition list, malformed entries dropped. */
function readTransitions(tv: unknown): LoopTransition[] | undefined {
  if (!Array.isArray(tv)) return undefined;
  const out = tv.map(readTransition).filter((t): t is LoopTransition => !!t);
  return out.length ? out : undefined;
}

function readLoop(lv: unknown, colorIndex: number): Loop {
  const s = (lv && typeof lv === "object" ? lv : {}) as Partial<LoopJSON>;
  return {
    soundId: typeof s.soundId === "number" ? s.soundId : -1,
    snapshot: Array.isArray(s.snapshot) ? s.snapshot.slice() : [],
    color: typeof s.color === "string" ? s.color : VOICE_COLORS[colorIndex % VOICE_COLORS.length],
    name: String(s.name ?? ""),
    label: typeof s.label === "string" && s.label ? s.label : undefined,
    pitch: Array.isArray(s.pitch) && s.pitch.length === 2 ? [s.pitch[0], s.pitch[1]] : [60, 1000],
    hits: s.hits ?? 0,
    steps: s.steps ?? 0,
    rotation: s.rotation ?? 0,
    split: typeof s.split === "number" ? s.split : undefined,
    patternOv: Array.isArray(s.patternOv) && s.patternOv.length
      ? s.patternOv.map((x) => (x ? 1 : 0)) : undefined,
    rhythm: s.rhythm === true ? true : undefined,
    gain: typeof s.gain === "number" && isFinite(s.gain) ? Math.max(0.2, Math.min(4, s.gain)) : undefined,
    intro: readEnv(s.intro, "intro"),
    outro: readEnv(s.outro, "outro"),
    accent: readLife(s.accent),
    ghost: readLife(s.ghost),
    preset: typeof s.preset === "string" ? s.preset : undefined,
    ranges: s.ranges && Array.isArray(s.ranges.lo) && Array.isArray(s.ranges.hi)
      ? { lo: s.ranges.lo.slice(), hi: s.ranges.hi.slice() } : undefined,
    transitions: readTransitions(s.transitions),
    rule: readRule(s.rule),
  };
}

function readMelody(mv: unknown): MelodyNode {
  const base = emptyMelody();
  if (!mv || typeof mv !== "object") return base;
  const m = mv as Partial<MelodyJSON>;
  const notes: MelodyNote[] = Array.isArray(m.notes)
    ? m.notes.map((nj): MelodyNote => ({
        degree: Math.round(Number(nj?.degree) || 0),
        weight: Math.max(1, Math.min(6, Math.round(Number(nj?.weight) || 3))),
        lengthSteps: Math.max(1, Math.round(Number(nj?.lengthSteps) || 4)),
        restSteps: Math.max(0, Math.round(Number(nj?.restSteps) || 0)),
        branch: nj?.branch ? readMelody(nj.branch) : undefined,
      }))
    : [];
  return {
    scale: Math.max(0, Math.round(Number(m.scale) || 0)),
    root: typeof m.root === "number" ? ((m.root % 12) + 12) % 12 : 0,
    octave: typeof m.octave === "number" ? Math.max(-3, Math.min(3, Math.round(m.octave))) : 0,
    notes,
    seed: typeof m.seed === "number" ? (m.seed >>> 0) : melodySeed(),
    seedHistory: Array.isArray(m.seedHistory) ? m.seedHistory.map((x) => Number(x) >>> 0) : [],
  };
}

/** The melody list from the stored `melodies` array. Empty when there's no melody data
    (the UI then starts on the "add a melody" menu). */
function readMelodies(json: ProjectJSON): MelodyItem[] {
  if (Array.isArray(json.melodies) && json.melodies.length) {
    return json.melodies.map((mj) => ({
      inst: readLoop(mj?.inst, MELODY_COLOR_INDEX),
      node: readMelody(mj?.node),
    }));
  }
  return [];
}

/** Apply a loaded project into the live track + kit. Returns the tempo. A non-v12 file
    loads a BLANK track (tempo + kit still restored). */
export function deserialize(
  json: ProjectJSON, track: Track, kit: DrumKit, drums: DrumType[]
): number {
  // Reset to a blank track so partial / legacy loads leave a sane state.
  track.colors = Array.from({ length: NUM_LINES }, () => ({ loops: [] as Loop[] }));
  track.barLimit = DEFAULT_BAR_LIMIT;
  track.root = 0;
  track.scale = 0;
  track.melodies = [];

  const v = json && json.version;
  if (json && typeof v === "number" && v === 12) {
    track.melodies = readMelodies(json);
    if (Array.isArray(json.colors)) {
      json.colors.forEach((cj, ci) => {
        if (ci >= NUM_LINES || !cj) return;
        const ct: ColorTrack = track.colors[ci];
        ct.mute = !!cj.mute;
        ct.solo = !!cj.solo;
        ct.sweeps = readSweeps(cj);
        ct.loops = (Array.isArray(cj.loops) ? cj.loops : []).map((lj) => readLoop(lj, ci));
      });
    }
    track.barLimit = typeof json.barLimit === "number" ? Math.max(1, Math.round(json.barLimit)) : DEFAULT_BAR_LIMIT;
    track.root = typeof json.root === "number" ? ((json.root % 12) + 12) % 12 : 0;
    track.scale = typeof json.scale === "number" ? json.scale : 0;
  }
  // (Any other version: track left blank on purpose — only tempo + kit below are restored.)

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
