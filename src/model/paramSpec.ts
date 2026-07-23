// Parameter specs (name / range / default / step / choices) — one base spec per param.
// Every sound is a generic full-range sound: there is no per-drum "character" and no
// preset system, so `getParamSpec` just returns the base spec. `baseRange` gives the
// widest range a value may take (manual entry is clamped to it, and shuffle draws from it).

import { DrumType } from "./drums";
import { ParamId, NUM_PARAMS } from "./params";

// LFO destinations, shared by all three LFO sections. Index = the stored value;
// keep in sync with the LFO routing in public/worklet/engine.js. The "None" entry
// disables the LFO, so shuffling its destination can leave 0-2 LFOs active. Always
// reference it via LFO_NONE below rather than a literal index.
export const LFO_TARGETS = ["Pitch", "Filter", "Amp", "Drive", "Reso", "Wave", "Noise", "Crush", "Ring", "WTPos", "None"];
// Index of the "disable this LFO" destination (mirrors engine.js LFO_NONE).
export const LFO_NONE = LFO_TARGETS.indexOf("None");

// Sound-verse expansion choice lists. The stored value is the index; the engine
// maps each index to its DSP meaning, so these MUST stay in sync with the matching
// arrays in public/worklet/engine.js.
export const NOISE_TYPES = ["White", "Pink", "Brown", "Blue", "Violet", "Crackle", "Metal"];
export const OSC_MOD_TYPES = ["Off", "FM", "Ring"];
export const LFO_SHAPES = ["Sine", "Tri", "Saw", "Square", "S&H"];
export const ON_OFF = ["Off", "On"];
// Transient click-layer flavours (a few ms each): Tick = violet-noise spike,
// Snap = white burst, Knock = low sine thud at 2x pitch, Blip = 1.1kHz sine ping,
// Clank = sample-and-hold metal grit.
export const CLICK_TYPES = ["Tick", "Snap", "Knock", "Blip", "Clank"];
// Modal-resonator materials: each names a table of mode frequency ratios + decay
// weights in the engine (bells/bars/membranes synthesis, a la Collision/Elements).
export const MODAL_MATERIALS = ["Membrane", "Bell", "Bar", "Bowl", "Plate"];
// Echo tempo-sync divisions ("Free" = use EchoTime seconds). ECHO_SYNC_BEATS gives
// each index's length in BEATS (quarter notes) — mirrored in engine.js, keep in sync.
export const ECHO_SYNCS = ["Free", "1/32", "1/16", "1/16.", "1/8", "1/8.", "1/4", "1/4.", "1/2"];
export const ECHO_SYNC_BEATS = [0, 0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2];
// LFO tempo-sync divisions ("Free" = the Rate knob in Hz). One LFO CYCLE spans the
// division — e.g. "1/8" wobbles twice per beat. Synced LFOs also phase-lock to the
// transport's beat grid at each hit (see engine.js). Mirrored in engine.js.
export const LFO_SYNCS = ["Free", "1/32", "1/16", "1/16.", "1/8", "1/8.", "1/4", "1/4.", "1/2", "1/1"];
export const LFO_SYNC_BEATS = [0, 0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 4];
// Choke groups: a triggering sound silences other sounds in its group (classic
// closed-hat-chokes-open-hat). Deliberately NOT randomizable — it's a relationship
// between sounds, so shuffling it would re-wire the kit at random.
export const CHOKE_GROUPS = ["Off", "A", "B", "C", "D"];
// Crush bit-depth per index (0 = off); Downsample factor per index (index 0 = 1x off).
export const CRUSH_CHOICES = ["Off", "12-bit", "10-bit", "8-bit", "6-bit", "5-bit", "4-bit", "3-bit"];
export const DOWNSAMPLE_CHOICES = ["Off", "2x", "3x", "4x", "6x", "8x", "12x", "16x"];
// Unison voice count for the primary oscillator (index maps to a count in engine.js
// UNISON_VOICES). "Off" = the single classic oscillator.
export const UNISON_CHOICES = ["Off", "3", "5", "7"];
// Modulation-FX flavours (a modulated delay / allpass cascade), mirrored in engine.js.
export const MODFX_TYPES = ["Off", "Chorus", "Flanger", "Phaser"];
// Wavetable families — each a precomputed bank of morph frames in engine.js. "Off" keeps
// the analog Sine/Tri/Square/Saw oscillator; the rest replace the primary oscillator's
// shape with a scannable digital table (WavePosition = the scan).
export const WAVETABLES = ["Off", "Formant", "Harmonic", "Vocal", "Digital"];

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

function make(
  name: string, min: number, max: number, def: number,
  skew: number, step: number, unit: string,
  randomizable = true, choices?: string[]
): ParamSpec {
  return { name, min, max, def, skew, step, unit, randomizable, choices };
}

export function baseSpec(id: ParamId): ParamSpec {
  switch (id) {
    case ParamId.Pitch:          return make("Pitch", 30, 2000, 200, 0.3, 1, "Hz");
    // Bipolar: negative amounts START the note low and rise into the base pitch
    // (reverse-cymbal swells, zap risers); positive is the classic drop-from-above.
    case ParamId.PitchEnvAmount: return make("Pitch Env", -2, 5, 0, 1, 0.05, "x");
    case ParamId.PitchEnvDecay:  return make("Pitch Dec", 0.005, 0.6, 0.06, 0.35, 0.005, "s");
    case ParamId.Waveform:       return make("Wave", 0, 3, 0, 1, 1, "", true, ["Sine", "Tri", "Square", "Saw"]);
    case ParamId.ToneLevel:      return make("Tone", 0, 1, 0.8, 1, 0.02, "");
    case ParamId.NoiseLevel:     return make("Noise", 0, 1, 0, 1, 0.02, "");
    case ParamId.AmpAttack:      return make("Attack", 0, 0.1, 0.001, 0.4, 0.001, "s");
    case ParamId.AmpDecay:       return make("Decay", 0.01, 1.5, 0.2, 0.35, 0.005, "s");
    case ParamId.AmpSustain:     return make("Sustain", 0, 1, 0, 1, 0.02, "");
    case ParamId.AmpRelease:     return make("Release", 0.005, 1.2, 0.08, 0.35, 0.005, "s");
    // "Vowel" = 3 parallel formant bandpasses; Cutoff morphs A→E→I→O→U (LFO-able wah).
    case ParamId.FilterType:     return make("Filter", 0, 3, 0, 1, 1, "", true, ["LP", "HP", "BP", "Vowel"]);
    case ParamId.FilterCutoff:   return make("Cutoff", 80, 18000, 12000, 0.3, 10, "Hz");
    case ParamId.FilterReso:     return make("Reso", 0.5, 8, 0.7, 0.5, 0.05, "Q");
    case ParamId.LfoTarget:      return make("Dest", 0, 10, 0, 1, 1, "", true, LFO_TARGETS);
    case ParamId.LfoRate:        return make("Rate", 0.1, 40, 5, 0.4, 0.1, "Hz");
    case ParamId.LfoDepth:       return make("Amt", 0, 1, 0, 1, 0.02, "");
    case ParamId.Drive:          return make("Drive", 0, 1, 0.1, 1, 0.02, "");
    case ParamId.EchoTime:       return make("Echo Time", 0.02, 0.6, 0.18, 0.5, 0.005, "s");
    case ParamId.EchoFeedback:   return make("Echo FB", 0, 0.85, 0.2, 1, 0.02, "");
    case ParamId.EchoMix:        return make("Echo Mix", 0, 1, 0, 1, 0.02, "");
    case ParamId.ReverbSize:     return make("Verb Size", 0, 1, 0.3, 1, 0.02, "");
    case ParamId.ReverbMix:      return make("Verb Mix", 0, 1, 0, 1, 0.02, "");
    case ParamId.Volume:         return make("Volume", 0, 1, 0.85, 1, 0.02, "", false);
    // LFO 2 & 3 mirror LFO 1's specs (a destination + rate + depth each).
    case ParamId.Lfo2Target:     return make("Dest", 0, 10, 1, 1, 1, "", true, LFO_TARGETS);
    case ParamId.Lfo2Rate:       return make("Rate", 0.1, 40, 5, 0.4, 0.1, "Hz");
    case ParamId.Lfo2Depth:      return make("Amt", 0, 1, 0, 1, 0.02, "");
    case ParamId.Lfo3Target:     return make("Dest", 0, 10, 2, 1, 1, "", true, LFO_TARGETS);
    case ParamId.Lfo3Rate:       return make("Rate", 0.1, 40, 5, 0.4, 0.1, "Hz");
    case ParamId.Lfo3Depth:      return make("Amt", 0, 1, 0, 1, 0.02, "");
    // --- Sound-verse expansion. Defaults are all "off/neutral"; choice lists must stay
    // in sync with the maps in engine.js. ---
    case ParamId.NoiseType:      return make("Noise Col", 0, 6, 0, 1, 1, "", true, NOISE_TYPES);
    case ParamId.OscModType:     return make("Mod", 0, 2, 0, 1, 1, "", true, OSC_MOD_TYPES);
    case ParamId.OscModRatio:    return make("Mod Ratio", 0.5, 12, 1, 0.5, 0.01, "x");
    case ParamId.OscModAmount:   return make("Mod Amt", 0, 1, 0, 1, 0.02, "");
    case ParamId.Crush:          return make("Crush", 0, 7, 0, 1, 1, "", true, CRUSH_CHOICES);
    case ParamId.Downsample:     return make("Downsmpl", 0, 7, 0, 1, 1, "", true, DOWNSAMPLE_CHOICES);
    case ParamId.Lfo1Shape:      return make("Shape", 0, 4, 0, 1, 1, "", true, LFO_SHAPES);
    case ParamId.Lfo2Shape:      return make("Shape", 0, 4, 0, 1, 1, "", true, LFO_SHAPES);
    case ParamId.Lfo3Shape:      return make("Shape", 0, 4, 0, 1, 1, "", true, LFO_SHAPES);
    // 2nd oscillator + sync, wavefolder, and Karplus-Strong/comb resonator.
    case ParamId.Osc2Mix:        return make("Osc2", 0, 1, 0, 1, 0.02, "");
    case ParamId.Osc2Detune:     return make("Detune", -12, 12, 0, 1, 0.1, "st");
    case ParamId.Sync:           return make("Sync", 0, 1, 0, 1, 1, "", true, ON_OFF);
    case ParamId.Fold:           return make("Fold", 0, 1, 0, 1, 0.02, "");
    case ParamId.CombMix:        return make("Comb", 0, 1, 0, 1, 0.02, "");
    case ParamId.CombTune:       return make("Comb Tune", 0.25, 4, 1, 0.5, 0.01, "x");
    case ParamId.CombDecay:      return make("Comb Decay", 0, 1, 0.5, 1, 0.02, "");
    // Envelope curvature + layering. Shape 0.5 = linear; the layer decays default to
    // 0 = follow the amp envelope, and the click layer defaults to off.
    case ParamId.AmpAttackShape: return make("Att Shape", 0, 1, 0.5, 1, 0.01, "");
    case ParamId.AmpDecayShape:  return make("Dec Shape", 0, 1, 0.5, 1, 0.01, "");
    case ParamId.ToneDecay:      return make("Tone Dec", 0, 1.2, 0, 0.35, 0.005, "s");
    case ParamId.NoiseDecay:     return make("Noise Dec", 0, 1.2, 0, 0.35, 0.005, "s");
    case ParamId.ClickLevel:     return make("Click", 0, 1, 0, 1, 0.02, "");
    case ParamId.ClickType:      return make("Click Type", 0, 4, 0, 1, 1, "", true, CLICK_TYPES);
    // Modal resonator bank, echo sync/ping-pong, pan, and the per-hit Life params.
    case ParamId.ModalMix:       return make("Modal", 0, 1, 0, 1, 0.02, "");
    case ParamId.ModalMaterial:  return make("Material", 0, 4, 0, 1, 1, "", true, MODAL_MATERIALS);
    case ParamId.ModalDecay:     return make("Modal Dec", 0, 1, 0.5, 1, 0.02, "");
    case ParamId.EchoSync:       return make("Echo Sync", 0, 8, 0, 1, 1, "", true, ECHO_SYNCS);
    case ParamId.EchoPing:       return make("Ping-Pong", 0, 1, 0, 1, 1, "", true, ON_OFF);
    case ParamId.Pan:            return make("Pan", -1, 1, 0, 1, 0.02, "");
    case ParamId.AccentAmount:   return make("Accent", 0, 1, 0, 1, 0.02, "");
    case ParamId.Humanize:       return make("Humanize", 0, 1, 0, 1, 0.02, "");
    case ParamId.HitChance:      return make("Hit Chance", 0.25, 1, 1, 1, 0.01, "");
    case ParamId.Ratchet:        return make("Ratchet", 0, 1, 0, 1, 0.02, "");
    case ParamId.ChokeGroup:     return make("Choke", 0, 4, 0, 1, 1, "", false, CHOKE_GROUPS);
    // LFO tempo-sync, one per LFO. Free (default) uses the Rate knob in Hz.
    case ParamId.Lfo1Sync:       return make("Sync", 0, 9, 0, 1, 1, "", true, LFO_SYNCS);
    case ParamId.Lfo2Sync:       return make("Sync", 0, 9, 0, 1, 1, "", true, LFO_SYNCS);
    case ParamId.Lfo3Sync:       return make("Sync", 0, 9, 0, 1, 1, "", true, LFO_SYNCS);
    // Note-hold in seconds; default 0.4 matches the sequencer's default step gate.
    // Max 30s for drone-length holds (pair with Sustain > 0 so the note actually rings);
    // the low skew keeps most of the slider's travel on the ordinary short gates.
    // Not randomizable — it's a length choice, not part of the sound's character.
    case ParamId.Gate:           return make("Gate", 0.02, 30, 0.4, 0.2, 0.005, "s", false);
    // Sixth wave — fatter oscillators, modulation FX, wavetable morph oscillator.
    case ParamId.Unison:         return make("Unison", 0, 3, 0, 1, 1, "", true, UNISON_CHOICES);
    case ParamId.UnisonDetune:   return make("Spread", 0, 1, 0.2, 1, 0.02, "");
    case ParamId.FmFeedback:     return make("FB", 0, 1, 0, 1, 0.02, "");
    case ParamId.WaveTable:      return make("Table", 0, 4, 0, 1, 1, "", true, WAVETABLES);
    case ParamId.WavePosition:   return make("Scan", 0, 1, 0, 1, 0.02, "");
    case ParamId.ModFxType:      return make("Mod FX", 0, 3, 0, 1, 1, "", true, MODFX_TYPES);
    case ParamId.ModFxRate:      return make("Rate", 0.05, 8, 0.6, 0.4, 0.01, "Hz");
    case ParamId.ModFxDepth:     return make("Depth", 0, 1, 0.4, 1, 0.02, "");
    case ParamId.ModFxFeedback:  return make("FB", 0, 1, 0.2, 1, 0.02, "");
    case ParamId.ModFxMix:       return make("Mix", 0, 1, 0, 1, 0.02, "");
    default:                     return make("?", 0, 1, 0, 1, 0.01, "");
  }
}

// Every sound is generic full-range now — no per-drum character. The `drum` arg is kept
// only so existing callers (which pass a reference DrumType) stay unchanged.
export function getParamSpec(_drum: DrumType, id: ParamId): ParamSpec {
  return baseSpec(id);
}

/** The widest range a parameter may take. Manual numeric entry is clamped to this, and
    shuffle draws from it. */
export function baseRange(id: ParamId): { min: number; max: number } {
  const s = baseSpec(id);
  return { min: s.min, max: s.max };
}

/** Build the default snapshot for a drum (the array the worklet expects). */
export function defaultSnapshot(drum: DrumType): number[] {
  const snap: number[] = new Array(NUM_PARAMS);
  for (let i = 0; i < NUM_PARAMS; i++) snap[i] = getParamSpec(drum, i as ParamId).def;
  return snap;
}

export function isDiscrete(s: ParamSpec): boolean {
  return !!s.choices && s.choices.length > 0;
}

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
