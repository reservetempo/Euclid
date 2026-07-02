// The Euclid wordmark, drawn the way the sequencer draws rhythms: dots joined by
// thin lines, one voice colour per letter (6 letters = 6 voices). Each letter is
// its own small SVG so the start screen's per-letter bounce/bob animations still
// apply; the top bar renders the same letterforms without the animation classes.

import { VOICE_COLORS } from "../model/lines";

type Pt = [number, number];

// Letterforms on a 0..10 grid (y down, baseline at 10, x-height at 3). Each letter
// is a set of polylines; a dot is drawn at every polyline point (plus lone extras
// like the i's tittle), echoing the circle view's hit-dots-with-lines look.
interface LetterForm {
  w: number; // advance width in grid units
  lines: Pt[][];
  extraDots?: Pt[];
}

const LETTERS: LetterForm[] = [
  // E
  { w: 4.5, lines: [[[4.5, 0], [0, 0], [0, 5], [0, 10], [4.5, 10]], [[0, 5], [3.2, 5]]] },
  // u
  { w: 4, lines: [[[0, 3], [0, 7.5], [1.2, 9.6], [2.8, 9.6], [4, 7.5], [4, 3]]] },
  // c
  { w: 4.2, lines: [[[4, 4], [2.2, 3], [0.6, 4.4], [0, 6.5], [0.6, 8.6], [2.2, 10], [4, 9]]] },
  // l
  { w: 1, lines: [[[0.5, 0], [0.5, 5], [0.5, 10]]] },
  // i
  { w: 1, lines: [[[0.5, 3.5], [0.5, 6.75], [0.5, 10]]], extraDots: [[0.5, 0.9]] },
  // d
  { w: 4.2, lines: [[[4.2, 0], [4.2, 10]], [[4.2, 4.2], [2.2, 3], [0.6, 4.4], [0, 6.5], [0.6, 8.6], [2.2, 10], [4.2, 8.8]]] },
];

const PAD = 1.1;       // viewBox padding so edge dots aren't clipped
const GRID_H = 10;     // cap height in grid units
const DOT_R = 0.62;    // dot radius (dots ~2x the line weight, like the circle view)
const LINE_W = 0.3;
const LINE_ALPHA = 0.72; // lines sit back, dots pop — mirrors the canvas hit lines

const SVG_NS = "http://www.w3.org/2000/svg";

function letterSvg(form: LetterForm, colour: string, heightPx: number): SVGSVGElement {
  const vbW = form.w + PAD * 2;
  const vbH = GRID_H + PAD * 2;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `${-PAD} ${-PAD} ${vbW} ${vbH}`);
  svg.setAttribute("width", `${(heightPx * vbW) / vbH}`);
  svg.setAttribute("height", `${heightPx}`);
  svg.classList.add("logo-svg");

  for (const line of form.lines) {
    const pl = document.createElementNS(SVG_NS, "polyline");
    pl.setAttribute("points", line.map(([x, y]) => `${x},${y}`).join(" "));
    pl.setAttribute("fill", "none");
    pl.setAttribute("stroke", colour);
    pl.setAttribute("stroke-width", String(LINE_W));
    pl.setAttribute("stroke-linecap", "round");
    pl.setAttribute("stroke-linejoin", "round");
    pl.setAttribute("opacity", String(LINE_ALPHA));
    svg.append(pl);
  }
  const dots: Pt[] = [...form.lines.flat(), ...(form.extraDots ?? [])];
  for (const [x, y] of dots) {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", String(x));
    c.setAttribute("cy", String(y));
    c.setAttribute("r", String(DOT_R));
    c.setAttribute("fill", colour);
    svg.append(c);
  }
  return svg;
}

/** The six letters of "Euclid" as spans (one per letter, voice-coloured). Pass
    `animate` to add the start screen's .logo-letter bounce/bob classes. */
export function logoLetters(heightPx: number, animate: boolean): HTMLElement[] {
  return LETTERS.map((form, i) => {
    const s = document.createElement("span");
    if (animate) {
      s.className = "logo-letter";
      s.style.setProperty("--i", String(i));
    }
    s.append(letterSvg(form, VOICE_COLORS[i % VOICE_COLORS.length], heightPx));
    return s;
  });
}
