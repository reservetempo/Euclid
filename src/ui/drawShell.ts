// The chrome every sketch screen wears, and the axis description it wears it for.
//
// There are two sketch screens in the app and they are different EDITORS over the same idea
// — "give me a function of x, as `slots` uniform samples":
//   • drawOverlay.ts  — freehand: one stroke, cleaned up and simplified (the transition's
//                       blend function);
//   • pathOverlay.ts  — tap-to-place nodes joined by lines you bend (the pitch contour).
// Everything they share — the modal card, the title/hint/close, the canvas sizing, the axis
// backdrop, the verdict line, the button row — lives here, so the two screens look and behave
// like one feature rather than two that drifted apart.
//
// Like the editors themselves, this module is axis-agnostic: it works in canvas space, where
// y runs 0 (bottom) to 1 (top). What the height MEANS (plain 0..1, log-Hz, …) stays with the
// caller; all this module knows are the corner labels it prints.

/** What the axes mean, and how much of the curve survives being stored. */
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
  /** How many uniform samples the caller stores. Also the ceiling on however many points an
      editor offers: a 33rd point could not survive a 32-slot store, so offering one would be
      a lie. */
  slots: number;
}

/** The built-but-empty screen. The editor fills `controls` and `actions`, writes `verdict`,
    and paints `canvas`. */
export interface DrawShell {
  overlay: HTMLDivElement;
  card: HTMLDivElement;
  canvas: HTMLCanvasElement;
  /** The row between the canvas and the verdict (a slider, a readout — editor's choice). */
  controls: HTMLDivElement;
  verdict: HTMLParagraphElement;
  actions: HTMLDivElement;
  close: () => void;
}

/** Build the modal and put it on the page. Only one sketch screen exists at a time, so this
    replaces any that is already open. */
export function openDrawShell(axis: DrawAxis): DrawShell {
  document.querySelector(".draw-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "draw-overlay";
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const card = document.createElement("div");
  card.className = "draw-card";
  card.style.setProperty("--vc", axis.color);

  const head = document.createElement("div");
  head.className = "draw-head";
  const title = document.createElement("h3");
  title.className = "tr-title";
  title.textContent = axis.title;
  const closeBtn = document.createElement("button");
  closeBtn.className = "seg-btn";
  closeBtn.textContent = "✕";
  closeBtn.onclick = close;
  head.append(title, closeBtn);

  const hint = document.createElement("p");
  hint.className = "sing-hint";
  hint.textContent = axis.hint;

  const canvas = document.createElement("canvas");
  canvas.className = "draw-canvas";

  const controls = document.createElement("div");
  controls.className = "draw-simplify";

  const verdict = document.createElement("p");
  verdict.className = "sing-hint draw-verdict";

  const actions = document.createElement("div");
  actions.className = "placement-seg draw-actions";

  card.append(head, hint, canvas, controls, verdict, actions);
  overlay.append(card);
  document.body.append(overlay);
  return { overlay, card, canvas, controls, verdict, actions, close };
}

/** Match the backing store to the CSS box and hand back a context, or null while the canvas
    still has no layout (the first frame after `append`). */
export function prepareCanvas(canvas: HTMLCanvasElement, dpr: number): CanvasRenderingContext2D | null {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  if (canvas.width !== Math.round(rect.width * dpr)) {
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  return canvas.getContext("2d");
}

/** The panel behind the curve: fill, quarter grid (edges brighter, mirroring the Graph tab's
    viz) and the three axis labels. */
export function paintAxisBackdrop(
  ctx: CanvasRenderingContext2D,
  axis: DrawAxis,
  dpr: number,
): void {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0d1019";
  ctx.fillRect(0, 0, W, H);
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
}
