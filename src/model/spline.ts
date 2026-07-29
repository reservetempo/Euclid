// Control points → an actual function: a shape-preserving cubic (the Fritsch–Carlson
// slopes, i.e. PCHIP). Ported from the waveDraw sketch app, whose header records why:
//
// The textbook choice here is a natural cubic spline, and it was the first thing tried
// there. It rings: with the detail slider high, the knots sit close together and the spline
// swings past the ink between them, so pushing the slider toward "faithful" measurably made
// the fit WORSE (max error 0.41 against 0.31 at six points). A curve that overshoots the
// line you drew looks broken, whatever its second derivative is doing.
//
// Fritsch–Carlson picks the slope at each knot so no segment can overshoot its endpoints,
// which trades the natural spline's C² smoothness for never lying about your drawing.
//
// The sketch app also printed each segment as algebra; Euclid does not, so the expression
// half of that module (segmentExpr and its Expr dependency) is deliberately not ported —
// a drawn contour's "formula" here is the drawing itself.

import { Point } from "./simplify";

export interface Segment {
  /** Segment covers [x0, x1]. */
  x0: number;
  x1: number;
  /** y = a + b·t + c·t² + d·t³, where t = x − x0. */
  a: number;
  b: number;
  c: number;
  d: number;
}

/** Solve for the spline through `points` (assumed sorted by x, distinct). Fewer than 3
    points degenerates to a straight line, which is correct. */
export function buildSpline(points: readonly Point[]): Segment[] {
  const n = points.length;
  if (n < 2) return [];
  if (n === 2) {
    const [p, q] = points;
    const h = q.x - p.x || 1;
    return [{ x0: p.x, x1: q.x, a: p.y, b: (q.y - p.y) / h, c: 0, d: 0 }];
  }

  const h = new Float64Array(n - 1);
  const delta = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = Math.max(points[i + 1].x - points[i].x, 1e-9);
    delta[i] = (points[i + 1].y - points[i].y) / h[i];
  }

  // Slope at each knot. The rule that kills overshoot: where the curve turns — the secants
  // on either side disagree in sign — the tangent is flat, so the segment cannot carry on
  // past the corner. Elsewhere it is the weighted harmonic mean of the two secants, which is
  // never steeper than either.
  const m = new Float64Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }

  const segs: Segment[] = [];
  for (let i = 0; i < n - 1; i++) {
    // Hermite basis rewritten in powers of t = x − xᵢ.
    segs.push({
      x0: points[i].x,
      x1: points[i + 1].x,
      a: points[i].y,
      b: m[i],
      c: (3 * delta[i] - 2 * m[i] - m[i + 1]) / h[i],
      d: (m[i] + m[i + 1] - 2 * delta[i]) / (h[i] * h[i]),
    });
  }
  return segs;
}

/** Evaluate the spline. NaN outside its span, so a plotter lifts the pen at the ends without
    the caller needing to bound anything. */
export function evalSpline(segs: readonly Segment[], x: number): number {
  if (segs.length === 0) return NaN;
  if (x < segs[0].x0 || x > segs[segs.length - 1].x1) return NaN;
  const seg = segs[findSegment(segs, x)];
  const t = x - seg.x0;
  return seg.a + t * (seg.b + t * (seg.c + t * seg.d));
}

/** Index of the segment containing `x`, clamped to the ends. */
export function findSegment(segs: readonly Segment[], x: number): number {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x <= segs[mid].x1) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Resample a spline into `n` uniform samples across its own span — the step that turns a
    drawing into the fixed-length block a snapshot can carry (see PitchDraw1 in params.ts).
    Outside the span the ends hold flat rather than going NaN, so a stroke that stops short
    of the axis edge still yields a complete function. */
export function resampleUniform(segs: readonly Segment[], n: number): number[] {
  if (segs.length === 0) return new Array<number>(n).fill(0);
  const x0 = segs[0].x0;
  const x1 = segs[segs.length - 1].x1;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / (n - 1);
    const y = evalSpline(segs, x);
    out[i] = Number.isFinite(y) ? y : evalSpline(segs, i < n / 2 ? x0 : x1);
  }
  return out;
}
