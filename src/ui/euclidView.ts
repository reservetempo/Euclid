// Circular visualization for a grid's Euclidean mode: 5 nested circles (inner = voice
// 1, outer = voice 5). Each voice draws a dot at every step around its circle in the
// sound's colour, with a radial line to the centre on each hit. The dot at the current
// step lights up during playback. Mirrors GridView's DPR/layout handling.

import { MelodyGrid } from "../model/melodyGrid";
import { EUCLID_VOICES, euclidPattern } from "../model/euclid";

const TWO_PI = Math.PI * 2;
const TOP = -Math.PI / 2; // step 0 sits at 12 o'clock

export class EuclidView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private grid: MelodyGrid;
  private playStep = -1;

  constructor(grid: MelodyGrid) {
    this.grid = grid;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "euclid-canvas";
    this.ctx = this.canvas.getContext("2d")!;
  }

  setBlock(grid: MelodyGrid): void {
    this.grid = grid;
    this.playStep = -1;
    this.draw();
  }

  setPlayhead(step: number): void {
    if (step === this.playStep) return;
    this.playStep = step;
    this.draw();
  }

  /** The square side length (CSS px) the canvas should draw at. */
  private side(): number {
    const parentW = this.canvas.parentElement?.clientWidth || this.canvas.clientWidth || 320;
    return Math.min(parentW, 380);
  }

  /** Size the backing store to a square fitting the element width, then redraw. */
  layout(): void {
    const size = this.side();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  draw(): void {
    const ctx = this.ctx;
    const size = this.side();
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const innerR = size * 0.12;
    const outerR = size * 0.45;
    const radius = (i: number) => innerR + ((outerR - innerR) * i) / (EUCLID_VOICES - 1);

    for (let i = 0; i < EUCLID_VOICES; i++) {
      const r = radius(i);
      const v = this.grid.voices[i];

      // Faint guide ring for every slot so all 5 circles read even when empty.
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TWO_PI);
      ctx.strokeStyle = "#2a2d36";
      ctx.lineWidth = 1;
      ctx.stroke();

      if (!v || v.soundId < 0) continue;

      const steps = Math.max(1, v.steps);
      const pattern = euclidPattern(v.hits, steps, v.rotation);
      const active = this.playStep >= 0 ? this.playStep % steps : -1;

      for (let k = 0; k < steps; k++) {
        const a = TOP + (TWO_PI * k) / steps;
        const px = cx + r * Math.cos(a);
        const py = cy + r * Math.sin(a);
        const hit = pattern[k];

        if (hit) {
          // Radial line from the hit toward the centre, in the sound's colour.
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(px, py);
          ctx.strokeStyle = v.color;
          ctx.lineWidth = k === active ? 3 : 1.5;
          ctx.globalAlpha = k === active ? 1 : 0.7;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        // Step dot: hits are filled, rests are dim; the current step lights up.
        const isNow = k === active;
        ctx.beginPath();
        ctx.arc(px, py, isNow ? 6 : hit ? 4 : 2.5, 0, TWO_PI);
        if (isNow) ctx.fillStyle = "#ffffff";
        else if (hit) ctx.fillStyle = v.color;
        else ctx.fillStyle = "#4a4e58";
        ctx.fill();
        if (isNow) {
          ctx.strokeStyle = v.color;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }
  }
}
