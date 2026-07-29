// The freehand DRAW screen, shared by everything in the app you can sketch a function for.
//
// Two callers today: a transition's blend function (0..1, "how far transformed") and the
// pitch envelope's Drawn contour (a log-Hz axis). They differ ONLY in what their axes mean
// and how many samples they store, so both of those are injected and everything else —
// stroke capture, de-shake, the Simplify stage, the canvas, the overlay lifecycle — is here.
//
// The overlay itself is axis-agnostic on purpose: it works entirely in canvas space, where y
// runs 0 (bottom) to 1 (top), and hands the caller `slots` uniform samples in that space.
// Converting those to stored units is the caller's job, which is what keeps a log-frequency
// axis from leaking into a module that also serves a plain 0..1 one.
//
// The pipeline, in order:
//   raw pointer stroke
//     → smoothStroke   (curveFit.ts) bins by x and de-shakes, so the result IS a function
//     → rankPoints     (simplify.ts) ranks every sample by how much shape it carries
//     → takeTop(N)     the point slider — N is transient, never stored (it can always be
//                      re-derived by ranking the stored curve again)
//     → buildSpline    (spline.ts) shape-preserving cubic through those N points
//     → resampleUniform back to the fixed `slots` the caller can store
//
// Re-simplifying a curve that was already simplified loses a little each round trip, so the
// slider deliberately reopens at FULL detail rather than at some remembered lower count:
// erosion is then something you opt into per visit instead of something that accumulates.

import { smoothStroke } from "../model/curveFit";
import { Point, Ranked, rankPoints, takeTop } from "../model/simplify";
import { buildSpline, resampleUniform } from "../model/spline";

/** What the two axes mean, and how much of the curve survives being stored. */
export interface DrawAxis {
  title: string;
  /** Sentence under the title: what drawing high vs low actually does. */
  hint: string;
  /** Accent colour for the card (the voice's colour). */
  color: string;
  /** Corner labels for the y axis — drawn top-left and bottom-left. */
  topLabel: string;
  bottomLabel: string;
  /** Caption under the x axis (e.g. the window in seconds), or "" for none. */
  xLabel: string;
  /** How many uniform samples the caller stores. Also the point slider's ceiling: a 33rd
      point could not survive a 32-slot store, so offering one would be a lie. */
  slots: number;
}

/** One extra way out of the overlay, beside Clear and Use drawing (the transition editor's
    "Use formula"). `ys` is always in canvas space. */
export interface DrawAction {
  label: string;
  title: string;
  /** Highlighted when this is the button the app would recommend. */
  highlight?: (ys: number[]) => boolean;
  run: (ys: number[]) => void;
}

export interface DrawOverlayOptions {
  axis: DrawAxis;
  /** The curve to reopen on, in canvas space, or null for a blank canvas. */
  initial?: number[] | null;
  /** The verdict line under the canvas. Called with the current curve, or null when there
      isn't one yet. */
  verdict?: (ys: number[] | null) => string;
  /** A dashed reference curve drawn behind the drawing (the matched formula), or null. */
  ghost?: (ys: number[]) => ((x01: number) => number) | null;
  actions?: DrawAction[];
  /** Keep the curve exactly as drawn. */
  commit: (ys: number[]) => void;
}

/** Enough points to keep a deliberate wiggle, few enough to look cleaned up — the count a
    FRESH stroke lands on. Reopening an existing curve starts at full detail instead. */
const DEFAULT_POINTS = 12;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Open the draw screen. Returns nothing: every exit runs through `commit` or an action. */
export function openDrawOverlay(opts: DrawOverlayOptions): void {
  const { axis } = opts;
  document.querySelector(".draw-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "draw-overlay";
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  const card = document.createElement("div");
  card.className = "draw-card";
  card.style.setProperty("--vc", axis.color);

  const head = document.createElement("div");
  head.className = "draw-head";
  const title = document.createElement("h3");
  title.className = "tr-title";
  title.textContent = axis.title;
  const close = document.createElement("button");
  close.className = "seg-btn";
  close.textContent = "✕";
  close.onclick = () => overlay.remove();
  head.append(title, close);
  card.append(head);

  const hint = document.createElement("p");
  hint.className = "sing-hint";
  hint.textContent = axis.hint;
  card.append(hint);

  const canvas = document.createElement("canvas");
  canvas.className = "draw-canvas";
  card.append(canvas);

  // --- the Simplify stage: how many of the ranked points to keep ---
  const simplify = document.createElement("div");
  simplify.className = "draw-simplify";
  const simplifyLbl = document.createElement("span");
  simplifyLbl.className = "draw-simplify-lbl";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "2";
  slider.max = String(axis.slots);
  slider.step = "1";
  simplify.append(simplifyLbl, slider);
  card.append(simplify);

  const verdict = document.createElement("p");
  verdict.className = "sing-hint draw-verdict";
  const actions = document.createElement("div");
  actions.className = "placement-seg draw-actions";
  const clearBtn = document.createElement("button");
  clearBtn.className = "seg-btn";
  clearBtn.textContent = "Clear";
  const useDraw = document.createElement("button");
  useDraw.className = "seg-btn";
  useDraw.textContent = "Use drawing";
  useDraw.title = "Keep the cleaned-up curve exactly as drawn";
  actions.append(clearBtn, useDraw);
  const extras = (opts.actions ?? []).map((a) => {
    const b = document.createElement("button");
    b.className = "seg-btn";
    b.textContent = a.label;
    b.title = a.title;
    actions.append(b);
    return { spec: a, el: b };
  });
  card.append(verdict, actions);
  overlay.append(card);
  document.body.append(overlay);

  // --- state ---------------------------------------------------------------
  // `ranked` is the whole ranking, computed once per stroke; `count` is where the slider
  // sits in it. Everything else is derived on demand — the ranking is the expensive step and
  // the slider must not re-run it.
  let raw: Point[] = [];
  let drawing = false;
  let ranked: Ranked[] | null = null;
  let count = axis.slots;

  const maxCount = () => Math.max(2, Math.min(axis.slots, ranked?.length ?? 2));

  /** The current curve as `slots` uniform canvas-space samples, or null if nothing drawn. */
  const curveOf = (): number[] | null => {
    if (!ranked) return null;
    const segs = buildSpline(takeTop(ranked, Math.min(count, maxCount())));
    return resampleUniform(segs, axis.slots).map((v) => Math.round(clamp01(v) * 1000) / 1000);
  };
  /** The retained control points, for drawing the dots the slider is actually moving. */
  const knotsOf = (): Point[] => (ranked ? takeTop(ranked, Math.min(count, maxCount())) : []);

  const rankFrom = (ys: number[], fresh: boolean): void => {
    const n = ys.length;
    ranked = rankPoints(ys.map((y, i) => ({ x: n > 1 ? i / (n - 1) : 0, y })));
    // A fresh stroke lands on a tidy default; a curve being REOPENED starts at full detail,
    // so revisiting the editor doesn't quietly erode it (see the module header).
    count = fresh ? Math.min(DEFAULT_POINTS, maxCount()) : maxCount();
  };

  if (opts.initial && opts.initial.length > 1) rankFrom(opts.initial.map(clamp01), false);

  const refreshFooter = () => {
    const ys = curveOf();
    const has = !!ys;
    useDraw.disabled = !has;
    slider.disabled = !has;
    slider.max = String(maxCount());
    slider.value = String(Math.min(count, maxCount()));
    simplifyLbl.textContent = has ? `Points: ${Math.min(count, maxCount())}` : "Points";
    verdict.textContent = opts.verdict
      ? opts.verdict(ys)
      : has ? "" : "Draw left to right — redrawing replaces the line.";
    let recommended = false;
    for (const { spec, el } of extras) {
      el.disabled = !has;
      const on = !!(has && spec.highlight && spec.highlight(ys!));
      el.classList.toggle("on", on);
      recommended = recommended || on;
    }
    useDraw.classList.toggle("on", has && !recommended);
  };

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const redraw = () => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (canvas.width !== Math.round(rect.width * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0d1019";
    ctx.fillRect(0, 0, W, H);
    // Quarter grid, edges brighter (mirroring the Graph tab's viz).
    for (let q = 0; q <= 4; q++) {
      ctx.strokeStyle = q === 0 || q === 4 ? "rgba(154,168,204,0.28)" : "rgba(154,168,204,0.12)";
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo((q / 4) * W, 0); ctx.lineTo((q / 4) * W, H);
      ctx.moveTo(0, (q / 4) * H); ctx.lineTo(W, (q / 4) * H);
      ctx.stroke();
    }
    ctx.fillStyle = "#97a0b6";
    ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
    ctx.fillText(axis.topLabel, 6 * dpr, 14 * dpr);
    ctx.fillText(axis.bottomLabel, 6 * dpr, H - 6 * dpr);
    if (axis.xLabel) {
      const w = ctx.measureText(axis.xLabel).width;
      ctx.fillText(axis.xLabel, W - w - 6 * dpr, H - 6 * dpr);
    }
    const strokePath = (fn: (x01: number) => number) => {
      ctx.beginPath();
      const N = 128;
      for (let i = 0; i <= N; i++) {
        const x = i / N;
        const y = clamp01(fn(x));
        const px = x * W, py = (1 - y) * H;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    };
    const ys = curveOf();
    // The caller's reference curve (a matched formula), dashed behind the drawing.
    const ghost = ys && opts.ghost ? opts.ghost(ys) : null;
    if (ghost) {
      ctx.strokeStyle = "rgba(154,168,204,0.5)";
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      strokePath(ghost);
      ctx.setLineDash([]);
    }
    // The cleaned curve (or the raw stroke while the finger is still down).
    if (drawing && raw.length > 1) {
      ctx.strokeStyle = "rgba(255,214,10,0.55)";
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      raw.forEach((p, i) => {
        const px = p.x * W, py = (1 - p.y) * H;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
    } else if (ys) {
      ctx.strokeStyle = "#ffd60a";
      ctx.lineWidth = 2.5 * dpr;
      strokePath((x) => {
        const xi = x * (ys.length - 1);
        const i0 = Math.min(ys.length - 2, Math.floor(xi));
        return ys[i0] + (ys[i0 + 1] - ys[i0]) * (xi - i0);
      });
      // The retained control points — what the slider is really moving.
      ctx.fillStyle = "#ffd60a";
      for (const k of knotsOf()) {
        ctx.beginPath();
        ctx.arc(k.x * W, (1 - clamp01(k.y)) * H, 3 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  const norm = (e: PointerEvent): Point => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01(1 - (e.clientY - rect.top) / rect.height),
    };
  };
  canvas.onpointerdown = (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    raw = [norm(e)];
    redraw();
  };
  canvas.onpointermove = (e) => {
    if (!drawing) return;
    raw.push(norm(e));
    redraw();
  };
  const finish = () => {
    if (!drawing) return;
    drawing = false;
    // smoothStroke first: it bins by x and de-shakes, which is what guarantees the ranking
    // below is ranking a FUNCTION rather than a stroke that wandered back over itself.
    if (raw.length > 3) rankFrom(smoothStroke(raw), true);
    raw = [];
    refreshFooter();
    redraw();
  };
  canvas.onpointerup = finish;
  canvas.onpointercancel = finish;

  slider.oninput = () => {
    count = Math.max(2, Math.min(maxCount(), Math.round(Number(slider.value) || 2)));
    refreshFooter();
    redraw();
  };

  clearBtn.onclick = () => {
    ranked = null;
    refreshFooter();
    redraw();
  };
  useDraw.onclick = () => {
    const ys = curveOf();
    if (!ys) return;
    overlay.remove();
    opts.commit(ys);
  };
  for (const { spec, el } of extras) {
    el.onclick = () => {
      const ys = curveOf();
      if (!ys) return;
      overlay.remove();
      spec.run(ys);
    };
  }

  refreshFooter();
  requestAnimationFrame(redraw);
}
