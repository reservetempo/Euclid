// Small shared UI pieces + the option lists the shuffle controls render: Spread / Max len
// / Snap. The settings themselves live on the SoundDraft being edited, as real values —
// these tables are only the labels and the index↔value mapping a <select> needs.

import { FreqCurve, PitchSnap, SoundDraft } from "../model/sound";

// Shuffle frequency spread: how Pitch & Filter Cutoff are randomly distributed.
// "Linear" is uniform in Hz (high-heavy); the others spread the draw the way the
// ear hears pitch (logarithmically). See FreqCurve.
export const CURVE_OPTIONS: { label: string; curve: FreqCurve }[] = [
  { label: "Linear", curve: FreqCurve.Linear },
  { label: "Logarithmic", curve: FreqCurve.Log },
  { label: "Bass", curve: FreqCurve.GaussLow },
  { label: "Mid", curve: FreqCurve.GaussMid },
  { label: "High", curve: FreqCurve.GaussHigh },
];

// Max audible length for a shuffled sound (0 = off). The shuffle trims FX tails,
// then the amp body, so the estimated length fits — keeps drum hits punchy.
export const MAXLEN_OPTIONS: { label: string; seconds: number }[] = [
  { label: "Off", seconds: 0 },
  { label: "0.1s", seconds: 0.1 },
  { label: "0.2s", seconds: 0.2 },
  { label: "0.3s", seconds: 0.3 },
  { label: "0.5s", seconds: 0.5 },
  { label: "0.75s", seconds: 0.75 },
  { label: "1s", seconds: 1 },
  { label: "1.5s", seconds: 1.5 },
  { label: "2s", seconds: 2 },
];

// Pitch quantisation for shuffled sounds: free Hz, nearest semitone, or the nearest
// note of the track's key (root + scale).
export const SNAP_OPTIONS: { label: string; snap: PitchSnap }[] = [
  { label: "Off", snap: PitchSnap.Off },
  { label: "Semitone", snap: PitchSnap.Chromatic },
  { label: "Key", snap: PitchSnap.Key },
];

/** Which CURVE_OPTIONS row holds `curve` (0 if it somehow isn't listed) — the selects
    are index-based, the draft stores the value itself. */
export function curveOptionIndex(curve: FreqCurve): number {
  const i = CURVE_OPTIONS.findIndex((o) => o.curve === curve);
  return i < 0 ? 0 : i;
}

/** Which MAXLEN_OPTIONS row holds `seconds` (0 = "Off" if it isn't listed). */
export function maxLenOptionIndex(seconds: number): number {
  const i = MAXLEN_OPTIONS.findIndex((o) => o.seconds === seconds);
  return i < 0 ? 0 : i;
}

export function mkBtn(text: string, cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = cls;
  return b;
}

/** Black or white text for readability on a given hex background. */
export function textOn(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#0b0d12" : "#ffffff";
}

/** A labelled <select> row (Spread / Max len / Snap). */
export function selectRow(label: string, options: string[], value: number, onChange: (i: number) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "precision";
  const lbl = document.createElement("span");
  lbl.className = "precision-lbl";
  lbl.textContent = label;
  const sel = document.createElement("select");
  sel.className = "vbox-select";
  options.forEach((o, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = o;
    sel.append(opt);
  });
  sel.value = String(value);
  sel.onchange = () => onChange(Number(sel.value));
  row.append(lbl, sel);
  return row;
}

/** Seed row: type a seed to repeat a shuffle exactly (best at 100% randomness);
    empty = fresh roll each time, with the used seed shown as the placeholder. */
export function seedRow(st: SoundDraft): HTMLElement {
  const row = document.createElement("div");
  row.className = "precision";
  const lbl = document.createElement("span");
  lbl.className = "precision-lbl";
  lbl.textContent = "Seed";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "vbox-num seed-input";
  input.placeholder = st.lastSeed ? `last: ${st.lastSeed}` : "random";
  input.value = st.seedText;
  input.onchange = () => { st.seedText = input.value; };
  row.append(lbl, input);
  return row;
}

/** The Randomness amount slider row. */
export function randomnessRow(st: SoundDraft): HTMLElement {
  const rnd = document.createElement("div");
  rnd.className = "rnd";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.value = String(Math.round(st.randomness * 100));
  const lbl = document.createElement("span");
  lbl.className = "rnd-lbl";
  lbl.textContent = `${slider.value}%`;
  slider.oninput = () => {
    st.randomness = Number(slider.value) / 100;
    lbl.textContent = `${slider.value}%`;
  };
  rnd.append(slider, lbl);
  return rnd;
}

/** Skew-aware slider mapping over an explicit [lo,hi] range (mirrors the paramSpec
    helpers). Shared by the deep editor's value boxes and the per-loop menu's
    single-param sliders (e.g. Gate). */
export function normFromRange(lo: number, hi: number, skew: number, value: number): number {
  const range = hi - lo;
  if (range <= 0) return 0;
  const p = Math.min(1, Math.max(0, (value - lo) / range));
  return skew === 1 ? p : Math.pow(p, skew);
}

export function valueFromRange(lo: number, hi: number, skew: number, step: number, norm: number): number {
  let p = Math.min(1, Math.max(0, norm));
  if (skew !== 1) p = Math.pow(p, 1 / skew);
  let v = lo + (hi - lo) * p;
  if (step > 0) v = Math.round(v / step) * step;
  return Math.min(hi, Math.max(lo, v));
}

/** The big primary Shuffle button with its idle-wiggling die. Pass `rolled` to spin
    the die once (the render right after a shuffle). */
export function shuffleButton(rolled: boolean): HTMLButtonElement {
  const b = mkBtn(" Shuffle", "shuffle-big");
  const dice = document.createElement("span");
  dice.className = "dice" + (rolled ? " rolled" : "");
  dice.textContent = "🎲";
  b.prepend(dice);
  return b;
}
