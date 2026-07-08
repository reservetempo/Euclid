// Whole-project save/load: the procedural TRACK (six colours of loops + a bar limit),
// every drum's sound, and tempo. Plain JSON, used for both localStorage autosave and
// files.
//
// v11 replaced the hand-placed node chains with the procedural placement model
// (see track.ts): each colour is an ordered list of loops carrying a placement rule.
// Older saves (v1–v10) used 6 sequential node lines; those are NOT migrated — a v≤10
// file loads with a BLANK track (its tempo and drum kit are still restored), matching
// the "start blank" decision when placement went procedural.

import { DrumType } from "./drums";
import { DrumKit } from "./drumKit";
import { IntroEnv, OutroEnv, TransitionMode, MAX_REPS, NUM_LINES, VOICE_COLORS } from "./lines";
import {
  Track, ColorTrack, Loop, PlacementRule, EveryRule, DEFAULT_BAR_LIMIT, randomSeed,
} from "./track";
import { MelodyNode, MelodyNote, emptyMelody, melodySeed } from "./melody";

export interface RuleJSON {
  every: EveryRule;
  forBars: number;
  mode: "overlap" | "solo";
  seed: number;
  seedHistory: number[];
}

export interface LoopJSON {
  soundId: number;
  snapshot: number[];
  color: string;
  name: string;
  pitch: [number, number];
  hits: number;
  steps: number;
  rotation: number;
  split?: number;
  gain?: number;
  intro?: { reps: number; mode: TransitionMode; fromId: number };
  outro?: { reps: number; mode: TransitionMode; toId: number };
  preset?: string;
  ranges?: { lo: number[]; hi: number[] };
  rule: RuleJSON;
}

export interface ColorJSON {
  loops: LoopJSON[];
  mute?: boolean;
  solo?: boolean;
}

export interface ProjectJSON {
  version: number; // 11 = procedural track; 1–10 = legacy (load blank)
  tempo: number;
  barLimit?: number;
  root?: number;
  scale?: number;
  colors?: ColorJSON[];
  drums?: Record<number, number[]>;
  ranges?: Record<number, { lo: number[]; hi: number[] }>;
  presets?: Record<number, string>;
  soundName?: string;
  melody?: MelodyJSON;
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

const cloneLoop = (l: Loop): LoopJSON => ({
  soundId: l.soundId, snapshot: l.snapshot.slice(), color: l.color, name: l.name,
  pitch: [l.pitch[0], l.pitch[1]], hits: l.hits, steps: l.steps, rotation: l.rotation,
  split: l.split, gain: l.gain,
  intro: l.intro ? { reps: l.intro.reps, mode: l.intro.mode, fromId: l.intro.fromId } : undefined,
  outro: l.outro ? { reps: l.outro.reps, mode: l.outro.mode, toId: l.outro.toId } : undefined,
  preset: l.preset,
  ranges: l.ranges ? { lo: l.ranges.lo.slice(), hi: l.ranges.hi.slice() } : undefined,
  rule: {
    every: l.rule.every,
    forBars: l.rule.forBars,
    mode: l.rule.mode,
    seed: l.rule.seed,
    seedHistory: l.rule.seedHistory.slice(),
  },
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
    version: 11,
    tempo,
    barLimit: track.barLimit,
    root: track.root,
    scale: track.scale,
    colors: track.colors.map((c) => ({
      mute: c.mute, solo: c.solo,
      loops: c.loops.map(cloneLoop),
    })),
    drums: drumSnaps,
    ranges: drumRanges,
    presets: drumPresets,
    soundName,
    melody: cloneMelody(track.melody),
  };
}

const KNOWN_MODES: TransitionMode[] = ["morph", "crossfade", "alternate", "filter", "fade", "wash", "thin"];

function readEnv(ev: unknown, side: "intro"): IntroEnv | undefined;
function readEnv(ev: unknown, side: "outro"): OutroEnv | undefined;
function readEnv(ev: unknown, side: "intro" | "outro"): IntroEnv | OutroEnv | undefined {
  if (!ev || typeof ev !== "object") return undefined;
  const e = ev as Record<string, unknown>;
  const idKey = side === "intro" ? "fromId" : "toId";
  const id = typeof e[idKey] === "number" ? (e[idKey] as number) : -1;
  const reps = typeof e.reps === "number" ? Math.max(1, Math.min(MAX_REPS, Math.round(e.reps as number))) : 1;
  const mode: TransitionMode = KNOWN_MODES.includes(e.mode as TransitionMode)
    ? (e.mode as TransitionMode)
    : (id < 0 ? "fade" : "morph");
  return side === "intro" ? { reps, mode, fromId: id } : { reps, mode, toId: id };
}

function readEvery(ev: unknown): EveryRule {
  if (ev && typeof ev === "object") {
    const e = ev as Record<string, unknown>;
    if (e.kind === "nth") return { kind: "nth", n: Math.max(1, Math.round(Number(e.n) || 1)) };
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
  return {
    every: readEvery(r.every),
    forBars: Math.max(1, Math.round(Number(r.forBars) || 1)),
    mode: r.mode === "overlap" ? "overlap" : "solo",
    seed: typeof r.seed === "number" ? (r.seed >>> 0) : randomSeed(),
    seedHistory: hist,
  };
}

function readLoop(lv: unknown, colorIndex: number): Loop {
  const s = (lv && typeof lv === "object" ? lv : {}) as Partial<LoopJSON>;
  return {
    soundId: typeof s.soundId === "number" ? s.soundId : -1,
    snapshot: Array.isArray(s.snapshot) ? s.snapshot.slice() : [],
    color: typeof s.color === "string" ? s.color : VOICE_COLORS[colorIndex % VOICE_COLORS.length],
    name: String(s.name ?? ""),
    pitch: Array.isArray(s.pitch) && s.pitch.length === 2 ? [s.pitch[0], s.pitch[1]] : [60, 1000],
    hits: s.hits ?? 0,
    steps: s.steps ?? 0,
    rotation: s.rotation ?? 0,
    split: typeof s.split === "number" ? s.split : undefined,
    gain: typeof s.gain === "number" && isFinite(s.gain) ? Math.max(0.2, Math.min(4, s.gain)) : undefined,
    intro: readEnv(s.intro, "intro"),
    outro: readEnv(s.outro, "outro"),
    preset: typeof s.preset === "string" ? s.preset : undefined,
    ranges: s.ranges && Array.isArray(s.ranges.lo) && Array.isArray(s.ranges.hi)
      ? { lo: s.ranges.lo.slice(), hi: s.ranges.hi.slice() } : undefined,
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

/** Apply a loaded project into the live track + kit. Returns the tempo. A v≤10 file
    loads a BLANK track (tempo + kit still restored). */
export function deserialize(
  json: ProjectJSON, track: Track, kit: DrumKit, drums: DrumType[]
): number {
  // Reset to a blank track so partial / legacy loads leave a sane state.
  track.colors = Array.from({ length: NUM_LINES }, () => ({ loops: [] as Loop[] }));
  track.barLimit = DEFAULT_BAR_LIMIT;
  track.root = 0;
  track.scale = 0;
  track.melody = emptyMelody();

  const v = json && json.version;
  if (json && typeof v === "number" && v === 11) {
    track.melody = readMelody(json.melody);
    if (Array.isArray(json.colors)) {
      json.colors.forEach((cj, ci) => {
        if (ci >= NUM_LINES || !cj) return;
        const ct: ColorTrack = track.colors[ci];
        ct.mute = !!cj.mute;
        ct.solo = !!cj.solo;
        ct.loops = (Array.isArray(cj.loops) ? cj.loops : []).map((lj) => readLoop(lj, ci));
      });
    }
    track.barLimit = typeof json.barLimit === "number" ? Math.max(1, Math.round(json.barLimit)) : DEFAULT_BAR_LIMIT;
    track.root = typeof json.root === "number" ? ((json.root % 12) + 12) % 12 : 0;
    track.scale = typeof json.scale === "number" ? json.scale : 0;
  }
  // (v1–v10: left blank on purpose — only tempo + kit below are restored.)

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
