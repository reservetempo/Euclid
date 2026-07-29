// Turning a shaky stroke into a handful of control points — the same job a bitmap tracer
// does when it produces an SVG path. Ported from the waveDraw sketch app; the algorithm
// choices below are its, and were measured there.
//
// Visvalingam–Whyatt, not Ramer–Douglas–Peucker. Both are standard, but Visvalingam removes
// points one at a time, smallest triangle first, so ONE pass at stroke-end yields a ranking
// and the point slider then just takes the top N. RDP is driven by a distance tolerance,
// which would need a search per slider tick to land on an exact point count — and the count
// is the thing the slider is showing.
//
// This is the SIMPLIFY half of the drawing pipeline (see spline.ts for the fit, and
// curveFit.ts for the older de-shake that feeds transitions). It is pure geometry over
// normalized 0..1 coordinates and knows nothing about pitch, seconds or params.

export interface Point {
  x: number;
  y: number;
}

export interface Ranked {
  point: Point;
  /** Effective area: the triangle this point made with its neighbours at the moment it was
      dropped. Bigger = more important. The two endpoints get Infinity, since a curve
      without its ends is not the same curve. */
  area: number;
}

/** Rank every point by how much shape it carries. One pass, at stroke-end. */
export function rankPoints(points: readonly Point[]): Ranked[] {
  const n = points.length;
  if (n <= 2) return points.map((point) => ({ point, area: Infinity }));

  // Doubly linked list over the indices, so removing a point is O(1) and its neighbours'
  // areas can be recomputed in place.
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const area = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = i - 1;
    next[i] = i + 1;
  }
  const alive = new Uint8Array(n).fill(1);
  for (let i = 1; i < n - 1; i++) area[i] = triangleArea(points[i - 1], points[i], points[i + 1]);

  const out: Ranked[] = [];
  let running = 0;

  // n-2 removals: everything but the two endpoints, smallest area first.
  for (let removed = 0; removed < n - 2; removed++) {
    let best = -1;
    for (let i = 1; i < n - 1; i++) {
      if (!alive[i]) continue;
      if (best === -1 || area[i] < area[best]) best = i;
    }
    if (best === -1) break;

    // Areas must never decrease down the ranking: if a point's own triangle is smaller than
    // one already discarded, it is only small because its neighbours went first, and it must
    // not outrank them.
    running = Math.max(running, area[best]);
    out.push({ point: points[best], area: running });

    alive[best] = 0;
    const p = prev[best];
    const q = next[best];
    next[p] = q;
    prev[q] = p;
    if (p > 0) area[p] = triangleArea(points[prev[p]], points[p], points[q]);
    if (q < n - 1) area[q] = triangleArea(points[p], points[q], points[next[q]]);
  }

  // Least important first out of the loop; flip so index 0 is most important, then put the
  // two endpoints at the very front.
  out.reverse();
  return [
    { point: points[0], area: Infinity },
    { point: points[n - 1], area: Infinity },
    ...out,
  ];
}

/** The `count` most important points, back in left-to-right order — which is what a spline
    needs, and is not the order the ranking is in. */
export function takeTop(ranked: readonly Ranked[], count: number): Point[] {
  const n = Math.max(2, Math.min(count, ranked.length));
  return ranked
    .slice(0, n)
    .map((r) => r.point)
    .sort((a, b) => a.x - b.x);
}

function triangleArea(a: Point, b: Point, c: Point): number {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
}
