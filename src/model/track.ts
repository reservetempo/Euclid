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
  VoiceNode, IntroEnv, OutroEnv, LifePlacement, SweepWindow, TransitionMode, BlendShapeId,
  GraphTransform,
  emptyNode, clampEnvelopes, STEPS_PER_BAR, MAX_REPS, NUM_LINES, VOICE_COLORS,
} from "./lines";
import { ParamId } from "./params";
import { MelodyNode, emptyMelody, melodyNoteNode, generateMelody, regatePhrase, EmittedNote, MELODY_COLOR_INDEX } from "./melody";
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
                                       // loops leave empty (any mode; masked in compile)

/** A loop's placement: where it lands, how long each hit lasts, and how it stacks. The
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
  mode: "overlap" | "solo";
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
    warp: hits rush toward `rate`× across each window while the tone morphs. */
export interface LoopTransition extends GraphTransform {
  on: boolean;
  bars: number[];
  snapshot: number[];
  shape?: BlendShapeId;
  curve?: number;
  dir?: "in" | "out";
  cycles?: number;
  points?: number[]; // "drawn" shape: the freehand blend function, uniformly sampled y∈[0,1]
  speedOn?: boolean;
  rate?: number; // far-end hit-rate multiple of the tempo (speed only)
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
    const morphSnap = tr.snapshot.slice();
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
  color: string;
  name: string;            // auto sound-description ("Tri · 590 · Punchy …"), updated on edit
  label?: string;          // a coined display name for this voice (see model/name.ts), stable
  pitch: [number, number];
  hits: number;
  steps: number;
  rotation: number;
  split?: number;
  // Hand-edited pattern override (the Loop tab's sequencer grid); cleared whenever the
  // rhythm circles are edited. See VoiceNode.patternOv.
  patternOv?: number[];
  rhythm?: boolean;        // melody instrument only: re-time the phrase's notes onto the
                           // Euclid pattern above (see regatePhrase); unset = the notes'
                           // own lengths/rests. Voice loops ignore it (their pattern
                           // always sounds).
  gain?: number;
  intro?: IntroEnv;
  outro?: OutroEnv;
  // Per-loop transitions (sound → transformed sound across bar windows); compiled into
  // "morph" sweep windows on the colour's lanes — see loopTransitionWindows.
  transitions?: LoopTransition[];
  accent?: LifePlacement; // per-loop deterministic accent placement (overrides sound's own)
  ghost?: LifePlacement;  // per-loop deterministic ghost placement (overrides sound's own)
  preset?: string;
  ranges?: { lo: number[]; hi: number[] };
  rule: PlacementRule;
}

/** One colour's loops, in solo-priority order (earlier = higher priority). */
export interface ColorTrack {
  loops: Loop[];
  mute?: boolean;
  solo?: boolean;
  sweeps?: RowSweep[]; // overarching FX sweeps across bar ranges of the whole row (may overlap)
}

export const DEFAULT_BAR_LIMIT = 16;

/** The whole authoring model: a bar limit, six colours, and the key context (root/scale)
    the shuffle uses. Compiled into engine lanes by compile(). */
export class Track {
  colors: ColorTrack[] = emptyColors();
  barLimit = DEFAULT_BAR_LIMIT;
  root = 0;  // 0 = C
  scale = 0; // 0 = Major
  // The last coloured row is a LIST of melodies (each a placeable phrase with its own
  // re-pitched instrument + placement rule), mirroring a voice colour's list of loops. A
  // fresh track starts empty — the melody section opens on an "add a melody" menu.
  melodies: MelodyItem[] = [];

  /** Compile to engine lanes (see compile()). Each melody adds its own lane(s) on the last
      colour: its generated phrase, placed across the track by its instrument's rule. The
      melody COLOUR's row sweeps ride over every melody lane (on top of per-placement
      fades — overlaps compose in the engine). */
  toLanes(): Lane[] {
    const lanes = compile(this.colors, this.barLimit);
    const rowWins = rowSweepWindows(this.colors[MELODY_COLOR_INDEX]?.sweeps, this.barLimit);
    lanes.push(...melodyLanes(this.melodies, this.barLimit, rowWins));
    return lanes;
  }
}

/** One melody in the list: a re-pitched instrument (its `rule` places it + sets its length
    in bars via forBars; it also carries the sound + fades) and the generative note tree. */
export interface MelodyItem {
  inst: Loop;
  node: MelodyNode;
}

/** A melody's default placement: an 8-bar phrase tiled to fill the track (like a loop set
    to "fill"). forBars is the phrase LENGTH; the rule is edited on the Loop-options page. */
export function melodyRule(): PlacementRule {
  return { every: { kind: "fill" }, forBars: 8, mode: "solo", seed: randomSeed(), seedHistory: [] };
}

/** A fresh melody item: an empty re-pitched instrument (sound minted on first edit) with a
    melody placement rule, and an empty note tree. */
export function newMelodyItem(): MelodyItem {
  const inst = emptyLoop(MELODY_COLOR_INDEX, -1);
  inst.rule = melodyRule();
  return { inst, node: emptyMelody() };
}

/** Lay each melody into its own engine lane: generate the item's phrase (its own seeded
    recurring motif, `forBars` long), then drop a copy at every placement its instrument's
    rule produces (gaps + the tail padded with rests), tuned to the item's own sound.
    `rowSweeps` (the melody colour's row-wide FX windows) ride over every lane. */
export function melodyLanes(melodies: MelodyItem[], barLimit: number, rowSweeps: SweepWindow[] = []): Lane[] {
  const limit = Math.max(1, Math.round(barLimit));
  const limitSteps = limit * STEPS_PER_BAR;
  const lanes: Lane[] = [];
  for (const item of melodies) {
    const inst = item.inst;
    if (inst.soundId < 0 || !inst.snapshot.length || item.node.notes.length === 0) continue;
    const phraseBars = Math.max(1, Math.round(inst.rule.forBars));
    // The generated phrase, optionally re-timed onto the instrument's Euclid rhythm
    // (its hits/steps circles) — see regatePhrase.
    const phrase = regatePhrase(generateMelody(item.node, phraseBars), inst, phraseBars * STEPS_PER_BAR);
    if (!phrase.length) continue;
    const intervals = placementsFor(inst, limit).sort((a, b) => a.startBar - b.startBar);
    const nodes: VoiceNode[] = [];
    const sweeps: SweepWindow[] = [];
    let cursor = 0;
    for (const iv of intervals) {
      const start = iv.startBar * STEPS_PER_BAR;
      if (start < cursor) continue;                                   // overlap guard
      if (start > cursor) { nodes.push(restOf(start - cursor)); cursor = start; }
      const budget = Math.min(phraseBars * STEPS_PER_BAR, limitSteps - cursor);
      if (budget <= 0) break;
      const used = emitPhrase(phrase, inst, budget, nodes);
      // A melody transition (item.inst.intro/outro) fades EACH placement in/out — realised
      // as row-sweep windows over this placement (env.reps read as a length in BARS).
      collectMelodySweeps(inst, start, used, sweeps);
      cursor += used;
    }
    if (cursor < limitSteps) nodes.push(restOf(limitSteps - cursor));
    const allSweeps = [...sweeps, ...rowSweeps];
    lanes.push({
      color: MELODY_COLOR_INDEX,
      nodes: nodes.length ? nodes : [restOf(limitSteps)],
      sweeps: allSweeps.length ? allSweeps : undefined,
    });
  }
  return lanes;
}

/** Add a melody placement's fade-in / fade-out windows (from item.inst.intro/outro) to
    `out`. A melody has no pattern reps, so the envelope's `reps` is read as a length in
    BARS, capped to the placement. Intro = fade IN (effect → sound, side "in") at the
    placement start; outro = fade OUT (sound → effect, side "out") at its end. */
function collectMelodySweeps(inst: Loop, startStep: number, usedSteps: number, out: SweepWindow[]): void {
  if (usedSteps <= 0) return;
  const placeBars = Math.max(1, Math.round(usedSteps / STEPS_PER_BAR));
  const end = startStep + usedSteps;
  if (inst.intro) {
    const bars = Math.max(1, Math.min(placeBars, Math.round(inst.intro.reps)));
    out.push({ from: startStep, to: startStep + bars * STEPS_PER_BAR, mode: inst.intro.mode, modes: inst.intro.modes,
      side: "in", fromV: inst.intro.from, toV: inst.intro.to, curve: inst.intro.curve, dir: inst.intro.dir,
      shape: inst.intro.shape, cycles: inst.intro.cycles });
  }
  if (inst.outro) {
    const bars = Math.max(1, Math.min(placeBars, Math.round(inst.outro.reps)));
    out.push({ from: end - bars * STEPS_PER_BAR, to: end, mode: inst.outro.mode, modes: inst.outro.modes,
      side: "out", fromV: inst.outro.from, toV: inst.outro.to, curve: inst.outro.curve, dir: inst.outro.dir,
      shape: inst.outro.shape, cycles: inst.outro.cycles });
  }
}

/** Emit a generated phrase's notes/rests into `out`, consuming up to `budget` steps (the
    remaining room in the placement / track). Pitches clamp to the instrument's range. */
function emitPhrase(phrase: EmittedNote[], inst: Loop, budget: number, out: VoiceNode[]): number {
  const [lo, hi] = inst.pitch;
  let used = 0;
  for (const ev of phrase) {
    if (used >= budget) break;
    if (ev.restSteps > 0) {
      const rs = Math.min(ev.restSteps, budget - used);
      if (rs > 0) { out.push(restOf(rs)); used += rs; }
      if (used >= budget) break;
    }
    const len = Math.min(ev.lengthSteps, budget - used);
    if (len <= 0) continue;
    out.push(melodyNoteNode(inst, len, Math.max(lo, Math.min(hi, ev.hz))));
    used += len;
  }
  return used;
}

/** A fresh placement rule: EVERY bar, the length of the track — a new loop covers the
    whole timeline until it's placed otherwise. Solo, so siblings still resolve. */
export function defaultRule(): PlacementRule {
  return { every: { kind: "nth", n: 1 }, forBars: 1, mode: "solo", seed: randomSeed(), seedHistory: [] };
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
  n.pitch = [loop.pitch[0], loop.pitch[1]];
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
  n.preset = loop.preset;
  n.ranges = loop.ranges ? { lo: loop.ranges.lo.slice(), hi: loop.ranges.hi.slice() } : undefined;
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
      const reps = Math.max(1, Math.floor(lenSteps / unit));
      nodes.push(loopToNode(iv.loop, reps));
      const consumed = reps * unit;
      cursor += consumed;
      const intendedEnd = chunkStart + Math.max(lenSteps, consumed); // extend if a cycle overran
      if (cursor < intendedEnd) { nodes.push(restOf(intendedEnd - cursor)); cursor = intendedEnd; }
    }
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
    equal-loop runs into intervals. `blocked` marks bars already taken by the colour's other
    loops — a "fill" loop only lands on the blanks (see placementsMasked). */
function soloLane(soloLoops: Loop[], barLimit: number, blocked?: boolean[]): Interval[] {
  const owner: (Loop | null)[] = new Array(barLimit).fill(null);
  const prio = new Map<Loop, number>();
  soloLoops.forEach((lp, i) => prio.set(lp, i));
  for (const lp of soloLoops) {
    for (const iv of placementsMasked(lp, barLimit, blocked)) {
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

/** The bars (0-indexed, true = taken) a colour's NON-fill loops sound on, across EVERY mode
    (solo, overlap, dice). A "fill" loop fills only the bars left false here — the blanks — so
    "fill the blanks" holds whatever the other loops' modes/order are (not just solo, as the
    priority-resolved soloLane alone would give). Fill loops are excluded so they never block
    each other into total silence. */
function nonFillCoverage(loops: Loop[], barLimit: number): boolean[] {
  const covered = new Array(barLimit).fill(false);
  const mark = (iv: Interval) => {
    const end = Math.min(barLimit, iv.startBar + iv.forBars);
    for (let b = Math.max(0, iv.startBar); b < end; b++) covered[b] = true;
  };
  for (const lp of loops) {
    if (lp.rule.every.kind === "fill" || lp.rule.every.kind === "dice") continue;
    for (const iv of placementsFor(lp, barLimit)) mark(iv);
  }
  for (const iv of dicePoolLane(loops.filter((l) => l.rule.every.kind === "dice"), barLimit)) mark(iv);
  return covered;
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

/** Compile a whole track into engine lanes: per colour, one solo lane (priority-resolved),
    one dice-pool lane (proportional fill), plus one lane per simultaneous overlap. Lanes
    carry their colour; each spans barLimit. */
export function compile(colors: ColorTrack[], barLimit: number): Lane[] {
  const limit = Math.max(1, Math.round(barLimit));
  const lanes: Lane[] = [];
  for (let c = 0; c < colors.length; c++) {
    if (c === MELODY_COLOR_INDEX) continue; // the last colour is the melody (see toLanes)
    const loops = colors[c]?.loops ?? [];
    if (loops.length === 0) continue;
    // The whole row's FX sweeps ride over every lane this colour compiles to, and every
    // loop's own transitions ("morph" windows toward a transformed sound) ride with
    // them. Windows may overlap — the engine composes them (each morphs the result of
    // the previous).
    const wins = rowSweepWindows(colors[c]?.sweeps, limit);
    for (const lp of loops) wins.push(...loopTransitionWindows(lp, limit));
    const sweeps = wins.length ? wins : undefined;
    const add = (nodes: VoiceNode[]) => lanes.push({ color: c, nodes, sweeps });
    // Dice loops form a shared pool regardless of their solo/overlap mode.
    const dice = loops.filter((l) => l.rule.every.kind === "dice");
    const solo = loops.filter((l) => l.rule.every.kind !== "dice" && l.rule.mode === "solo");
    const overlap = loops.filter((l) => l.rule.every.kind !== "dice" && l.rule.mode === "overlap");
    // Bars already sounded by this colour's non-fill loops (any mode). A "fill" loop lands
    // only on the blanks — so it fills the gaps left by an overlap/dice loop too, not just
    // by higher-priority solo loops.
    const blocked = nonFillCoverage(loops, limit);

    const soloIvs = soloLane(solo, limit, blocked);
    if (soloIvs.length) add(buildLane(soloIvs, limit));

    const diceIvs = dicePoolLane(dice, limit);
    if (diceIvs.length) add(buildLane(diceIvs, limit));

    const overlapIvs: Interval[] = [];
    for (const lp of overlap) overlapIvs.push(...placementsMasked(lp, limit, blocked));
    for (const laneIvs of packOverlap(overlapIvs)) add(buildLane(laneIvs, limit));
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
    pitch: [loop.pitch[0], loop.pitch[1]],
    hits: loop.hits,
    steps: loop.steps,
    rotation: loop.rotation,
    split: loop.split,
    patternOv: loop.patternOv ? loop.patternOv.slice() : undefined,
    rhythm: loop.rhythm,
    gain: loop.gain,
    intro: loop.intro ? { ...loop.intro, modes: loop.intro.modes?.slice() } : undefined,
    outro: loop.outro ? { ...loop.outro, modes: loop.outro.modes?.slice() } : undefined,
    transitions: loop.transitions
      ? loop.transitions.map((t) => ({ ...t, bars: t.bars.slice(), snapshot: t.snapshot.slice() }))
      : undefined,
    accent: loop.accent ? { ...loop.accent } : undefined,
    ghost: loop.ghost ? { ...loop.ghost } : undefined,
    preset: loop.preset,
    ranges: loop.ranges ? { lo: loop.ranges.lo.slice(), hi: loop.ranges.hi.slice() } : undefined,
    rule: {
      every,
      forBars: loop.rule.forBars,
      lengths: loop.rule.lengths ? loop.rule.lengths.slice() : undefined,
      retrigger: loop.rule.retrigger,
      mode: loop.rule.mode,
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
    pitch: [60, 1000],
    hits: 0,
    steps: 0,
    rotation: 0,
    rule: defaultRule(),
  };
}
