// Reading helpers over the parameter registry in params.ts — nothing is declared twice here.
// Every sound is a generic full-range sound: there is no per-drum "character" and no preset
// system, so `getParamSpec` just returns the base spec. `baseRange` gives the widest range a
// value may take (manual entry is clamped to it, and shuffle draws from it).
//
// A ParamSpec is one registry row flattened for the UI: the choice list arrives as plain
// labels, because a control only ever renders the label — what an index MEANS to the DSP is
// the worklet's business and reaches it through the generated engine-params.js.

import { DrumType } from "./drums";
import { ParamId, NUM_PARAMS, PARAMS, RealParamId, ENGINE_TABLES, choiceLabels } from "./params";

export interface ParamSpec {
  name: string;
  min: number;
  max: number;
  def: number;
  skew: number; // 1 = linear; <1 weights toward the low end
  step: number;
  unit: string;
  randomizable: boolean;
  choices?: string[]; // present => discrete
}

// Flattened once at module load: baseRange runs on every parameter write, so a spec lookup
// must not allocate.
const SPECS: ParamSpec[] = Array.from({ length: NUM_PARAMS }, (_, i) => {
  const e = PARAMS[i as RealParamId];
  const labels = e.choices?.map((c) => c.label);
  return {
    name: e.name, min: e.min, max: e.max, def: e.def,
    skew: e.skew, step: e.step, unit: e.unit,
    randomizable: e.randomizable,
    ...(labels ? { choices: labels } : {}),
  };
});

export function baseSpec(id: ParamId): ParamSpec {
  return SPECS[id];
}

// Every sound is generic full-range now — no per-drum character. The `drum` arg is kept
// only so existing callers (which pass a reference DrumType) stay unchanged.
export function getParamSpec(_drum: DrumType, id: ParamId): ParamSpec {
  return SPECS[id];
}

/** The widest range a parameter may take. Manual numeric entry is clamped to this, and
    shuffle draws from it. */
export function baseRange(id: ParamId): { min: number; max: number } {
  const s = SPECS[id];
  return { min: s.min, max: s.max };
}

/** Build the default snapshot for a drum (the array the worklet expects). */
export function defaultSnapshot(_drum: DrumType): number[] {
  const snap: number[] = new Array(NUM_PARAMS);
  for (let i = 0; i < NUM_PARAMS; i++) snap[i] = SPECS[i].def;
  return snap;
}

export function isDiscrete(s: ParamSpec): boolean {
  return !!s.choices && s.choices.length > 0;
}

// --- Choice lists, derived ----------------------------------------------------
// These name the label sets other modules reason about. They are VIEWS of the registry's
// choice lists, not copies — the labels and their DSP meanings live together in params.ts.

export const LFO_TARGETS = choiceLabels(ParamId.Lfo1Target);
/** Index of the "disable this LFO" destination — it sits last in the list. */
export const LFO_NONE = LFO_TARGETS.indexOf("None");

export const NOISE_TYPES = choiceLabels(ParamId.NoiseType);
export const OSC_MOD_TYPES = choiceLabels(ParamId.OscModType);
export const CLICK_TYPES = choiceLabels(ParamId.ClickType);
export const MODAL_MATERIALS = choiceLabels(ParamId.ModalMaterial);
export const MODFX_TYPES = choiceLabels(ParamId.ModFxType);
export const WAVETABLES = choiceLabels(ParamId.WaveTable);
/** Tone/Noise layer-decay contour labels. */
export const ENV_SHAPES = choiceLabels(ParamId.ToneEnvShape);
/** The pitch sweep's contour labels — ENV_SHAPES plus "Drawn" at the end. */
export const PITCH_SHAPES = choiceLabels(ParamId.PitchEnvShape);
/** The index of the freehand contour in PITCH_SHAPES; the shuffle stops short of it. */
export const PITCH_SHAPE_DRAWN = PITCH_SHAPES.indexOf("Drawn");

/** Each Echo Sync division's length in BEATS (index 0 = "Free"). */
export const ECHO_SYNC_BEATS = ENGINE_TABLES.ECHO_SYNC_BEATS;

/** Format a value for display, e.g. "55 Hz", "0.18 s", or "Square". */
export function formatValue(s: ParamSpec, value: number): string {
  if (isDiscrete(s)) {
    const i = Math.min(s.choices!.length - 1, Math.max(0, Math.round(value)));
    return s.choices![i];
  }
  let decimals = 2;
  if (s.max >= 1000) decimals = 0;
  else if (s.max >= 100) decimals = 1;
  let text = value.toFixed(decimals);
  if (s.unit) text += ` ${s.unit}`;
  return text;
}

// Skew-aware slider mapping, matching juce::NormalisableRange:
//   convertTo0to1(v)   = ((v-min)/range)^skew
//   convertFrom0to1(p) = min + range * p^(1/skew)
// skew < 1 gives more slider travel to the low end (good for freq/time params).
export function valueToNorm(s: ParamSpec, value: number): number {
  const range = s.max - s.min;
  if (range <= 0) return 0;
  const p = Math.min(1, Math.max(0, (value - s.min) / range));
  return s.skew === 1 ? p : Math.pow(p, s.skew);
}

export function normToValue(s: ParamSpec, norm: number): number {
  let p = Math.min(1, Math.max(0, norm));
  if (s.skew !== 1) p = Math.pow(p, 1 / s.skew);
  let v = s.min + (s.max - s.min) * p;
  if (s.step > 0) v = Math.round(v / s.step) * s.step;
  return Math.min(s.max, Math.max(s.min, v));
}
