// GRAPH MELODY GENERATOR — a "graph calculator" over the note lattice. A function
// y = f(x) is drawn across one phrase: x is TIME (16th steps across the melody's
// `forBars`), y is PITCH in scale degrees (integers index the melody's scale; 0 = the
// root at the phrase's octave, negative = below it). Where the curve passes close
// enough to a lattice point — an integer degree at a step — that note fires.
//
// "Close enough" is tunable, because an interesting curve rarely lands exactly on the
// lattice: `noteWidth` thickens the horizontal degree lines (how far off in PITCH a pass
// may be, as a fraction of a scale step) and `timeWidth` thickens the vertical step
// lines (how far off in TIME, as a fraction of a 16th step — the curve is sampled across
// that window around each step and the nearest approach counts). Runs of the same degree
// on consecutive steps merge into one held note; empty steps become rests.
//
// The result is an ordered run of MelodyNotes the UI lays down as a strict CHAIN
// (see chainNotes) so the phrase loops verbatim — the shape IS the melody.

import { MelodyNote } from "./melody";

export type GraphPresetId =
  | "line" | "exp" | "log" | "scurve" | "sine" | "zigzag" | "arch" | "wobble";

/** The tweakable parameters of the drawn function. `rise` is the shape's span in scale
    degrees (its slope height / wave amplitude; negative flips it), `offset` the starting
    degree (0 = the root), `bend` a 0..1 curvature (how hard exp/log/s-curve/wobble bend),
    and `cycles` the wave count for the periodic shapes. */
export interface GraphParams {
  preset: GraphPresetId;
  rise: number;
  offset: number;
  bend: number;
  cycles: number;
}

/** Which extra parameters each preset actually uses (the UI hides the rest). */
export const GRAPH_PRESETS: { id: GraphPresetId; label: string; uses: ("bend" | "cycles")[] }[] = [
  { id: "line", label: "Line", uses: [] },
  { id: "exp", label: "Exp", uses: ["bend"] },
  { id: "log", label: "Log", uses: ["bend"] },
  { id: "scurve", label: "S-curve", uses: ["bend"] },
  { id: "sine", label: "Sine", uses: ["cycles"] },
  { id: "zigzag", label: "Zigzag", uses: ["cycles"] },
  { id: "arch", label: "Arch", uses: ["bend"] },
  { id: "wobble", label: "Wobble", uses: ["cycles", "bend"] },
];

/** A triangle wave in [-1, 1]: 0 at x=0, rising to 1 at x=0.25, back through 0 at 0.5,
    down to −1 at 0.75 — the linear cousin of sin(2πx). */
function tri(x: number): number {
  const ph = x - Math.floor(x);
  if (ph < 0.25) return ph * 4;
  if (ph < 0.75) return 2 - ph * 4;
  return ph * 4 - 4;
}

/** Evaluate the drawn function at t∈[0,1] (position through the phrase), in scale
    degrees. Every preset starts at `offset` (t=0) and spans `rise` degrees in its own
    shape; periodic presets swing ±rise around the offset. */
export function graphY(p: GraphParams, t: number): number {
  const a = p.rise;
  const bend = Math.max(0, Math.min(1, p.bend));
  const cycles = Math.max(0.25, p.cycles);
  let y: number;
  switch (p.preset) {
    case "exp": {
      // Slow start, late rush; `bend` sharpens the elbow (k 1→8).
      const k = 1 + bend * 7;
      y = a * (Math.exp(k * t) - 1) / (Math.exp(k) - 1);
      break;
    }
    case "log": {
      // Early rush, long tail; `bend` sharpens the initial leap (k 2→32).
      const k = 2 + bend * 30;
      y = a * Math.log(1 + k * t) / Math.log(1 + k);
      break;
    }
    case "scurve": {
      // Logistic ease between the ends, normalized so t=0 → 0 and t=1 → rise.
      const k = 4 + bend * 12;
      const s = (x: number) => 1 / (1 + Math.exp(-k * (x - 0.5)));
      const lo = s(0), hi = s(1);
      y = a * (s(t) - lo) / (hi - lo);
      break;
    }
    case "sine":
      y = a * Math.sin(2 * Math.PI * cycles * t);
      break;
    case "zigzag":
      y = a * tri(cycles * t);
      break;
    case "arch": {
      // Up and back in one span; `bend` skews the peak earlier (0.5 → 0.2 through).
      const peak = 0.5 - bend * 0.3;
      const x = t <= peak ? (peak > 0 ? t / peak : 1) : (1 - t) / (1 - peak);
      y = a * Math.max(0, x);
      break;
    }
    case "wobble": {
      // A sine that dies away; `bend` is the damping (0 = steady, 1 = gone by the end).
      const d = bend * 5;
      y = a * Math.sin(2 * Math.PI * cycles * t) * Math.exp(-d * t);
      break;
    }
    default: // "line"
      y = a * t;
  }
  return y + p.offset;
}

/** One lattice hit: scale degree `degree` sounds at 16th step `step` of the phrase. */
export interface GraphHit {
  step: number;
  degree: number;
}

/** Where the curve lands on the note lattice across a `phraseSteps`-long phrase.
    `noteWidth` (0..0.5) is the pitch tolerance in scale-degree units; `timeWidth`
    (0..0.5) widens each step's snap window in step units (the curve is sampled across
    [step−w, step+w] and its nearest approach to a degree line counts). Degrees clamp to
    ±`maxAbs` so a runaway shape stays in playable range. */
export function graphHits(
  p: GraphParams, phraseSteps: number, noteWidth: number, timeWidth: number, maxAbs: number,
): GraphHit[] {
  const steps = Math.max(1, Math.round(phraseSteps));
  const yTol = Math.max(0, Math.min(0.5, noteWidth));
  const xTol = Math.max(0, Math.min(0.5, timeWidth));
  const out: GraphHit[] = [];
  for (let i = 0; i < steps; i++) {
    // Sample the curve across the step's snap window; the nearest lattice approach wins.
    const S = xTol > 0 ? 9 : 1;
    let bestDeg = 0, bestErr = Infinity;
    for (let s = 0; s < S; s++) {
      const off = S === 1 ? 0 : ((s / (S - 1)) * 2 - 1) * xTol;
      const x = Math.max(0, Math.min(steps, i + off));
      const y = graphY(p, x / steps);
      const d = Math.round(y);
      const err = Math.abs(y - d);
      if (err < bestErr) { bestErr = err; bestDeg = d; }
    }
    if (bestErr <= yTol) {
      out.push({ step: i, degree: Math.max(-maxAbs, Math.min(maxAbs, bestDeg)) });
    }
  }
  return out;
}

/** Merge lattice hits into an ordered note run: consecutive steps on the SAME degree
    hold as one longer note, a change of degree starts a new note, and empty steps
    become the next note's leading rest. Ready for chainNotes (verbatim playback). */
export function hitsToNotes(hits: GraphHit[]): MelodyNote[] {
  const out: MelodyNote[] = [];
  let prevEnd = 0; // step after the last note laid down
  let cur: { start: number; degree: number; len: number } | null = null;
  const flush = () => {
    if (!cur) return;
    out.push({ degree: cur.degree, weight: 3, lengthSteps: cur.len, restSteps: cur.start - prevEnd });
    prevEnd = cur.start + cur.len;
    cur = null;
  };
  for (const h of hits) {
    if (cur && h.degree === cur.degree && h.step === cur.start + cur.len) {
      cur.len++;
      continue;
    }
    flush();
    cur = { start: h.step, degree: h.degree, len: 1 };
  }
  flush();
  return out;
}
