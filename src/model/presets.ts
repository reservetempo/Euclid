// Factory sound presets. A preset carries BOTH a per-parameter range and a set of
// values: applying it to a drum slot sets the live values and the shuffle window
// (see DrumParameters.applyPreset). The per-drum presets reuse the "in character"
// ranges from paramSpec; "Full Range" opens every range to the widest possible
// (baseSpec) with values centred, for a true full-range shuffle.

import { DrumType } from "./drums";
import { ParamId, NUM_PARAMS } from "./params";
import { getParamSpec, baseSpec, isDiscrete } from "./paramSpec";

// Discrete params that stay open (shuffle) on EVERY preset: LFO destinations, the
// click-layer flavour, the modal material, and the echo sync/ping-pong — they're
// spice, not identity. Other discrete "type" params (Wave/Filter/Noise colour) only
// shuffle on Full Range (their range is locked otherwise) so a character preset
// stays in character. ChokeGroup is not randomizable at all (see paramSpec).
const OPEN_DISCRETE_IDS = new Set<ParamId>([
  ParamId.LfoTarget, ParamId.Lfo2Target, ParamId.Lfo3Target, ParamId.ClickType,
  ParamId.ModalMaterial, ParamId.EchoSync, ParamId.EchoPing,
]);

export interface Preset {
  name: string;
  color: string; // tile colour in the preset grid
  ranges: { lo: number; hi: number }[]; // indexed by ParamId
  values: number[]; // indexed by ParamId
}

// Display name + tile colour for every engine drum (DRUMS in drums.ts only names
// the 5 slots; the rest get their own colours so the preset grid reads at a glance).
const PRESET_DRUMS: { drum: DrumType; name: string; color: string }[] = [
  { drum: DrumType.Kick, name: "Kick", color: "#ff3b30" },
  { drum: DrumType.Snare, name: "Snare", color: "#0a84ff" },
  { drum: DrumType.Clap, name: "Clap", color: "#ff9f0a" },
  { drum: DrumType.ClosedHat, name: "Closed Hat", color: "#34c759" },
  { drum: DrumType.OpenHat, name: "Open Hat", color: "#64d2ff" },
  { drum: DrumType.LowTom, name: "Low Tom", color: "#bf5af2" },
  { drum: DrumType.MidTom, name: "Mid Tom", color: "#ff6482" },
  { drum: DrumType.HighTom, name: "High Tom", color: "#ffd60a" },
  { drum: DrumType.Rim, name: "Rim", color: "#ac8e68" },
  { drum: DrumType.Cowbell, name: "Cowbell", color: "#a2845e" },
  { drum: DrumType.Wobble, name: "Wobble", color: "#00ffc8" },
  { drum: DrumType.SynthBass, name: "Synth Bass", color: "#6c5cff" },
];

function presetForDrum(drum: DrumType, name: string, color: string): Preset {
  const ranges: { lo: number; hi: number }[] = [];
  const values: number[] = [];
  for (let i = 0; i < NUM_PARAMS; i++) {
    const id = i as ParamId;
    const s = getParamSpec(drum, id);
    // Lock a character's Wave/Filter type (range = its default) so Shuffle keeps it
    // in character; open discrete params and continuous params keep their full range.
    if (isDiscrete(s) && !OPEN_DISCRETE_IDS.has(id)) ranges.push({ lo: s.def, hi: s.def });
    else ranges.push({ lo: s.min, hi: s.max });
    values.push(s.def);
  }
  return { name, color, ranges, values };
}

// Widest possible ranges, values at the centre of each range. Discrete params,
// Volume, and HitChance keep their base default (centring a "type", going quiet,
// or silently dropping hits makes no sense as a starting value).
function fullRangePreset(): Preset {
  const ranges: { lo: number; hi: number }[] = [];
  const values: number[] = [];
  for (let i = 0; i < NUM_PARAMS; i++) {
    const id = i as ParamId;
    const s = baseSpec(id);
    ranges.push({ lo: s.min, hi: s.max });
    const centred = isDiscrete(s) || id === ParamId.Volume || id === ParamId.HitChance;
    values.push(centred ? s.def : (s.min + s.max) / 2);
  }
  return { name: "Full Range", color: "#ffffff", values, ranges };
}

/** The widest-range preset, also the editor's default sound. */
export const FULL_RANGE_PRESET: Preset = fullRangePreset();

/** The full factory palette: one preset per drum character, then Full Range. */
export const FACTORY_PRESETS: Preset[] = [
  ...PRESET_DRUMS.map((d) => presetForDrum(d.drum, d.name, d.color)),
  FULL_RANGE_PRESET,
];

/** The default preset a drum slot starts on (its own character). */
export function defaultPresetFor(drum: DrumType): Preset {
  const found = PRESET_DRUMS.find((d) => d.drum === drum);
  return presetForDrum(drum, found?.name ?? "Drum", found?.color ?? "#888888");
}
