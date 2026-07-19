// Freehand-function support for the transition Graph tab: turn a shaky pointer
// stroke into a clean uniformly-sampled function, and FIT that function against the
// blend-shape family (see BlendShapeId in lines.ts) so the drawing can be named as a
// formula — and, when the fit is close, replaced by it outright.

import { BlendShapeId, BLEND_SHAPES, blendShape } from "./lines";

/** How many uniform samples a cleaned-up drawing keeps (x = 0..1 across the window). */
export const DRAWN_POINTS = 65;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Clean a raw pointer stroke into DRAWN_POINTS uniform samples of a FUNCTION y(x):
    points are binned by x (so a stroke that wanders back over itself averages out),
    gaps interpolate, the ends extend flat, and a few Gaussian passes take the hand
    shake out. Input coords are normalized 0..1 (y up); returns y values 0..1. */
export function smoothStroke(raw: { x: number; y: number }[], n = DRAWN_POINTS): number[] {
  const sum = new Float64Array(n);
  const cnt = new Float64Array(n);
  for (const p of raw) {
    const i = Math.round(clamp01(p.x) * (n - 1));
    sum[i] += clamp01(p.y);
    cnt[i]++;
  }
  // Fill: known bins average their hits; gaps lerp between the nearest known bins;
  // the stretches before the first / after the last known bin hold flat.
  const ys = new Array<number>(n).fill(0);
  const known: number[] = [];
  for (let i = 0; i < n; i++) if (cnt[i] > 0) { ys[i] = sum[i] / cnt[i]; known.push(i); }
  if (!known.length) return new Array<number>(n).fill(0).map((_, i) => i / (n - 1));
  for (let i = 0; i < known[0]; i++) ys[i] = ys[known[0]];
  for (let i = known[known.length - 1] + 1; i < n; i++) ys[i] = ys[known[known.length - 1]];
  for (let k = 0; k + 1 < known.length; k++) {
    const a = known[k], b = known[k + 1];
    for (let i = a + 1; i < b; i++) ys[i] = ys[a] + ((ys[b] - ys[a]) * (i - a)) / (b - a);
  }
  // De-shake: Gaussian-ish [1 4 6 4 1] passes, edges clamped so the ends stay put.
  const K = [1, 4, 6, 4, 1], KS = 16;
  for (let pass = 0; pass < 3; pass++) {
    const src = ys.slice();
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = -2; j <= 2; j++) acc += K[j + 2] * src[Math.max(0, Math.min(n - 1, i + j))];
      ys[i] = acc / KS;
    }
  }
  return ys.map((v) => Math.round(clamp01(v) * 1000) / 1000);
}

/** A drawing matched against the blend-shape family: the shape + its knobs, the
    least-squares slope/shift that best dresses it, the fit error, and a short label. */
export interface ShapeFit {
  shape: BlendShapeId;
  curve?: number;
  dir?: "in" | "out";
  cycles?: number;
  yGain: number;
  yBias: number;
  rmse: number;   // root-mean-square error against the drawing, in y units (0..1)
  label: string;  // e.g. "Sine · 2.5 waves"
}

interface Candidate { shape: BlendShapeId; curve?: number; dir?: "in" | "out"; cycles?: number }

// For one candidate shape, solve the best gain/bias in closed form (linear least
// squares of y ≈ a·s + b) and score the CLAMPED prediction — the engine clamps the
// transformed y to [0,1], so the fit should be judged the way it will play.
function scoreCandidate(cand: Candidate, ys: number[]): { yGain: number; yBias: number; rmse: number } {
  const n = ys.length;
  const s = new Array<number>(n);
  for (let i = 0; i < n; i++) s[i] = blendShape(cand, i / (n - 1));
  let sumS = 0, sumY = 0, sumSS = 0, sumSY = 0;
  for (let i = 0; i < n; i++) { sumS += s[i]; sumY += ys[i]; sumSS += s[i] * s[i]; sumSY += s[i] * ys[i]; }
  const det = n * sumSS - sumS * sumS;
  let a = det > 1e-9 ? (n * sumSY - sumS * sumY) / det : 0;
  if (!isFinite(a) || Math.abs(a) < 1e-6) a = 0;
  a = Math.max(-100, Math.min(100, Math.round(a * 100) / 100));
  let b = (sumY - a * sumS) / n;
  b = Math.max(-10, Math.min(10, Math.round(b * 100) / 100));
  let err = 0;
  for (let i = 0; i < n; i++) {
    const d = clamp01(a * s[i] + b) - ys[i];
    err += d * d;
  }
  return { yGain: a, yBias: b, rmse: Math.sqrt(err / n) };
}

const range = (lo: number, hi: number, step: number): number[] => {
  const out: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
};

// The candidate grid per shape family (coarse; a local refine pass tightens curve/cycles
// around the winner). Kept small — the whole search is a few thousand cheap evaluations.
function candidates(): Candidate[] {
  const out: Candidate[] = [];
  const dirs: ("out" | "in")[] = ["out", "in"];
  for (const c of range(0, 1, 0.125)) for (const d of dirs) out.push({ shape: "ramp", curve: c, dir: d });
  for (const c of range(0, 1, 0.125)) out.push({ shape: "scurve", curve: c });
  for (const c of range(0, 1, 0.2)) for (const d of dirs) out.push({ shape: "parabola", curve: c, dir: d });
  const waves = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8];
  for (const shape of ["sine", "cos", "zigzag"] as BlendShapeId[])
    for (const cy of waves) for (const c of range(0, 1, 0.25)) for (const d of dirs)
      out.push({ shape, cycles: cy, curve: c, dir: d });
  for (const cy of [1, 2, 3, 4, 5, 6]) for (const c of range(0, 1, 0.25))
    out.push({ shape: "wobble", cycles: cy, curve: c });
  for (const cy of [2, 3, 4, 5, 6, 8, 10, 12]) for (const c of range(0, 1, 0.25)) for (const d of dirs)
    out.push({ shape: "steps", cycles: cy, curve: c, dir: d });
  for (const cy of [1, 2, 3, 4, 5, 6, 8]) for (const c of range(0, 1, 0.2))
    out.push({ shape: "halfwave", cycles: cy, curve: c });
  return out;
}

function labelFor(c: Candidate): string {
  const spec = BLEND_SHAPES.find((s) => s.id === c.shape);
  const name = spec ? spec.label : c.shape;
  return spec && spec.usesCycles && c.cycles ? `${name} · ${c.cycles} ${c.shape === "steps" ? "steps" : "waves"}` : name;
}

/** Fit a cleaned drawing (uniform y samples) against the blend-shape family. Returns
    the closest formula; `rmse` says how close (≲0.04 reads as "that IS the formula"). */
export function fitBlendShape(ys: number[]): ShapeFit {
  let best: Candidate = { shape: "ramp", curve: 0 };
  let bestScore = scoreCandidate(best, ys);
  for (const cand of candidates()) {
    const sc = scoreCandidate(cand, ys);
    if (sc.rmse < bestScore.rmse - 1e-9) { best = cand; bestScore = sc; }
  }
  // Local refine around the winner: tighten curve (and cycles where it applies).
  for (let iter = 0; iter < 2; iter++) {
    const cStep = 0.04 / (iter + 1), cyStep = 0.25 / (iter + 1);
    for (const dc of [-cStep, 0, cStep]) {
      for (const dcy of best.cycles !== undefined ? [-cyStep, 0, cyStep] : [0]) {
        const cand: Candidate = {
          shape: best.shape,
          curve: best.curve !== undefined ? clamp01((best.curve ?? 0) + dc) : undefined,
          dir: best.dir,
          cycles: best.cycles !== undefined ? Math.max(0.25, Math.round(((best.cycles ?? 1) + dcy) * 100) / 100) : undefined,
        };
        const sc = scoreCandidate(cand, ys);
        if (sc.rmse < bestScore.rmse - 1e-9) { best = cand; bestScore = sc; }
      }
    }
  }
  return {
    shape: best.shape,
    curve: best.curve && best.curve > 0.001 ? best.curve : undefined,
    dir: best.dir,
    cycles: best.cycles,
    yGain: bestScore.yGain,
    yBias: bestScore.yBias,
    rmse: bestScore.rmse,
    label: labelFor(best),
  };
}
