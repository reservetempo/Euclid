// The Sounds view: a full parameter editor for one drum. Port of DrumEditorPanel,
// reworked: ONE global Shuffle/Back/Reset + a single Randomness amount for the whole
// drum; a Presets button that opens a grid of factory presets (each carrying its own
// shuffle range) plus the drum's saved sounds; per-param manual numeric entry that can
// exceed the preset range (clamped only to the absolute base range); and the LFO block
// split into three independent sections, each with a destination dropdown.

import { DrumKit, FreqCurve, PitchSnap } from "../model/drumKit";
import { DrumType } from "../model/drums";
import {
  ParamId, ParamGroup, NUM_PARAMS, getParamGroup, getParamGroupName,
} from "../model/params";
import { getParamSpec, formatValue, isDiscrete } from "../model/paramSpec";
import { FACTORY_PRESETS, Preset } from "../model/presets";

const ALL_GROUPS = [
  ParamGroup.Tone, ParamGroup.Amp, ParamGroup.Filter, ParamGroup.Lfo, ParamGroup.Fx,
  ParamGroup.Life, ParamGroup.Output,
];

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
// note of the current grid's key (root + scale).
export const SNAP_OPTIONS: { label: string; snap: PitchSnap }[] = [
  { label: "Off", snap: PitchSnap.Off },
  { label: "Semitone", snap: PitchSnap.Chromatic },
  { label: "Key", snap: PitchSnap.Key },
];

/** A 6-char shareable seed for a shuffle (shown after every roll). */
export function randomSeed(): string {
  let s = "";
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L look-alikes
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export interface SoundViewCallbacks {
  onChange: (drum: DrumType) => void;      // a value changed -> resend live params
  onRangeChange: (drum: DrumType) => void; // ranges changed -> resend pitch ranges
  onAudition: (drum: DrumType) => void;    // preview the sound
  // Key + tempo context for the shuffle (Key snap + synced-echo length estimates).
  context?: () => { root: number; scale: number; bpm: number };
}

export class SoundView {
  readonly el = document.createElement("div");
  private randomness = 1.0; // single global shuffle amount (1 = uniform over range)
  private curveIdx = 1; // index into CURVE_OPTIONS (1 = Logarithmic, default)
  private maxLenIdx = 0; // index into MAXLEN_OPTIONS (0 = Off, no length cap)
  private snapIdx = 0;  // index into SNAP_OPTIONS (0 = Off, free Hz)
  private seedText = ""; // user-entered seed ("" = roll a fresh one per shuffle)
  private lastSeed = ""; // the seed the last shuffle actually used (shareable)
  private rolled = false; // one-shot: spin the die on the rebuild right after a shuffle

  constructor(
    private kit: DrumKit,
    private drum: DrumType,
    private cb: SoundViewCallbacks
  ) {
    this.el.className = "soundview";
    this.build();
  }

  private params() {
    return this.kit.get(this.drum);
  }

  private paramsInGroup(g: ParamGroup): ParamId[] {
    const out: ParamId[] = [];
    for (let i = 0; i < NUM_PARAMS; i++) {
      const id = i as ParamId;
      if (getParamGroup(id) === g) out.push(id);
    }
    return out;
  }

  private build(): void {
    this.el.innerHTML = "";
    this.el.append(this.shuffleSection());
    this.el.append(this.jsonBox());
    // The full per-parameter editor is always shown (no "weeds" toggle) — this view is
    // opened deliberately via a voice's "Full Parameters" button.
    for (const g of ALL_GROUPS) this.el.append(this.category(g));
  }

  // Presets: a single button labelled with the active preset's name + colour; tapping it
  // opens the grid of factory presets (no Save/Saved — this editor works live).
  private presetRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "sound-lib";

    const presetBtn = mkBtn(this.params().presetName(), "cat-btn preset-name-btn");
    const col = this.params().presetColor();
    presetBtn.style.background = col;
    presetBtn.style.color = textOn(col);
    presetBtn.style.borderColor = "transparent";
    presetBtn.onclick = () => this.openPresetGrid(presetBtn);

    row.append(presetBtn);
    return row;
  }

  // Grid overlay of every factory preset.
  private openPresetGrid(anchor: HTMLElement): void {
    const existing = this.el.querySelector(".preset-grid");
    if (existing) { existing.remove(); return; }

    const panel = document.createElement("div");
    panel.className = "preset-grid";

    let tileIdx = 0;
    const addTile = (label: string, color: string | null, onPick: () => void) => {
      const b = document.createElement("button");
      b.className = "preset-tile";
      b.textContent = label;
      b.style.setProperty("--i", String(tileIdx++)); // staggered pop-in
      if (color) {
        b.style.background = color;
        b.style.color = textOn(color);
        b.style.borderColor = "transparent";
      }
      b.onclick = () => { panel.remove(); onPick(); };
      panel.append(b);
    };

    for (const p of FACTORY_PRESETS) {
      addTile(p.name, p.color, () => this.applyPreset(p));
    }

    anchor.parentElement?.append(panel);
    // Dismiss on the next outside tap.
    const close = (ev: PointerEvent) => {
      if (!panel.contains(ev.target as Node) && ev.target !== anchor) {
        panel.remove();
        document.removeEventListener("pointerdown", close, true);
      }
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  }

  private applyPreset(p: Preset): void {
    this.kit.applyPreset(this.drum, p);
    this.afterReplace();
  }

  // After a whole-sound replacement (preset/saved/shuffle/reset/back): resend params
  // + pitch range, audition, and rebuild (values + Back-enabled state).
  private afterReplace(): void {
    this.cb.onChange(this.drum);
    this.cb.onRangeChange(this.drum);
    this.cb.onAudition(this.drum);
    this.build();
  }

  // The redesigned top of the Sounds view: a big primary Shuffle button, the recap
  // string right beneath it, then the preset/Saved/Save row and the rest of the
  // shuffle controls (Back/Reset, Randomness, Spread, Max len).
  private shuffleSection(): HTMLElement {
    const drum = this.drum;
    const sec = document.createElement("section");
    sec.className = "cat shuffle-section";

    const shuffle = mkBtn(" Shuffle", "shuffle-big");
    const dice = document.createElement("span");
    dice.className = "dice" + (this.rolled ? " rolled" : "");
    dice.textContent = "🎲";
    shuffle.prepend(dice);
    this.rolled = false;
    shuffle.onclick = () => {
      const ctx = this.cb.context?.() ?? { root: 0, scale: 0, bpm: 120 };
      // A typed seed repeats exactly (at 100% randomness); empty rolls a fresh one.
      const seed = this.seedText.trim() || randomSeed();
      this.lastSeed = seed;
      this.kit.shuffleAll(drum, {
        randomness: this.randomness,
        curve: CURVE_OPTIONS[this.curveIdx].curve,
        maxLen: MAXLEN_OPTIONS[this.maxLenIdx].seconds,
        bpm: ctx.bpm,
        snap: SNAP_OPTIONS[this.snapIdx].snap,
        root: ctx.root,
        scale: ctx.scale,
        seed,
      });
      this.rolled = true;
      this.afterReplace();
    };
    sec.append(shuffle);

    // Recap of the current sound, directly under the Shuffle button (▶ re-auditions).
    const sum = document.createElement("div");
    sum.className = "shuffle-summary";
    const play = mkBtn("▶", "summary-play");
    play.title = "Play sound";
    play.onclick = () => this.cb.onAudition(drum);
    const txt = document.createElement("span");
    txt.textContent = this.shuffleSummary();
    sum.append(play, txt);
    sec.append(sum);

    // Back / Reset.
    const br = document.createElement("div");
    br.className = "sound-lib";
    const back = mkBtn("Back", "cat-btn");
    const reset = mkBtn("Reset", "cat-btn");
    back.disabled = !this.kit.canBack(drum);
    back.onclick = () => { if (this.kit.backAll(drum)) this.afterReplace(); };
    reset.onclick = () => { this.kit.resetAll(drum); this.afterReplace(); };
    br.append(back, reset);
    sec.append(br);

    // Randomness amount.
    const rnd = document.createElement("div");
    rnd.className = "rnd";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(Math.round(this.randomness * 100));
    const lbl = document.createElement("span");
    lbl.className = "rnd-lbl";
    lbl.textContent = `${slider.value}%`;
    slider.oninput = () => {
      this.randomness = Number(slider.value) / 100;
      lbl.textContent = `${slider.value}%`;
    };
    rnd.append(slider, lbl);
    sec.append(rnd);

    // Spread (frequency distribution) + Max length cap + Pitch snap + Seed.
    sec.append(this.selectRow("Spread", CURVE_OPTIONS.map((o) => o.label), this.curveIdx, (i) => { this.curveIdx = i; }));
    sec.append(this.selectRow("Max len", MAXLEN_OPTIONS.map((o) => o.label), this.maxLenIdx, (i) => { this.maxLenIdx = i; }));
    sec.append(this.selectRow("Snap", SNAP_OPTIONS.map((o) => o.label), this.snapIdx, (i) => { this.snapIdx = i; }));
    sec.append(this.seedRow());

    // Preset (named + coloured) / Save / Saved — at the bottom of the shuffle div.
    sec.append(this.presetRow());

    return sec;
  }

  // Seed row: type a seed to repeat a shuffle exactly (best at 100% randomness);
  // leave it empty and every roll shows the fresh seed it used, ready to share.
  private seedRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "precision";
    const lbl = document.createElement("span");
    lbl.className = "precision-lbl";
    lbl.textContent = "Seed";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "vbox-num seed-input";
    input.placeholder = this.lastSeed ? `last: ${this.lastSeed}` : "random";
    input.value = this.seedText;
    input.onchange = () => { this.seedText = input.value; };
    row.append(lbl, input);
    return row;
  }

  // A labelled <select> row (used for Spread + Max len).
  private selectRow(label: string, options: string[], value: number, onChange: (i: number) => void): HTMLElement {
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

  // The shuffle-generated JSON for the current sound, shown above "Get in the weeds".
  // Refreshes on every shuffle / Back / preset / Reset (build() re-renders it).
  private jsonBox(): HTMLElement {
    const sec = document.createElement("section");
    sec.className = "cat json-box";
    const head = document.createElement("div");
    head.className = "cat-head";
    const name = document.createElement("span");
    name.className = "cat-name";
    name.textContent = "Sound JSON";
    const copy = mkBtn("Copy", "cat-btn json-copy");
    copy.onclick = () => {
      navigator.clipboard?.writeText(this.soundJson());
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1200);
    };
    head.append(name, copy);
    sec.append(head);
    const pre = document.createElement("pre");
    pre.className = "json-pre";
    pre.textContent = this.soundJson();
    sec.append(pre);
    return sec;
  }

  // The current sound as a JSON object keyed by parameter name.
  private soundJson(): string {
    const p = this.params();
    const obj: Record<string, number> = {};
    for (let i = 0; i < NUM_PARAMS; i++) {
      obj[ParamId[i]] = Math.round(p.get(i as ParamId) * 1e4) / 1e4;
    }
    return JSON.stringify(obj, null, 2);
  }

  // Compact recap of the main settings shaping the current sound: wave, pitch, the
  // noise colour, every active effect/filter/LFO by name, then the amp tail length.
  // e.g. "Square · 159 · Pink · Ring · Comb · Filter · 0.8s".
  private shuffleSummary(): string {
    return this.kit.get(this.drum).describe().join(" · ");
  }

  private category(g: ParamGroup): HTMLElement {
    const sec = document.createElement("section");
    sec.className = "cat";

    const head = document.createElement("div");
    head.className = "cat-head";
    const name = document.createElement("span");
    name.className = "cat-name";
    name.textContent = getParamGroupName(g);
    head.append(name);
    sec.append(head);

    if (g === ParamGroup.Lfo) {
      sec.append(this.lfoSections());
    } else {
      const body = document.createElement("div");
      body.className = "cat-params";
      for (const id of this.paramsInGroup(g)) body.append(this.valueBox(id));
      sec.append(body);
    }
    return sec;
  }

  // The LFO params rendered as three labelled sub-sections (Dest + Shape + Rate +
  // Amt each). Listed explicitly because Shape was appended at the param tail and
  // so is not adjacent to its LFO's other params in index order.
  private lfoSections(): HTMLElement {
    const blocks: ParamId[][] = [
      [ParamId.LfoTarget, ParamId.Lfo1Shape, ParamId.LfoRate, ParamId.LfoDepth],
      [ParamId.Lfo2Target, ParamId.Lfo2Shape, ParamId.Lfo2Rate, ParamId.Lfo2Depth],
      [ParamId.Lfo3Target, ParamId.Lfo3Shape, ParamId.Lfo3Rate, ParamId.Lfo3Depth],
    ];
    const wrap = document.createElement("div");
    wrap.className = "lfo-sections";
    blocks.forEach((ids, n) => {
      const block = document.createElement("div");
      block.className = "lfo-block";
      const h = document.createElement("div");
      h.className = "lfo-head";
      h.textContent = `LFO ${n + 1}`;
      block.append(h);
      const body = document.createElement("div");
      body.className = "cat-params";
      for (const id of ids) body.append(this.valueBox(id));
      block.append(body);
      wrap.append(block);
    });
    return wrap;
  }

  private valueBox(id: ParamId): HTMLElement {
    const drum = this.drum;
    const params = this.params();
    const s = getParamSpec(drum, id);

    const box = document.createElement("div");
    box.className = "vbox";

    const top = document.createElement("div");
    top.className = "vbox-top";
    const nm = document.createElement("span");
    nm.className = "vbox-name";
    nm.textContent = s.name;
    const val = document.createElement("span");
    val.className = "vbox-val";
    val.textContent = formatValue(s, params.get(id));
    top.append(nm, val);
    box.append(top);

    if (isDiscrete(s)) {
      const sel = document.createElement("select");
      sel.className = "vbox-select";
      s.choices!.forEach((c, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = c;
        sel.append(o);
      });
      sel.value = String(Math.round(params.get(id)));
      sel.onchange = () => {
        params.set(id, Number(sel.value));
        val.textContent = formatValue(s, params.get(id));
        this.cb.onChange(drum);
        this.cb.onAudition(drum);
      };
      box.append(sel);
      return box;
    }

    // Continuous: a slider spanning the LIVE (preset) range, plus a numeric input
    // that accepts out-of-range values (clamped only to the absolute base range).
    const lo = params.loOf(id);
    const hi = params.hiOf(id);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1";
    slider.step = "0.001";
    slider.value = String(normFromRange(lo, hi, s.skew, params.get(id)));

    const num = document.createElement("input");
    num.type = "number";
    num.className = "vbox-num";
    if (s.step > 0) num.step = String(s.step);
    num.value = trim(params.get(id));

    const sync = () => {
      val.textContent = formatValue(s, params.get(id));
      num.value = trim(params.get(id));
      slider.value = String(normFromRange(lo, hi, s.skew, params.get(id)));
    };

    slider.oninput = () => {
      params.set(id, valueFromRange(lo, hi, s.skew, s.step, Number(slider.value)));
      val.textContent = formatValue(s, params.get(id));
      num.value = trim(params.get(id));
      this.cb.onChange(drum);
    };
    slider.onchange = () => this.cb.onAudition(drum);

    num.onchange = () => {
      const v = Number(num.value);
      if (!Number.isNaN(v)) params.set(id, v); // DrumParameters clamps to the base range
      sync();
      this.cb.onChange(drum);
      this.cb.onAudition(drum);
    };

    const ctl = document.createElement("div");
    ctl.className = "vbox-ctl";
    ctl.append(slider, num);
    box.append(ctl);
    return box;
  }
}

function mkBtn(text: string, cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = cls;
  return b;
}

// Round a value for the numeric box without trailing-zero noise.
function trim(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

// Pick black or white text for readability on a given hex background.
function textOn(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#15161a" : "#ffffff";
}

// Skew-aware slider mapping over an explicit [lo,hi] window (mirrors the paramSpec
// helpers but uses the live preset range instead of the static spec min/max).
function normFromRange(lo: number, hi: number, skew: number, value: number): number {
  const range = hi - lo;
  if (range <= 0) return 0;
  const p = Math.min(1, Math.max(0, (value - lo) / range));
  return skew === 1 ? p : Math.pow(p, skew);
}

function valueFromRange(lo: number, hi: number, skew: number, step: number, norm: number): number {
  let p = Math.min(1, Math.max(0, norm));
  if (skew !== 1) p = Math.pow(p, 1 / skew);
  let v = lo + (hi - lo) * p;
  if (step > 0) v = Math.round(v / step) * step;
  return Math.min(hi, Math.max(lo, v));
}
