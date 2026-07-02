// Circular visualization: 6 nested rings, one per voice LINE (inner = line 1,
// outer = line 6). Each ring shows ONE node of its line — the node being edited
// while stopped, or the node currently playing during playback — as a dot at every
// step around the circle in the node's colour, with a radial line to the centre on
// each hit. Every ring carries its own active step (lines run independent phases —
// long-form polymeter), lighting up during playback.

import { VoiceNode, NUM_LINES } from "../model/lines";
import { voicePattern } from "../model/euclid";

const TWO_PI = Math.PI * 2;
const TOP = -Math.PI / 2; // step 0 sits at 12 o'clock
const PULSE_MS = 420;     // how long a hit's swell/ripple stays visible
const PULSE_TAU = 130;    // exponential decay constant of the pulse (ms)

/** What one ring displays: a node (or nothing) + its live step (-1 when stopped). */
export interface RingState {
  node: VoiceNode | null;
  step: number;
}

export class EuclidView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rings: RingState[] = Array.from({ length: NUM_LINES }, () => ({ node: null, step: -1 }));
  // Per-ring timestamp of its last fired hit, driving the swell + ripple juice.
  private fireAt: number[] = new Array(NUM_LINES).fill(-1e9);
  private animId = 0;
  private reduceMotion =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "euclid-canvas";
    this.ctx = this.canvas.getContext("2d")!;
  }

  /** Replace what the rings display (edited nodes when stopped; live nodes + their
      per-line steps while playing) and redraw. */
  setRings(states: RingState[]): void {
    for (let i = 0; i < NUM_LINES; i++) {
      this.rings[i] = states[i] ?? { node: null, step: -1 };
    }
    this.draw();
  }

  /** Flash the rings whose sounds just fired: their active dot swells and a ripple
      ring expands outward, decaying over PULSE_MS (from the playhead handler). */
  pulse(soundIds: number[]): void {
    if (this.reduceMotion || soundIds.length === 0) return;
    const now = performance.now();
    let any = false;
    this.rings.forEach((r, i) => {
      if (r.node && r.node.soundId >= 0 && soundIds.includes(r.node.soundId)) {
        this.fireAt[i] = now;
        any = true;
      }
    });
    if (any) this.ensureAnim();
  }

  // Keep redrawing while any pulse is still visibly decaying; self-stops after.
  private ensureAnim(): void {
    if (this.animId) return;
    const tick = () => {
      this.animId = 0;
      this.draw();
      const now = performance.now();
      if (this.fireAt.some((t) => now - t < PULSE_MS)) this.animId = requestAnimationFrame(tick);
    };
    this.animId = requestAnimationFrame(tick);
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
    const radius = (i: number) => innerR + ((outerR - innerR) * i) / (NUM_LINES - 1);
    const now = performance.now();

    for (let i = 0; i < NUM_LINES; i++) {
      const r = radius(i);
      const st = this.rings[i];
      const v = st.node;

      // Faint guide ring for every slot so all 6 circles read even when empty.
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TWO_PI);
      ctx.strokeStyle = "#2a2d36";
      ctx.lineWidth = 1;
      ctx.stroke();

      if (!v || v.soundId < 0) continue;

      const steps = Math.max(1, v.steps);
      const pattern = voicePattern(v.hits, steps, v.rotation, v.split);
      const active = st.step >= 0 ? st.step % steps : -1;
      // Hit pulse: 1 right when the line fired, decaying to 0 over PULSE_MS.
      const age = now - this.fireAt[i];
      const p = age < PULSE_MS ? Math.exp(-age / PULSE_TAU) : 0;

      for (let k = 0; k < steps; k++) {
        const a = TOP + (TWO_PI * k) / steps;
        const px = cx + r * Math.cos(a);
        const py = cy + r * Math.sin(a);
        const hit = pattern[k];

        if (hit) {
          // Radial line from the hit toward the centre, in the sound's colour;
          // the firing hit's line flashes thicker while the pulse decays.
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(px, py);
          ctx.strokeStyle = v.color;
          ctx.lineWidth = k === active ? 3 + 3 * p : 1.5;
          ctx.globalAlpha = k === active ? 1 : 0.7;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        // Step dot: hits are filled, rests are dim; the current step lights up and
        // SWELLS on fire, with a ripple ring expanding outward as the pulse decays.
        const isNow = k === active;
        ctx.beginPath();
        ctx.arc(px, py, isNow ? 6 + 5 * p : hit ? 4 : 2.5, 0, TWO_PI);
        if (isNow) ctx.fillStyle = "#ffffff";
        else if (hit) ctx.fillStyle = v.color;
        else ctx.fillStyle = "#4a4e58";
        ctx.fill();
        if (isNow) {
          ctx.strokeStyle = v.color;
          ctx.lineWidth = 2;
          ctx.stroke();
          if (p > 0.02) {
            ctx.beginPath();
            ctx.arc(px, py, 8 + (1 - p) * 20, 0, TWO_PI);
            ctx.strokeStyle = v.color;
            ctx.globalAlpha = p * 0.7;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      }
    }
  }
}
