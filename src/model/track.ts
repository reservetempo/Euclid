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
//   Priority       — a colour's loops are priority-ordered (list order) and only ONE
//                    sounds per bar: the earliest loop covering a bar wins the clash.
//                    There is no simultaneous stacking within a colour, so a colour
//                    compiles to EXACTLY ONE lane (see compile / resolveLane).
//
// `compile()` turns a Track into the engine's existing shape — a flat list of VoiceNode
// chains ("lanes"), each tagged with its colour and padded to the bar limit. Everything
// downstream (linesMessage, the engine, WAV export, the grid preview) keeps working on
// those lanes exactly as it did on the old 6 voice lines. See lines.ts / project.ts.

import {
  VoiceNode, IntroEnv, OutroEnv, LifePlacement, SweepWindow, TransitionMode, BlendShapeId,
  GraphTransform,
  emptyNode, clampEnvelopes, STEPS_PER_BAR, MAX_REPS, NUM_LINES, VOICE_COLORS,
} from "./lines";
import { ParamId } from "./params";
import { reverseSnapshot } from "./reverse";
import { SoundDraft } from "./sound";
import { rng01, randomSeed } from "./rng";

export { randomSeed }; // re-export: a rule's seed is minted here and in the UI

/** How a loop repeats across the track. */
export type EveryRule =
  | { kind: "weight"; weight: number } // probability per forBars slot (0..1)
  | { kind: "dice"; weight: number }   // pool weight 1..6 (a dice face). ALL a colour's
                                        // dice loops share the bars: the track is filled
                                        // bar-by-bar, each slot drawn from the pool with
                                        // odds ∝ weight (no overlap). See dicePoolLane.
  | { kind: "nth"; n: number; start?: number } // every n-th bar (start, start+n, …);
                                        // `start` is a 1-indexed bar to shift the whole
                                        // series later (default/absent = bar 1)
  | { kind: "pow2" }                   // at bars 1, 2, 4, 8, 16 …
  | { kind: "at"; bars: number[] }     // at explicit, 1-indexed bar numbers
  | { kind: "fill" };                  // "fill the blanks" — every bar the colour's OTHER
                                       // loops leave empty (masked in compile)

/** A loop's placement: where it lands and how long each hit lasts. The
    `seed` fixes a weighted roll (kept until re-rolled); `seedHistory` is the Back stack. */
export interface PlacementRule {
  every: EveryRule;
  forBars: number;               // sounding length of each placement, in bars (>= 1). When
                                 // `lengths` is set, this mirrors lengths[0] (kept in sync
                                 // for old readers / the fade budget).
  lengths?: number[];            // optional CYCLE of placement lengths (bars): successive
                                 // placements use lengths[0], lengths[1], … then repeat. A
                                 // single value (or absent) = the classic fixed forBars.
  retrigger?: boolean;           // repeat the intro/outro fade on EVERY placement instead
                                 // of once across a merged run (see buildLane).
  seed: number;                  // current RNG seed (weighted rule only, but always kept)
  seedHistory: number[];         // previous seeds, for the Back button (most recent last)
}

/** The cycle of placement lengths in bars (all ≥ 1): `lengths` when it holds ≥ 1 entry,
    else the single `forBars`. Successive placements step through it (see placementsFor). */
export function ruleLengths(rule: PlacementRule): number[] {
  const ls = (rule.lengths ?? []).map((n) => Math.max(1, Math.round(n))).filter((n) => n >= 1);
  return ls.length ? ls : [Math.max(1, Math.round(rule.forBars))];
}

/** An overarching FX sweep across a whole coloured ROW, from bar `fromBar` to `toBar`
    (1-indexed, inclusive): every loop on the row has the chosen style(s) swept across that
    window — the filter opens, reverb wells up, drive bites, etc. `modes` is the active
    style SET (multi-select, composed together in the engine; `mode` mirrors its first
    entry). `side` "out" runs the sound → the effect extreme; "in" runs the effect → the
    clean sound. `from`/`to` override the swept param's near/far values; `curve`/`dir`
    bend the ramp (see engine bendT). A row holds a LIST of these (ColorTrack.sweeps) —
    overlapping windows stack, each morphing the result of the previous. */
export interface RowSweep {
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
  shape?: BlendShapeId; // blend function over the window (unset = "ramp")
  cycles?: number;      // wave/stair count for the periodic shapes
  rate?: number;        // "speed" style: the far end's hit-rate multiple of the tempo
}

/** A fresh row sweep: a filter opening across the first 8 bars (clamped to the track),
    on from the start — it's explicitly added from the Transition tab. */
export function defaultRowSweep(barLimit = 8): RowSweep {
  const toBar = Math.max(1, Math.min(8, Math.round(barLimit)));
  return { on: true, fromBar: 1, toBar, mode: "filter", side: "out", curve: 0, dir: "out" };
}

/** Convert a RowSweep (1-indexed bars, inclusive) into an engine SweepWindow (step range),
    clamped to the track. Returns null when the range is empty or the sweep is off. */
export function rowSweepWindow(sweep: RowSweep | undefined, barLimit: number): SweepWindow | null {
  if (!sweep || !sweep.on) return null;
  const limit = Math.max(1, Math.round(barLimit));
  const fromBar = Math.max(1, Math.min(limit, Math.round(sweep.fromBar)));
  const toBar = Math.max(fromBar, Math.min(limit, Math.round(sweep.toBar)));
  const from = (fromBar - 1) * STEPS_PER_BAR;
  const to = toBar * STEPS_PER_BAR;
  if (to <= from) return null;
  return { from, to, mode: sweep.mode, modes: sweep.modes, side: sweep.side, fromV: sweep.from, toV: sweep.to, curve: sweep.curve, dir: sweep.dir, shape: sweep.shape, cycles: sweep.cycles, rate: sweep.rate };
}

/** All of a row's live sweeps as engine windows (off / empty ones dropped). */
export function rowSweepWindows(sweeps: RowSweep[] | undefined, barLimit: number): SweepWindow[] {
  const out: SweepWindow[] = [];
  for (const s of sweeps ?? []) {
    const w = rowSweepWindow(s, barLimit);
    if (w) out.push(w);
  }
  return out;
}

/** A per-LOOP transition: the sound transforming into ANOTHER sound across a set of bars.
    `snapshot` is the TRANSFORMED sound's full param set (the Effects tab — every value
    edited there is the transition's END value; the starting sound is the loop's own).
    `bars` picks WHERE it runs (1-indexed; contiguous runs each become one window; the
    default is the loop's whole placement). The blend follows the Graph tab's function:
    the shape (shape/curve/dir/cycles, see BlendShapeId) plus the graph-calculator
    transform (slope/shift/min/max — identity by default). `speedOn` stacks the timing
    warp: hits rush toward `rate`× across each window while the tone morphs. `reverseOn`
    mirrors the TARGET in time (see model/reverse.ts) — the transition then arrives at the
    sound back to front, and because the mirror is derived at compile time rather than
    written into `snapshot`, turning it off is lossless and it composes with hand edits. */
export interface LoopTransition extends GraphTransform {
  on: boolean;
  bars: number[];
  snapshot: number[];
  /** The live editing state over `snapshot` — same deal as Loop.draft. */
  draft?: SoundDraft;
  shape?: BlendShapeId;
  curve?: number;
  dir?: "in" | "out";
  cycles?: number;
  points?: number[]; // "drawn" shape: the freehand blend function, uniformly sampled y∈[0,1]
  speedOn?: boolean;
  rate?: number; // far-end hit-rate multiple of the tempo (speed only)
  reverseOn?: boolean; // arrive at the time-mirror of `snapshot` (reverseSnapshot)
}

/** A fresh transition for `loop`: on, covering the loop's full placement (else the whole
    track), transforming into an exact copy of the current sound (edit the Effects tab to
    bend the end values away from it). */
export function defaultLoopTransition(loop: Loop, barLimit: number): LoopTransition {
  const limit = Math.max(1, Math.round(barLimit));
  const bars = new Set<number>();
  for (const iv of placementsFor(loop, limit)) {
    for (let b = iv.startBar; b < Math.min(limit, iv.startBar + iv.forBars); b++) bars.add(b + 1);
  }
  const list = bars.size ? [...bars].sort((a, b) => a - b)
    : Array.from({ length: limit }, (_, i) => i + 1);
  return { on: true, bars: list, snapshot: loop.snapshot.slice() };
}

/** Compile one loop's transitions into engine sweep windows: each contiguous run of
    selected bars becomes a "morph" window lerping the lane's hits toward the transition's
    target snapshot (side "out": sound → transformed as the window progresses), following
    the transition's blend graph. With `speedOn` the "speed" style stacks on top (the
    window's hits are re-timed toward `rate`× — see warpSweepOnsets). The shipped
    morphSnap's Volume slot is converted to a RATIO of the loop's own volume so mute /
    solo / loudness-makeup scaling (applied to the sound table, not the lanes) still
    lands — see sweptSnap in engine.js. */
export function loopTransitionWindows(loop: Loop, barLimit: number): SweepWindow[] {
  const out: SweepWindow[] = [];
  const limit = Math.max(1, Math.round(barLimit));
  for (const tr of loop.transitions ?? []) {
    if (!tr.on || !tr.snapshot.length) continue;
    const bars = [...new Set(tr.bars.map((b) => Math.round(b)).filter((b) => b >= 1 && b <= limit))]
      .sort((a, b) => a - b);
    if (!bars.length) continue;
    // With Reverse on the window lands on the MIRROR of the edited target, derived here
    // rather than stored — so the two stack (reverse a darkened sound) and toggling it off
    // gives the hand-edited target back untouched.
    const morphSnap = tr.reverseOn ? reverseSnapshot(tr.snapshot) : tr.snapshot.slice();
    const ownVol = loop.snapshot[ParamId.Volume] ?? 0.85;
    morphSnap[ParamId.Volume] = (morphSnap[ParamId.Volume] ?? 0.85) / Math.max(0.05, ownVol);
    let i = 0;
    while (i < bars.length) {
      let j = i;
      while (j + 1 < bars.length && bars[j + 1] === bars[j] + 1) j++;
      out.push({
        from: (bars[i] - 1) * STEPS_PER_BAR,
        to: bars[j] * STEPS_PER_BAR,
        mode: "morph",
        modes: tr.speedOn ? ["morph", "speed"] : undefined,
        side: "out",
        morphSnap,
        shape: tr.shape, curve: tr.curve, dir: tr.dir, cycles: tr.cycles, points: tr.points,
        yGain: tr.yGain, yBias: tr.yBias, yMin: tr.yMin, yMax: tr.yMax,
        rate: tr.speedOn ? (tr.rate ?? 2) : undefined,
      });
      i = j + 1;
    }
  }
  return out;
}

/** One loop: the sound/rhythm half of a VoiceNode plus its placement rule. `reps`/`wait`
    are gone — position and length now come from the rule, computed by compile(). */
export interface Loop {
  soundId: number;
  snapshot: number[];
  /** The live editing state over `snapshot`, made on first edit and kept for the life of
      the loop (its undo stack and shuffle settings). NOT data: it is deliberately absent
      from cloneLoop and from the save format — see model/sound.ts. */
  draft?: SoundDraft;
  color: string;
  name: string;            // auto sound-description ("Tri · 590 · Punchy …"), updated on edit
  label?: string;          // a coined display name for this voice (see model/name.ts), stable
  hits: number;
  steps: number;
  rotation: number;
  split?: number;
  // Hand-edited pattern override (the Loop tab's sequencer grid); cleared whenever the
  // rhythm circles are edited. See VoiceNode.patternOv.
  patternOv?: number[];
  gain?: number;
  intro?: IntroEnv;
  outro?: OutroEnv;
  // Per-loop transitions (sound → transformed sound across bar windows); compiled into
  // "morph" sweep windows on the colour's lanes — see loopTransitionWindows.
  transitions?: LoopTransition[];
  accent?: LifePlacement; // per-loop deterministic accent placement (overrides sound's own)
  ghost?: LifePlacement;  // per-loop deterministic ghost placement (overrides sound's own)
  // Timing push: this loop's hits off the 16th grid, as a signed fraction of one step
  // (negative = ahead of the beat). Scrubbed on the rhythm row; see VoiceNode.push.
  push?: number;
  rule: PlacementRule;
}

/** One colour's loops, in solo-priority order (earlier = higher priority). */
export interface ColorTrack {
  loops: Loop[];
  mute?: boolean;
  solo?: boolean;
  sweeps?: RowSweep[]; // overarching FX sweeps across bar ranges of the whole row (may overlap)
}

// 256 bars = the track overview's 16 blocks per colour at exactly 16 bars each (see app.ts).
export const DEFAULT_BAR_LIMIT = 256;

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

/** A fresh placement rule: EVERY bar, the length of the track — a new loop covers the
    whole timeline until it's placed otherwise (siblings resolve by list priority). */
export function defaultRule(): PlacementRule {
  return { every: { kind: "nth", n: 1 }, forBars: 1, seed: randomSeed(), seedHistory: [] };
}

// A compiled lane: a node chain (as the old voice lines) plus the colour it belongs to,
// and any row-wide FX sweeps (bar-range windows) that ride over its steady hits.
export interface Lane {
  color: number;
  nodes: VoiceNode[];
  sweeps?: SweepWindow[];
}

// A placement on the timeline, in whole bars: [startBar, startBar + forBars).
interface Interval {
  startBar: number;
  forBars: number;
  loop: Loop;
}

/** Where a loop lands across [0, barLimit) bars, as a list of intervals. Each placement's
    length steps through the rule's length CYCLE (ruleLengths) in placement order, so a
    "2, 4" loop lays 2 bars, then 4, then 2 … The cadence (which bar a placement STARTS on)
    still comes from the `every` kind; only the length varies. */
export function placementsFor(loop: Loop, barLimit: number): Interval[] {
  const out: Interval[] = [];
  const lengths = ruleLengths(loop.rule);
  const lenAt = (i: number) => lengths[i % lengths.length];
  // A placement never sounds past the track end (the bar limit IS the loop length), so its
  // length clamps to what's left — matching dicePoolLane. Keeps a long final length from
  // stretching the loop beyond its bar limit.
  const push = (startBar: number, forBars: number) => {
    if (startBar >= 0 && startBar < barLimit) out.push({ startBar, forBars: Math.min(forBars, barLimit - startBar), loop });
  };
  const every = loop.rule.every;
  if (every.kind === "nth") {
    const n = Math.max(1, Math.round(every.n));
    const start0 = Math.max(0, Math.round((every.start ?? 1) - 1)); // 1-indexed bar → 0-indexed
    let i = 0;
    for (let b = start0; b < barLimit; b += n) push(b, lenAt(i++));
  } else if (every.kind === "pow2") {
    // Bars 1, 2, 4, 8, 16 … (1-indexed for the musician; stored 0-indexed).
    let i = 0;
    for (let p = 1; p - 1 < barLimit; p *= 2) push(p - 1, lenAt(i++));
  } else if (every.kind === "at") {
    // Explicit 1-indexed bar numbers the user typed; stored 0-indexed here.
    every.bars.forEach((b, i) => push(Math.round(b) - 1, lenAt(i)));
  } else if (every.kind === "fill" || every.kind === "dice") {
    // Every bar (tiled by the length cycle) — the raw, unmasked placement. compile() clips a
    // "fill" loop to the colour's blank bars (placementsMasked); a stray "dice" loop (its pool
    // resolved by dicePoolLane) tiles as a fallback.
    let i = 0;
    for (let b = 0; b < barLimit; ) { const len = lenAt(i++); push(b, len); b += len; }
  } else {
    // Weighted: walk the track in length-cycle slots, placing when the seeded roll passes.
    const w = Math.max(0, Math.min(1, every.weight));
    const rng = rng01(loop.rule.seed);
    let i = 0;
    for (let b = 0; b < barLimit; ) { const len = lenAt(i++); if (rng() < w) push(b, len); b += len; }
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
  n.hits = loop.hits;
  n.steps = loop.steps;
  n.rotation = loop.rotation;
  n.split = loop.split;
  n.patternOv = loop.patternOv ? loop.patternOv.slice() : undefined;
  n.gain = loop.gain;
  n.reps = Math.max(1, Math.min(MAX_REPS, reps));
  n.intro = loop.intro ? { ...loop.intro, modes: loop.intro.modes?.slice() } : undefined;
  n.outro = loop.outro ? { ...loop.outro, modes: loop.outro.modes?.slice() } : undefined;
  n.accent = loop.accent ? { ...loop.accent } : undefined;
  n.ghost = loop.ghost ? { ...loop.ghost } : undefined;
  n.push = loop.push;
  clampEnvelopes(n);
  return n;
}

/** Split a run of `totalBars` into chunks of at most `stepBars` (the last chunk takes the
    remainder). Used by the retrigger option so a merged placement re-fades every stepBars. */
function chunkBars(totalBars: number, stepBars: number): number[] {
  const step = Math.max(1, Math.round(stepBars));
  const out: number[] = [];
  let remaining = Math.max(1, Math.round(totalBars));
  while (remaining > 0) { const c = Math.min(step, remaining); out.push(c); remaining -= c; }
  return out;
}

/** Turn a lane's non-overlapping, start-sorted intervals into a padded node chain that
    spans exactly `barLimit` bars: a rest for each gap, then a sound node per placement
    (its pattern cycling for `forBars`), with a short rest padding any partial final
    cycle so the next placement stays on the bar grid. A `retrigger` loop splits each
    placement into `forBars`-length chunks, each its OWN node carrying the loop's
    intro/outro — so the fade repeats on every chunk instead of once across a merged run. */
function buildLane(intervals: Interval[], barLimit: number): VoiceNode[] {
  const nodes: VoiceNode[] = [];
  const limit = barLimit * STEPS_PER_BAR;
  let cursor = 0; // steps placed so far
  for (const iv of intervals) {
    const start = iv.startBar * STEPS_PER_BAR;
    if (start > cursor) { nodes.push(restOf(start - cursor)); cursor = start; }
    if (start < cursor) continue; // guard: overlapping input (shouldn't happen per lane)
    const unit = iv.loop.steps >= 1 ? iv.loop.steps : STEPS_PER_BAR;
    // One chunk (the whole placement), or forBars-length chunks when the loop retriggers
    // its fade on each placement (see the doc above).
    const chunks = iv.loop.rule.retrigger
      ? chunkBars(iv.forBars, ruleLengths(iv.loop.rule)[0])
      : [iv.forBars];
    for (const cb of chunks) {
      const chunkStart = cursor;
      const lenSteps = cb * STEPS_PER_BAR;
      const totalReps = Math.max(1, Math.floor(lenSteps / unit));
      // A single node holds at most MAX_REPS pattern-repeats. A short pattern (few steps)
      // spread over many bars needs SEVERAL nodes back-to-back to cover the whole run —
      // otherwise everything past MAX_REPS×steps falls silent (e.g. a 7-step fill loop over
      // 32 bars stops sounding at bar 28: 64×7 = 448 steps). Split into MAX_REPS-sized
      // nodes, keeping the intro on the first and the outro on the last so the fades don't
      // repeat at the seams.
      const repChunks: number[] = [];
      for (let left = totalReps; left > 0; left -= MAX_REPS) repChunks.push(Math.min(MAX_REPS, left));
      repChunks.forEach((reps, k) => {
        const node = loopToNode(iv.loop, reps);
        if (k > 0) node.intro = undefined;
        if (k < repChunks.length - 1) node.outro = undefined;
        nodes.push(node);
        cursor += reps * unit;
      });
      const consumed = totalReps * unit;
      const intendedEnd = chunkStart + Math.max(lenSteps, consumed); // extend if a cycle overran
      if (cursor < intendedEnd) { nodes.push(restOf(intendedEnd - cursor)); cursor = intendedEnd; }
    }
  }
  if (cursor < limit) nodes.push(restOf(limit - cursor));
  return nodes.length ? nodes : [restOf(limit)];
}

/** Resolve ALL of a colour's loops to a SINGLE lane. There is no simultaneous stacking
    within a colour: every bar has at most one owner, and the highest-priority (earliest in
    the list) loop covering it wins.

    Two passes, because "fill" means "whatever the others left blank":
      1. Every NON-fill loop paints its placements — ordinary loops from placementsFor,
         the colour's dice loops from the shared dicePoolLane (one bar-filling sequence
         whose intervals each carry the loop that was drawn). Dice loops used to sound on
         their own lane ALONGSIDE the rest; they now compete for the same bars by priority.
      2. Fill loops paint only the bars still unowned, again earliest-wins among themselves.
    Then equal-loop runs coalesce into intervals for buildLane. */
function resolveLane(loops: Loop[], barLimit: number): Interval[] {
  const owner: (Loop | null)[] = new Array(barLimit).fill(null);
  const prio = new Map<Loop, number>();
  loops.forEach((lp, i) => prio.set(lp, i));
  const paint = (lp: Loop, ivs: Interval[]) => {
    for (const iv of ivs) {
      const end = Math.min(barLimit, iv.startBar + iv.forBars);
      for (let b = Math.max(0, iv.startBar); b < end; b++) {
        const cur = owner[b];
        if (cur === null || prio.get(lp)! < prio.get(cur)!) owner[b] = lp;
      }
    }
  };

  // Pass 1 — everything that isn't a fill loop.
  for (const lp of loops) {
    if (lp.rule.every.kind === "fill" || lp.rule.every.kind === "dice") continue;
    paint(lp, placementsFor(lp, barLimit));
  }
  for (const iv of dicePoolLane(loops.filter((l) => l.rule.every.kind === "dice"), barLimit)) {
    paint(iv.loop, [iv]);
  }

  // Pass 2 — fill loops take the blanks left by pass 1. They are excluded from each
  // other's mask (blocked is frozen here) so they never block one another into silence.
  const blocked = owner.map((o) => o !== null);
  for (const lp of loops) {
    if (lp.rule.every.kind !== "fill") continue;
    paint(lp, placementsMasked(lp, barLimit, blocked));
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

/** Resolve a colour's DICE loops to a SINGLE non-overlapping lane that fills every bar:
    walk the track bar-by-bar and at each cursor draw one loop from the pool with odds
    proportional to its dice face (1..6), placing it for its own forBars. Seeded by the
    XOR of every pool member's seed, so re-rolling ANY dice loop reshuffles the whole pool
    (and its Back restores it). Returns [] when the pool is empty. */
function dicePoolLane(diceLoops: Loop[], barLimit: number): Interval[] {
  if (diceLoops.length === 0) return [];
  const weights = diceLoops.map((l) =>
    Math.max(1, Math.min(6, Math.round((l.rule.every as { weight: number }).weight))));
  const total = weights.reduce((a, b) => a + b, 0);
  let seed = 0;
  for (const l of diceLoops) seed = (seed ^ (l.rule.seed >>> 0)) >>> 0;
  const rng = rng01(seed);
  const out: Interval[] = [];
  let bar = 0;
  while (bar < barLimit) {
    let roll = rng() * total, idx = 0;
    for (; idx < weights.length - 1; idx++) { roll -= weights[idx]; if (roll < 0) break; }
    const loop = diceLoops[idx];
    const forBars = Math.max(1, Math.round(loop.rule.forBars));
    const place = Math.min(forBars, barLimit - bar);
    out.push({ startBar: bar, forBars: place, loop });
    bar += place;
  }
  return out;
}

/** A loop's placements, but with "fill" loops clipped to the blank bars (`!blocked[b]`): each
    maximal blank run becomes one placement (its pattern cycles to fill it, as before). Non-fill
    loops — and fill loops with no `blocked` mask — are unchanged (plain placementsFor). */
function placementsMasked(loop: Loop, barLimit: number, blocked?: boolean[]): Interval[] {
  if (loop.rule.every.kind !== "fill" || !blocked) return placementsFor(loop, barLimit);
  const out: Interval[] = [];
  let b = 0;
  while (b < barLimit) {
    if (blocked[b]) { b++; continue; }
    let e = b + 1;
    while (e < barLimit && !blocked[e]) e++;
    out.push({ startBar: b, forBars: e - b, loop });
    b = e;
  }
  return out;
}

/** Compile a whole track into engine lanes: EXACTLY ONE lane per non-empty colour, its
    bars priority-resolved by resolveLane. Lanes carry their colour and span barLimit. */
export function compile(colors: ColorTrack[], barLimit: number): Lane[] {
  const limit = Math.max(1, Math.round(barLimit));
  const lanes: Lane[] = [];
  for (let c = 0; c < colors.length; c++) {
    const loops = colors[c]?.loops ?? [];
    if (loops.length === 0) continue;
    // The whole row's FX sweeps ride over the colour's lane, and every loop's own
    // transitions ("morph" windows toward a transformed sound) ride with them. Windows may
    // overlap — the engine composes them (each morphs the result of the previous).
    const wins = rowSweepWindows(colors[c]?.sweeps, limit);
    for (const lp of loops) wins.push(...loopTransitionWindows(lp, limit));
    const sweeps = wins.length ? wins : undefined;

    const ivs = resolveLane(loops, limit);
    if (ivs.length) lanes.push({ color: c, nodes: buildLane(ivs, limit), sweeps });
  }
  return lanes;
}

/** A blank track: `NUM_LINES` empty colours and a default bar limit. */
export function emptyColors(): ColorTrack[] {
  return Array.from({ length: NUM_LINES }, () => ({ loops: [] as Loop[] }));
}

/** A deep, independent copy of a loop — its own arrays and rule (so editing the copy or
    the original never touches the other). Keeps the SAME `soundId`; a caller that wants
    the copy to carry its own engine sound must re-mint the id after cloning. */
export function cloneLoop(loop: Loop): Loop {
  const e = loop.rule.every;
  const every: EveryRule = e.kind === "at" ? { kind: "at", bars: e.bars.slice() } : { ...e };
  return {
    soundId: loop.soundId,
    snapshot: loop.snapshot.slice(),
    color: loop.color,
    name: loop.name,
    label: loop.label,
    hits: loop.hits,
    steps: loop.steps,
    rotation: loop.rotation,
    split: loop.split,
    patternOv: loop.patternOv ? loop.patternOv.slice() : undefined,
    gain: loop.gain,
    intro: loop.intro ? { ...loop.intro, modes: loop.intro.modes?.slice() } : undefined,
    outro: loop.outro ? { ...loop.outro, modes: loop.outro.modes?.slice() } : undefined,
    // Transitions are listed FIELD BY FIELD rather than spread: a transition carries a
    // live `draft` (see LoopTransition), and a spread would hand the copy a draft still
    // writing through to the ORIGINAL's snapshot — editing the copy would edit both.
    // Listing the fields keeps the clone pure data, and excludes anything live added
    // later by default (project.ts's own row builders do the same for the save file).
    transitions: loop.transitions
      ? loop.transitions.map((t) => ({
          on: t.on,
          bars: t.bars.slice(),
          snapshot: t.snapshot.slice(),
          shape: t.shape,
          curve: t.curve,
          dir: t.dir,
          cycles: t.cycles,
          points: t.points ? t.points.slice() : undefined,
          speedOn: t.speedOn,
          rate: t.rate,
          reverseOn: t.reverseOn,
          yGain: t.yGain,
          yBias: t.yBias,
          yMin: t.yMin,
          yMax: t.yMax,
        }))
      : undefined,
    accent: loop.accent ? { ...loop.accent } : undefined,
    ghost: loop.ghost ? { ...loop.ghost } : undefined,
    push: loop.push,
    rule: {
      every,
      forBars: loop.rule.forBars,
      lengths: loop.rule.lengths ? loop.rule.lengths.slice() : undefined,
      retrigger: loop.rule.retrigger,
      seed: loop.rule.seed,
      seedHistory: loop.rule.seedHistory.slice(),
    },
  };
}

/** A fresh loop for colour `c` with a blank sound and a default rule. */
export function emptyLoop(colorIndex: number, soundId: number): Loop {
  return {
    soundId,
    snapshot: [],
    color: VOICE_COLORS[colorIndex % VOICE_COLORS.length],
    name: "",
    hits: 0,
    steps: 0,
    rotation: 0,
    rule: defaultRule(),
  };
}
