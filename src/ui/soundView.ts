// The deep sound editor for one loop's sound, opened via "Full Parameters": a tab bar
// over the sections — the shuffle section (one global Shuffle + Randomness/Spread/
// Max-len/Snap/Seed), each parameter category, and the sound's JSON — showing ONE
// section at a time instead of a long scroll. Values edit live; manual numeric entry
// may exceed the preset range (clamped only to the absolute base range).

import { DrumKit } from "../model/drumKit";
import { DrumType } from "../model/drums";
import {
  ParamId, ParamGroup, NUM_PARAMS, getParamGroup, getParamGroupName,
} from "../model/params";
import { getParamSpec, formatValue, isDiscrete } from "../model/paramSpec";
import { FACTORY_PRESETS, Preset } from "../model/presets";
import {
  CURVE_OPTIONS, MAXLEN_OPTIONS, SNAP_OPTIONS,
  defaultShuffleSettings, shuffleOptions, randomSeed,
  mkBtn, textOn, selectRow, seedRow, randomnessRow, shuffleButton,
} from "./controls";

// The tab bar over the editor's sections: Shuffle first (the main page), then the
// parameter categories, JSON last. Labels are short so the pills wrap tidily.
type SoundTab = "shuffle" | "json" | ParamGroup;
const SOUND_TABS: { key: SoundTab; label: string }[] = [
  { key: "shuffle",          label: "Shuffle" },
  { key: ParamGroup.Tone,    label: "Tone" },
  { key: ParamGroup.Amp,     label: "Amp" },
  { key: ParamGroup.Filter,  label: "Filter" },
  { key: ParamGroup.Lfo,     label: "LFO" },
  { key: ParamGroup.Fx,      label: "FX" },
  { key: ParamGroup.Life,    label: "Life" },
  { key: ParamGroup.Output,  label: "Out" },
  { key: "json",             label: "JSON" },
];

export interface SoundViewCallbacks {
  onChange: (drum: DrumType) => void;      // a value changed -> resend live params
  onRangeChange: (drum: DrumType) => void; // ranges changed -> resend pitch ranges
  onAudition: (drum: DrumType) => void;    // preview the sound
  // Key + tempo context for the shuffle (Key snap + synced-echo length estimates).
  context?: () => { root: number; scale: number; bpm: number };
}

export class SoundView {
  readonly el = document.createElement("div");
  private st = defaultShuffleSettings();
  private rolled = false; // one-shot: spin the die on the rebuild right after a shuffle
  private tab: SoundTab = "shuffle"; // active section (kept across live-edit rebuilds)

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
    this.el.append(this.tabNav());
    if (this.tab === "shuffle") this.el.append(this.shuffleSection());
    else if (this.tab === "json") this.el.append(this.jsonBox());
    else this.el.append(this.category(this.tab));
  }

  // The wrapping pill bar picking which section shows (same segmented style as the
  // loop popup's nav, in this editor's own accent).
  private tabNav(): HTMLElement {
    const nav = document.createElement("div");
    nav.className = "placement-seg sound-nav";
    for (const t of SOUND_TABS) {
      const b = mkBtn(t.label, "seg-btn" + (this.tab === t.key ? " on" : ""));
      b.onclick = () => { if (this.tab !== t.key) { this.tab = t.key; this.build(); } };
      nav.append(b);
    }
    return nav;
  }

  // Presets: a single button labelled with the active preset's name + colour (Full
  // Range by default); tapping it opens the grid of factory presets. Sits in the
  // Back/Reset row, small like those buttons.
  private presetButton(): HTMLButtonElement {
    const presetBtn = mkBtn(this.params().presetName(), "cat-btn preset-name-btn");
    const col = this.params().presetColor();
    presetBtn.style.background = col;
    presetBtn.style.color = textOn(col);
    presetBtn.style.borderColor = "transparent";
    presetBtn.onclick = () => this.openPresetGrid(presetBtn);
    return presetBtn;
  }

  // Grid overlay of every factory preset.
  private openPresetGrid(anchor: HTMLElement): void {
    const existing = this.el.querySelector(".preset-grid");
    if (existing) { existing.remove(); return; }

    const panel = document.createElement("div");
    panel.className = "preset-grid";

    FACTORY_PRESETS.forEach((p, i) => {
      const b = document.createElement("button");
      b.className = "preset-tile";
      b.textContent = p.name;
      b.style.setProperty("--i", String(i)); // staggered pop-in
      b.style.background = p.color;
      b.style.color = textOn(p.color);
      b.style.borderColor = "transparent";
      b.onclick = () => { panel.remove(); this.applyPreset(p); };
      panel.append(b);
    });

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

  // After a whole-sound replacement (preset/shuffle/reset/back): resend params
  // + pitch range, audition, and rebuild (values + Back-enabled state).
  private afterReplace(): void {
    this.cb.onChange(this.drum);
    this.cb.onRangeChange(this.drum);
    this.cb.onAudition(this.drum);
    this.build();
  }

  // The top of the view: a big primary Shuffle button, the recap string right
  // beneath it, the Back/Reset/preset row, then the rest of the shuffle controls.
  private shuffleSection(): HTMLElement {
    const drum = this.drum;
    const sec = document.createElement("section");
    sec.className = "cat shuffle-section";

    const shuffle = shuffleButton(this.rolled);
    this.rolled = false;
    shuffle.onclick = () => {
      const ctx = this.cb.context?.() ?? { root: 0, scale: 0, bpm: 120 };
      // A typed seed repeats exactly (at 100% randomness); empty rolls a fresh one.
      const seed = this.st.seedText.trim() || randomSeed();
      this.st.lastSeed = seed;
      this.kit.shuffleAll(drum, shuffleOptions(this.st, ctx, seed));
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

    // Back / Reset / Preset — one small-button row.
    const br = document.createElement("div");
    br.className = "sound-lib";
    const back = mkBtn("Back", "cat-btn");
    const reset = mkBtn("Reset", "cat-btn");
    back.disabled = !this.kit.canBack(drum);
    back.onclick = () => { if (this.kit.backAll(drum)) this.afterReplace(); };
    reset.onclick = () => { this.kit.resetAll(drum); this.afterReplace(); };
    br.append(back, reset, this.presetButton());
    sec.append(br);

    sec.append(randomnessRow(this.st));
    sec.append(selectRow("Spread", CURVE_OPTIONS.map((o) => o.label), this.st.curveIdx, (i) => { this.st.curveIdx = i; }));
    sec.append(selectRow("Max len", MAXLEN_OPTIONS.map((o) => o.label), this.st.maxLenIdx, (i) => { this.st.maxLenIdx = i; }));
    sec.append(selectRow("Snap", SNAP_OPTIONS.map((o) => o.label), this.st.snapIdx, (i) => { this.st.snapIdx = i; }));
    sec.append(seedRow(this.st));

    return sec;
  }

  // The current sound as JSON, refreshed by every build() (shuffle/Back/preset/Reset).
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
  // Sync + Amt each). Listed explicitly because Shape/Sync were appended at the
  // param tail and so are not adjacent to their LFO's other params in index order.
  // Rate only applies while Sync = Free; a division overrides it with a beat-locked
  // cycle length (like the echo's sync).
  private lfoSections(): HTMLElement {
    const blocks: ParamId[][] = [
      [ParamId.LfoTarget, ParamId.Lfo1Shape, ParamId.LfoRate, ParamId.Lfo1Sync, ParamId.LfoDepth],
      [ParamId.Lfo2Target, ParamId.Lfo2Shape, ParamId.Lfo2Rate, ParamId.Lfo2Sync, ParamId.Lfo2Depth],
      [ParamId.Lfo3Target, ParamId.Lfo3Shape, ParamId.Lfo3Rate, ParamId.Lfo3Sync, ParamId.Lfo3Depth],
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

// Round a value for the numeric box without trailing-zero noise.
function trim(v: number): string {
  return String(Math.round(v * 1000) / 1000);
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
