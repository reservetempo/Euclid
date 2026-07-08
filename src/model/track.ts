// PROCEDURAL PLACEMENT MODEL. The authoring surface is a TRACK: a whole-track bar
// limit plus six COLOURS (one per voice ring), each owning an ordered list of LOOPS.
// A loop is a sound + Euclidean rhythm (the "what it sounds like" half of a VoiceNode)
// plus a PLACEMENT RULE that says WHERE it lands on the timeline — instead of the old
// hand-dragged reps/wait chain.
//
//   Repeat every:  • a WEIGHT (each forBars slot placed with probability `weight`, from
//                    a seeded RNG so the roll is fixed until re-rolled)
//                  • every Nth bar
//                  • at POWER-OF-2 bars (1, 2, 4, 8, 16 …)
//   For: n bars    — how long each placement sounds (the pattern cycles to fill it)
//   Overlap/Solo   — solo loops of a colour are priority-ordered (list order) and only
//                    one sounds per bar (higher priority wins a clash); overlap loops
//                    each get their own lane so they can sound simultaneously.
//
// `compile()` turns a Track into the engine's existing shape — a flat list of VoiceNode
// chains ("lanes"), each tagged with its colour and padded to the bar limit. Everything
// downstream (linesMessage, the engine, WAV export, the grid preview) keeps working on
// those lanes exactly as it did on the old 6 voice lines. See lines.ts / project.ts.

import {
  VoiceNode, IntroEnv, OutroEnv, emptyNode, clampEnvelopes,
  STEPS_PER_BAR, MAX_REPS, NUM_LINES, VOICE_COLORS,
} from "./lines";

/** How a loop repeats across the track. */
export type EveryRule =
  | { kind: "weight"; weight: number } // probability per forBars slot (0..1)
  | { kind: "nth"; n: number }         // every n-th bar (n, 2n, 3n …)
  | { kind: "pow2" }                   // at bars 1, 2, 4, 8, 16 …
  | { kind: "at"; bars: number[] };    // at explicit, 1-indexed bar numbers

/** A loop's placement: where it lands, how long each hit lasts, and how it stacks. The
    `seed` fixes a weighted roll (kept until re-rolled); `seedHistory` is the Back stack. */
export interface PlacementRule {
  every: EveryRule;
  forBars: number;               // sounding length of each placement, in bars (>= 1)
  mode: "overlap" | "solo";
  seed: number;                  // current RNG seed (weighted rule only, but always kept)
  seedHistory: number[];         // previous seeds, for the Back button (most recent last)
}

/** One loop: the sound/rhythm half of a VoiceNode plus its placement rule. `reps`/`wait`
    are gone — position and length now come from the rule, computed by compile(). */
export interface Loop {
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
  intro?: IntroEnv;
  outro?: OutroEnv;
  preset?: string;
  ranges?: { lo: number[]; hi: number[] };
  rule: PlacementRule;
}

/** One colour's loops, in solo-priority order (earlier = higher priority). */
export interface ColorTrack {
  loops: Loop[];
  mute?: boolean;
  solo?: boolean;
}

export const DEFAULT_BAR_LIMIT = 16;

/** The whole authoring model: a bar limit, six colours, and the key context (root/scale)
    the shuffle uses. Compiled into engine lanes by compile(). */
export class Track {
  colors: ColorTrack[] = emptyColors();
  barLimit = DEFAULT_BAR_LIMIT;
  root = 0;  // 0 = C
  scale = 0; // 0 = Major

  /** Compile to engine lanes (see compile()). */
  toLanes(): Lane[] {
    return compile(this.colors, this.barLimit);
  }
}

/** A fresh placement rule: every 4th bar, 1 bar long, solo. */
export function defaultRule(): PlacementRule {
  return { every: { kind: "nth", n: 4 }, forBars: 1, mode: "solo", seed: randomSeed(), seedHistory: [] };
}

/** A 32-bit seed for a weighted roll. */
export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

// A compiled lane: a node chain (as the old voice lines) plus the colour it belongs to.
export interface Lane {
  color: number;
  nodes: VoiceNode[];
}

// A placement on the timeline, in whole bars: [startBar, startBar + forBars).
interface Interval {
  startBar: number;
  forBars: number;
  loop: Loop;
}

// --- seeded RNG (xorshift32, ported from engine.js makeRng) → [0,1) ------------
function rng01(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Where a loop lands across [0, barLimit) bars, as a list of intervals. */
export function placementsFor(loop: Loop, barLimit: number): Interval[] {
  const out: Interval[] = [];
  const forBars = Math.max(1, Math.round(loop.rule.forBars));
  const push = (startBar: number) => {
    if (startBar >= 0 && startBar < barLimit) out.push({ startBar, forBars, loop });
  };
  const every = loop.rule.every;
  if (every.kind === "nth") {
    const n = Math.max(1, Math.round(every.n));
    for (let b = 0; b < barLimit; b += n) push(b);
  } else if (every.kind === "pow2") {
    // Bars 1, 2, 4, 8, 16 … (1-indexed for the musician; stored 0-indexed).
    for (let p = 1; p - 1 < barLimit; p *= 2) push(p - 1);
  } else if (every.kind === "at") {
    // Explicit 1-indexed bar numbers the user typed; stored 0-indexed here.
    for (const b of every.bars) push(Math.round(b) - 1);
  } else {
    // Weighted: walk the track in forBars slots, placing when the seeded roll passes.
    const w = Math.max(0, Math.min(1, every.weight));
    const rng = rng01(loop.rule.seed);
    for (let b = 0; b < barLimit; b += forBars) {
      if (rng() < w) push(b);
    }
  }
  return out;
}

// --- lane building -------------------------------------------------------------

/** A silent window of exactly `steps` 16th-steps (a rest node: no sound, empty pattern,
    length = its own step count). Any gap or trailing pad is one of these. */
function restOf(steps: number): VoiceNode {
  const n = emptyNode();
  n.steps = Math.max(1, Math.round(steps));
  n.hits = 0;
  n.reps = 1;
  return n;
}

/** A sounding node for a loop, its pattern repeated `reps` times. Exported so the UI can
    borrow a loop's sound/rhythm as a VoiceNode for the rings preview. */
export function loopToNode(loop: Loop, reps = 1): VoiceNode {
  const n = emptyNode();
  n.soundId = loop.soundId;
  n.snapshot = loop.snapshot.slice();
  n.color = loop.color;
  n.name = loop.name;
  n.pitch = [loop.pitch[0], loop.pitch[1]];
  n.hits = loop.hits;
  n.steps = loop.steps;
  n.rotation = loop.rotation;
  n.split = loop.split;
  n.gain = loop.gain;
  n.reps = Math.max(1, Math.min(MAX_REPS, reps));
  n.intro = loop.intro ? { ...loop.intro } : undefined;
  n.outro = loop.outro ? { ...loop.outro } : undefined;
  n.preset = loop.preset;
  n.ranges = loop.ranges ? { lo: loop.ranges.lo.slice(), hi: loop.ranges.hi.slice() } : undefined;
  clampEnvelopes(n);
  return n;
}

/** Turn a lane's non-overlapping, start-sorted intervals into a padded node chain that
    spans exactly `barLimit` bars: a rest for each gap, then a sound node per placement
    (its pattern cycling for `forBars`), with a short rest padding any partial final
    cycle so the next placement stays on the bar grid. */
function buildLane(intervals: Interval[], barLimit: number): VoiceNode[] {
  const nodes: VoiceNode[] = [];
  const limit = barLimit * STEPS_PER_BAR;
  let cursor = 0; // steps placed so far
  for (const iv of intervals) {
    const start = iv.startBar * STEPS_PER_BAR;
    if (start > cursor) { nodes.push(restOf(start - cursor)); cursor = start; }
    if (start < cursor) continue; // guard: overlapping input (shouldn't happen per lane)
    const unit = iv.loop.steps >= 1 ? iv.loop.steps : STEPS_PER_BAR;
    const lenSteps = iv.forBars * STEPS_PER_BAR;
    const reps = Math.max(1, Math.floor(lenSteps / unit));
    nodes.push(loopToNode(iv.loop, reps));
    const consumed = reps * unit;
    cursor += consumed;
    const intendedEnd = start + Math.max(lenSteps, consumed); // extend if one cycle overran
    if (cursor < intendedEnd) { nodes.push(restOf(intendedEnd - cursor)); cursor = intendedEnd; }
  }
  if (cursor < limit) nodes.push(restOf(limit - cursor));
  return nodes.length ? nodes : [restOf(limit)];
}

/** Pack non-overlapping? no — greedily colour overlapping intervals into as few lanes as
    possible: each interval goes on the first lane whose last end is <= its start. */
function packOverlap(intervals: Interval[]): Interval[][] {
  const sorted = intervals.slice().sort((a, b) => a.startBar - b.startBar);
  const lanes: Interval[][] = [];
  const ends: number[] = [];
  for (const iv of sorted) {
    let placed = false;
    for (let l = 0; l < lanes.length; l++) {
      if (ends[l] <= iv.startBar) { lanes[l].push(iv); ends[l] = iv.startBar + iv.forBars; placed = true; break; }
    }
    if (!placed) { lanes.push([iv]); ends.push(iv.startBar + iv.forBars); }
  }
  return lanes;
}

/** Resolve solo loops of a colour to a SINGLE lane: paint a bar-resolution timeline where
    the highest-priority (earliest in the list) loop covering a bar wins, then coalesce
    equal-loop runs into intervals. */
function soloLane(soloLoops: Loop[], barLimit: number): Interval[] {
  const owner: (Loop | null)[] = new Array(barLimit).fill(null);
  const prio = new Map<Loop, number>();
  soloLoops.forEach((lp, i) => prio.set(lp, i));
  for (const lp of soloLoops) {
    for (const iv of placementsFor(lp, barLimit)) {
      const end = Math.min(barLimit, iv.startBar + iv.forBars);
      for (let b = iv.startBar; b < end; b++) {
        const cur = owner[b];
        if (cur === null || (prio.get(lp)! < prio.get(cur)!)) owner[b] = lp;
      }
    }
  }
  const out: Interval[] = [];
  let b = 0;
  while (b < barLimit) {
    const lp = owner[b];
    if (!lp) { b++; continue; }
    let e = b + 1;
    while (e < barLimit && owner[e] === lp) e++;
    out.push({ startBar: b, forBars: e - b, loop: lp });
    b = e;
  }
  return out;
}

/** Compile a whole track into engine lanes: per colour, one solo lane (priority-resolved)
    plus one lane per simultaneous overlap. Lanes carry their colour; each spans barLimit. */
export function compile(colors: ColorTrack[], barLimit: number): Lane[] {
  const limit = Math.max(1, Math.round(barLimit));
  const lanes: Lane[] = [];
  for (let c = 0; c < colors.length; c++) {
    const loops = colors[c]?.loops ?? [];
    if (loops.length === 0) continue;
    const solo = loops.filter((l) => l.rule.mode === "solo");
    const overlap = loops.filter((l) => l.rule.mode === "overlap");

    const soloIvs = soloLane(solo, limit);
    if (soloIvs.length) lanes.push({ color: c, nodes: buildLane(soloIvs, limit) });

    const overlapIvs: Interval[] = [];
    for (const lp of overlap) overlapIvs.push(...placementsFor(lp, limit));
    for (const laneIvs of packOverlap(overlapIvs)) {
      lanes.push({ color: c, nodes: buildLane(laneIvs, limit) });
    }
  }
  return lanes;
}

/** A blank track: `NUM_LINES` empty colours and a default bar limit. */
export function emptyColors(): ColorTrack[] {
  return Array.from({ length: NUM_LINES }, () => ({ loops: [] as Loop[] }));
}

/** A fresh loop for colour `c` with a blank sound and a default rule. */
export function emptyLoop(colorIndex: number, soundId: number): Loop {
  return {
    soundId,
    snapshot: [],
    color: VOICE_COLORS[colorIndex % VOICE_COLORS.length],
    name: "",
    pitch: [60, 1000],
    hits: 0,
    steps: 0,
    rotation: 0,
    rule: defaultRule(),
  };
}
