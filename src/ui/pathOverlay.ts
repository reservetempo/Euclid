// The NODE PATH screen: tap to place points, drag a line to bend it — the SVG-pen way of
// drawing a function, as opposed to the freehand stroke in drawOverlay.ts.
//
// The pitch contour is authored here. A stroke is a fine way to say "swoop down", but a pitch
// line is usually a few deliberate places you want the tone to BE, and a stroke can't say
// that precisely — hence an editor made of points you can grab, nudge and re-grab, rather
// than one shot you either like or redraw.
//
// The model is tiny on purpose:
//   nodes[]      ordered by x, each an anchor in canvas space (y 0 bottom .. 1 top)
//   node.bend    how far the line to the NEXT node bows, in y units at its midpoint
// A segment is a quadratic Bézier whose control point sits at the segment's midpoint in x and
// `mid.y + 2·bend` in y. Putting the control x exactly halfway makes x LINEAR in t, so the
// curve is guaranteed to stay a function of x (no vertical folds possible) and sampling it at
// a given x needs no root-finding — the two things a general Bézier would cost us.
//
// Storage is unchanged from the freehand screen: `slots` uniform samples, so nothing
// downstream (params, save format, engine) knows which editor drew them. The nodes themselves
// are NOT stored; reopening reconstructs them by ranking the stored samples (simplify.ts) and
// keeping enough of them to retrace the curve within a hair. So a path survives a round trip
// as its shape, not as its exact handles — the same bargain the freehand screen makes.

import { rankPoints, takeTop } from "../model/simplify";
import { DrawAxis, DrawShell, openDrawShell, paintAxisBackdrop, prepareCanvas } from "./drawShell";

export interface PathOverlayOptions {
  axis: DrawAxis;
  /** The curve to reopen on, in canvas space, or null for a blank canvas. */
  initial?: number[] | null;
  /** The line under the canvas. Called with the current curve, or null when there isn't one. */
  verdict?: (ys: number[] | null) => string;
  commit: (ys: number[]) => void;
}

interface Node {
  x: number;
  y: number;
  /** Bow of the line to the next node, at its midpoint. 0 = straight. Unused on the last. */
  bend: number;
}

/** How close (CSS px) a finger has to be to grab a node or a line. */
const HIT_PX = 16;
/** Movement (CSS px) that turns a press on a line into a bend rather than a tap. */
const SLOP_PX = 6;
/** Press this long on a line and it starts bending even without moving. */
const HOLD_MS = 200;
/** Two taps on the same node inside this window delete it. */
const DOUBLE_MS = 320;
/** Closest two nodes may sit in x — a zero-width segment has no t to solve for. */
const MIN_GAP = 0.004;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Open the path editor. Returns nothing: the only ways out are Use drawing and closing. */
export function openPathOverlay(opts: PathOverlayOptions): void {
  const { axis } = opts;
  const shell: DrawShell = openDrawShell(axis);
  const { canvas } = shell;

  const readout = document.createElement("span");
  readout.className = "draw-simplify-lbl draw-path-lbl";
  shell.controls.append(readout);

  const clearBtn = document.createElement("button");
  clearBtn.className = "seg-btn";
  clearBtn.textContent = "Clear";
  const useBtn = document.createElement("button");
  useBtn.className = "seg-btn";
  useBtn.textContent = "Use drawing";
  useBtn.title = "Keep the path exactly as placed";
  shell.actions.append(clearBtn, useBtn);

  // --- the path -------------------------------------------------------------
  let nodes: Node[] = opts.initial && opts.initial.length > 1 ? nodesFrom(opts.initial, axis.slots) : [];

  /** y of the path at x, extended flat past either end (the contour has to cover the whole
      window even when the nodes only cover the middle of it). */
  const yAt = (x: number): number => {
    if (!nodes.length) return 0;
    if (nodes.length === 1 || x <= nodes[0].x) return nodes[0].y;
    const last = nodes[nodes.length - 1];
    if (x >= last.x) return last.y;
    const i = segmentAt(nodes, x);
    return evalSeg(nodes[i], nodes[i + 1], (x - nodes[i].x) / (nodes[i + 1].x - nodes[i].x));
  };

  /** The path as `slots` uniform canvas-space samples, or null while it is empty. */
  const curveOf = (): number[] | null => {
    if (!nodes.length) return null;
    return Array.from({ length: axis.slots }, (_, i) =>
      Math.round(clamp01(yAt(axis.slots > 1 ? i / (axis.slots - 1) : 0)) * 1000) / 1000);
  };

  // --- painting -------------------------------------------------------------
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  /** Which node/segment is under the finger right now — drawn bigger so a grab is visible. */
  let hotNode = -1;
  let hotSeg = -1;

  const redraw = () => {
    const ctx = prepareCanvas(canvas, dpr);
    if (!ctx) return;
    paintAxisBackdrop(ctx, axis, dpr);
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const px = (x: number) => x * W;
    const py = (y: number) => (1 - clamp01(y)) * H;
    if (!nodes.length) return;

    ctx.strokeStyle = "#000080";
    ctx.lineWidth = 2.5 * dpr;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(0, py(nodes[0].y));
    ctx.lineTo(px(nodes[0].x), py(nodes[0].y));
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i], b = nodes[i + 1];
      // The control point that makes x linear in t (see the module header).
      ctx.quadraticCurveTo(px((a.x + b.x) / 2), py((a.y + b.y) / 2 + 2 * a.bend), px(b.x), py(b.y));
    }
    const last = nodes[nodes.length - 1];
    ctx.lineTo(W, py(last.y));
    ctx.stroke();

    // A hollow handle on every anchor, plus a small tick at the midpoint of each bendable
    // line so it reads as something you can grab.
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i], b = nodes[i + 1];
      ctx.fillStyle = i === hotSeg ? "#000080" : "rgba(0,0,128,0.45)";
      ctx.beginPath();
      ctx.arc(px((a.x + b.x) / 2), py(evalSeg(a, b, 0.5)), (i === hotSeg ? 4 : 2.5) * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < nodes.length; i++) {
      const r = (i === hotNode ? 7 : 5) * dpr;
      ctx.beginPath();
      ctx.arc(px(nodes[i].x), py(nodes[i].y), r, 0, Math.PI * 2);
      // A white handle with a navy outline — a Win98 sizing grip, not a glowing dot.
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#000080";
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
    }
  };

  const refreshFooter = () => {
    const ys = curveOf();
    const n = nodes.length;
    useBtn.disabled = !ys;
    useBtn.classList.toggle("on", !!ys);
    clearBtn.disabled = !n;
    readout.textContent = n ? `Points: ${n}` : "Points";
    shell.verdict.textContent = opts.verdict
      ? opts.verdict(ys)
      : n ? "" : "Tap to place points.";
  };

  // --- pointer handling -----------------------------------------------------
  // Three gestures, told apart by WHERE the press lands and what happens next:
  //   on a node      → drag it (a second tap on the same node deletes it)
  //   on a line      → hold or move to bend it; a clean tap splits it with a new node
  //   empty canvas   → a new node appears under the finger, already being dragged
  type Grab =
    | { kind: "node"; i: number }
    | { kind: "bend"; seg: number; t: number; bend0: number; y0: number }
    | { kind: "press"; seg: number; x: number; y: number; downX: number; downY: number };
  let grab: Grab | null = null;
  let holdTimer = 0;
  let lastTap = { i: -1, at: 0 };

  const rectOf = () => canvas.getBoundingClientRect();
  const norm = (e: PointerEvent) => {
    const r = rectOf();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01(1 - (e.clientY - r.top) / r.height) };
  };

  /** Nearest node within HIT_PX, or -1. */
  const nodeUnder = (p: { x: number; y: number }): number => {
    const r = rectOf();
    let best = -1, bestD = HIT_PX;
    nodes.forEach((n, i) => {
      const d = Math.hypot((n.x - p.x) * r.width, (n.y - p.y) * r.height);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };
  /** The segment whose curve passes within HIT_PX of p, or -1. Ends count as segments only
      where the path actually is — the flat run-out past the last node is not bendable. */
  const segUnder = (p: { x: number; y: number }): number => {
    if (nodes.length < 2 || p.x < nodes[0].x || p.x > nodes[nodes.length - 1].x) return -1;
    const r = rectOf();
    const i = segmentAt(nodes, p.x);
    const t = (p.x - nodes[i].x) / (nodes[i + 1].x - nodes[i].x);
    return Math.abs(evalSeg(nodes[i], nodes[i + 1], t) - p.y) * r.height < HIT_PX ? i : -1;
  };

  const cancelHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; } };

  /** Turn a press on a line into a bend, anchored where the finger actually grabbed it. */
  const startBend = (seg: number, t: number, y: number) => {
    cancelHold();
    grab = { kind: "bend", seg, t, bend0: nodes[seg].bend, y0: y };
    hotSeg = seg;
    redraw();
  };

  const insertAt = (x: number, y: number): number => {
    const n: Node = { x, y, bend: 0 };
    let i = nodes.findIndex((k) => k.x > x);
    if (i < 0) i = nodes.length;
    nodes.splice(i, 0, n);
    spaceOut(nodes, i);
    return i;
  };

  canvas.onpointerdown = (e) => {
    e.preventDefault();
    // Capture keeps a drag alive outside the canvas; it throws if the pointer isn't actually
    // down (a synthetic event), and a failed capture is not a reason to drop the gesture.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    const p = norm(e);
    const ni = nodeUnder(p);
    if (ni >= 0) {
      // Second tap on the same node removes it — the only way to take a point back out.
      const now = performance.now();
      if (lastTap.i === ni && now - lastTap.at < DOUBLE_MS) {
        nodes.splice(ni, 1);
        lastTap = { i: -1, at: 0 };
        grab = null;
        hotNode = -1; hotSeg = -1;
        refreshFooter();
        redraw();
        return;
      }
      lastTap = { i: ni, at: now };
      grab = { kind: "node", i: ni };
      hotNode = ni;
      redraw();
      return;
    }
    lastTap = { i: -1, at: 0 };
    const si = segUnder(p);
    if (si >= 0) {
      const t = (p.x - nodes[si].x) / (nodes[si + 1].x - nodes[si].x);
      grab = { kind: "press", seg: si, x: p.x, y: p.y, downX: e.clientX, downY: e.clientY };
      hotSeg = si;
      holdTimer = window.setTimeout(() => startBend(si, t, p.y), HOLD_MS);
      redraw();
      return;
    }
    // Empty canvas: place a point and let this same gesture position it.
    hotNode = insertAt(p.x, p.y);
    grab = { kind: "node", i: hotNode };
    refreshFooter();
    redraw();
  };

  canvas.onpointermove = (e) => {
    const p = norm(e);
    if (!grab) {
      const ni = nodeUnder(p);
      const si = ni < 0 ? segUnder(p) : -1;
      if (ni !== hotNode || si !== hotSeg) { hotNode = ni; hotSeg = si; redraw(); }
      return;
    }
    if (grab.kind === "press") {
      // Moving past the slop means they meant to bend, not to tap.
      if (Math.hypot(e.clientX - grab.downX, e.clientY - grab.downY) < SLOP_PX) return;
      const g = grab;
      const t = (g.x - nodes[g.seg].x) / (nodes[g.seg + 1].x - nodes[g.seg].x);
      startBend(g.seg, t, g.y);
    }
    if (grab.kind === "node") {
      const n = nodes[grab.i];
      n.x = p.x; n.y = p.y;
      // Nodes stay in x order: a point dragged past its neighbour would flip the segment.
      const lo = grab.i > 0 ? nodes[grab.i - 1].x + MIN_GAP : 0;
      const hi = grab.i < nodes.length - 1 ? nodes[grab.i + 1].x - MIN_GAP : 1;
      n.x = Math.max(Math.min(lo, hi), Math.min(n.x, Math.max(lo, hi)));
      refreshFooter();
      redraw();
      return;
    }
    if (grab.kind === "bend") {
      // The finger drags the curve at the t it grabbed, not at the midpoint, so divide out
      // how much that spot actually moves per unit of bend: y(t) = base(t) + 4t(1−t)·bend.
      const w = Math.max(0.25, 4 * grab.t * (1 - grab.t));
      nodes[grab.seg].bend = grab.bend0 + (p.y - grab.y0) / w;
      refreshFooter();
      redraw();
    }
  };

  const release = () => {
    if (grab && grab.kind === "press") {
      // A clean tap on a line splits it, keeping the shape it already had there.
      const g = grab;
      cancelHold();
      hotNode = insertAt(g.x, yAt(g.x));
      hotSeg = -1;
      refreshFooter();
    }
    cancelHold();
    grab = null;
    redraw();
  };
  canvas.onpointerup = release;
  canvas.onpointercancel = release;
  canvas.onpointerleave = () => {
    if (!grab && (hotNode >= 0 || hotSeg >= 0)) { hotNode = -1; hotSeg = -1; redraw(); }
  };

  clearBtn.onclick = () => {
    nodes = [];
    grab = null; hotNode = -1; hotSeg = -1;
    refreshFooter();
    redraw();
  };
  useBtn.onclick = () => {
    const ys = curveOf();
    if (!ys) return;
    shell.close();
    opts.commit(ys);
  };

  refreshFooter();
  requestAnimationFrame(redraw);
}

/** Index of the segment containing x (callers guarantee nodes[0].x ≤ x ≤ last.x). */
function segmentAt(nodes: readonly Node[], x: number): number {
  let i = 0;
  while (i < nodes.length - 2 && nodes[i + 1].x <= x) i++;
  return i;
}

/** The quadratic between two anchors, at parameter t (which equals the fraction of the
    segment's x, because the control point sits halfway across it). */
function evalSeg(a: Node, b: Node, t: number): number {
  const c = (a.y + b.y) / 2 + 2 * a.bend;
  const u = 1 - t;
  return u * u * a.y + 2 * u * t * c + t * t * b.y;
}

/** Nudge a just-inserted node off its neighbours so no segment has zero width. */
function spaceOut(nodes: Node[], i: number): void {
  const lo = i > 0 ? nodes[i - 1].x + MIN_GAP : 0;
  const hi = i < nodes.length - 1 ? nodes[i + 1].x - MIN_GAP : 1;
  if (lo <= hi) nodes[i].x = Math.max(lo, Math.min(nodes[i].x, hi));
}

/** Rebuild anchors from stored samples: rank every sample by how much shape it carries, then
    keep the fewest that retrace the curve within TOL. Bends stay 0 — straight lines through
    enough points say the same thing, and the extra points are ones you can grab. */
function nodesFrom(ys: readonly number[], slots: number): Node[] {
  const TOL = 0.012;
  const n = ys.length;
  const ranked = rankPoints(ys.map((y, i) => ({ x: n > 1 ? i / (n - 1) : 0, y: clamp01(y) })));
  const cap = Math.min(slots, ranked.length, 16);
  let keep = takeTop(ranked, cap);
  for (let count = 2; count <= cap; count++) {
    const pts = takeTop(ranked, count);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const x = n > 1 ? i / (n - 1) : 0;
      worst = Math.max(worst, Math.abs(lineThrough(pts, x) - clamp01(ys[i])));
    }
    if (worst <= TOL) { keep = pts; break; }
  }
  return keep.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y), bend: 0 }));
}

/** Piecewise-linear read of a point list, flat past either end. */
function lineThrough(pts: readonly { x: number; y: number }[], x: number): number {
  if (!pts.length) return 0;
  if (x <= pts[0].x) return pts[0].y;
  const last = pts[pts.length - 1];
  if (x >= last.x) return last.y;
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1].x <= x) i++;
  const a = pts[i], b = pts[i + 1];
  return b.x === a.x ? b.y : a.y + (b.y - a.y) * ((x - a.x) / (b.x - a.x));
}
