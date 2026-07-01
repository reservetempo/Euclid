// Canvas paint grid for ONE melody pattern (16 steps x 5 rows). The 16 steps are
// drawn as two stacked 8-wide panels (steps 0-7 on top, 8-15 below) so the cells
// stay finger-sized on a narrow phone screen. Touch-first: tap/drag to paint the
// active drum, tap a painted cell of the active drum to erase it (toggle). Cells
// are small with rounded corners; a 4-step separator and the playhead are drawn.

import { MelodyGrid, NUM_ROWS, NUM_STEPS, EMPTY } from "../model/melodyGrid";
import { drumColour } from "../model/drums";

const STEPS_PER_PANEL = 8;
const PANELS = Math.ceil(NUM_STEPS / STEPS_PER_PANEL); // two stacked grids
const ROW_H = 30; // px per row (smaller cells)
const PANEL_GAP = 14; // vertical gap between the two stacked grids
const CELL_PAD = 2; // gap between cells
const RADIUS = 6; // rounded cell corners

export class GridView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private grid: MelodyGrid;
  private activeDrum = -1; // -1 = no lane selected; painting disabled
  private playCol = -1;

  /** Called after a cell edit so the host can resend the grid to the engine. */
  onEdit: (() => void) | null = null;

  /** Cell fill colour for a channel index. Host overrides this to colour by lane. */
  colorForDrum: (drum: number) => string = drumColour;

  private cellW = 20;
  private painting = false;
  private erase = false;
  private lastRow = -1;
  private lastStep = -1;

  constructor(grid: MelodyGrid) {
    this.grid = grid;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "grid-canvas";
    this.canvas.style.touchAction = "none"; // we handle drag; don't scroll
    this.ctx = this.canvas.getContext("2d")!;

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
  }

  setBlock(grid: MelodyGrid): void {
    this.grid = grid;
    this.draw();
  }

  setActiveDrum(drum: number): void {
    this.activeDrum = drum;
  }

  setPlayhead(col: number): void {
    if (col === this.playCol) return;
    this.playCol = col;
    this.draw();
  }

  private panelTop(panel: number): number {
    return panel * (NUM_ROWS * ROW_H + PANEL_GAP);
  }

  /** Size the backing store to the element's CSS width and redraw. */
  layout(): void {
    const cssW = this.canvas.clientWidth || 360;
    const cssH = PANELS * NUM_ROWS * ROW_H + (PANELS - 1) * PANEL_GAP;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cellW = cssW / STEPS_PER_PANEL;
    this.draw();
  }

  // --- painting ---------------------------------------------------------
  private cellAt(e: PointerEvent): { row: number; step: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0) return null;

    const panelH = NUM_ROWS * ROW_H;
    const stride = panelH + PANEL_GAP;
    const panel = Math.floor(y / stride);
    if (panel < 0 || panel >= PANELS) return null;
    const yIn = y - panel * stride;
    if (yIn >= panelH) return null; // in the gap between panels

    const col = Math.floor(x / this.cellW);
    const rowIn = Math.floor(yIn / ROW_H);
    const step = panel * STEPS_PER_PANEL + col;
    return MelodyGrid.isValid(rowIn, step) ? { row: rowIn, step } : null;
  }

  private apply(row: number, step: number): void {
    this.grid.setCell(row, step, this.erase ? EMPTY : this.activeDrum);
    this.lastRow = row;
    this.lastStep = step;
    this.onEdit?.();
    this.draw();
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.activeDrum < 0) return; // no lane selected -> nothing to paint
    const c = this.cellAt(e);
    if (!c) return;
    e.preventDefault();
    // Toggle: if the cell already holds the active drum, this stroke erases.
    this.erase = this.grid.getCell(c.row, c.step) === this.activeDrum;
    this.painting = true;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.apply(c.row, c.step);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.painting) return;
    const c = this.cellAt(e);
    if (c && (c.row !== this.lastRow || c.step !== this.lastStep)) {
      this.apply(c.row, c.step);
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.painting) return;
    this.painting = false;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  // --- drawing ----------------------------------------------------------
  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  draw(): void {
    const ctx = this.ctx;
    const g = this.grid;
    const cssW = this.canvas.clientWidth || 360;
    const totalH = PANELS * NUM_ROWS * ROW_H + (PANELS - 1) * PANEL_GAP;

    ctx.clearRect(0, 0, cssW, totalH);

    for (let step = 0; step < NUM_STEPS; step++) {
      const panel = Math.floor(step / STEPS_PER_PANEL);
      const col = step % STEPS_PER_PANEL;
      const top = this.panelTop(panel);

      for (let row = 0; row < NUM_ROWS; row++) {
        const x = col * this.cellW;
        const y = top + row * ROW_H;
        const drum = g.getCell(row, step);

        // Subtle separator before each new bar (every 4 steps).
        const isBarStart = col % 4 === 0 && col !== 0;
        this.roundRect(
          x + CELL_PAD, y + CELL_PAD,
          this.cellW - CELL_PAD * 2, ROW_H - CELL_PAD * 2, RADIUS,
        );
        ctx.fillStyle = drum >= 0 ? this.colorForDrum(drum) : "#23252b";
        ctx.fill();
        if (isBarStart) {
          ctx.strokeStyle = "#3a3d46";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    // Playhead column (playCol is a 0..NUM_STEPS-1 step index).
    if (this.playCol >= 0) {
      const panel = Math.floor(this.playCol / STEPS_PER_PANEL);
      const col = this.playCol % STEPS_PER_PANEL;
      const top = this.panelTop(panel);
      const x = col * this.cellW;
      this.roundRect(x + 1, top + 1, this.cellW - 2, NUM_ROWS * ROW_H - 2, RADIUS);
      ctx.strokeStyle = "#ffd60a";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }
}
