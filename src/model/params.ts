// THE SNAPSHOT CONTRACT — the one module that owns what a sound's number[] means.
//
// A sound is a flat `number[]` of NUM_PARAMS values. The numeric order of ParamId IS the
// index into that array, and the AudioWorklet reads the same indices. Historically both
// sides declared those indices by hand, along with nine lookup tables copied between
// paramSpec.ts, soundTraces.ts, drumKit.ts and engine.js. Now there is one table here, and
// public/worklet/engine-params.js is GENERATED from it at build time (see the euclidParams
// plugin in vite.config.ts). Nothing downstream re-types a table.
//
// This file must stay import-free: vite.config.ts imports it to run the generator, so it
// cannot reach anything browser-only (that is why the choice LISTS live here rather than in
// paramSpec.ts, which pulls in drums.ts).
//
// Adding a parameter is one enum member plus one PARAMS row. The Record type is exhaustive,
// so a missing row is a compile error — the check the old comments only promised. Reordering
// the enum is still a breaking change to the save format (see project.ts).

export enum ParamId {
  // --- Tone ---
  Pitch = 0,
  PitchEnvAmount,
  PitchEnvDecay,
  PitchEnvShape,   // pitch-sweep contour: Exp (legacy) / Line / S-curve / Parabola / Sine / Cos / Triangle / Wobble
  PitchEnvCurve,   // the shape's curve knob: slope-bend / steepness / warp / depth (0..1)
  PitchEnvCycles,  // wave count for the periodic shapes (Sine/Cos/Triangle/Wobble)
  Waveform,
  ToneLevel,
  ToneDecay,       // independent exponential decay for the oscillator layer (0 = follow amp)
  ToneEnvShape,    // oscillator-layer decay contour (Exp legacy / Line / S-curve / ... — see PitchEnvShape)
  ToneEnvCurve,    // the tone-decay shape's curve knob (0..1)
  ToneEnvCycles,   // wave count for the tone-decay periodic shapes
  NoiseLevel,
  NoiseType,       // White / Pink / Brown / Blue / Violet / Crackle / Metal
  NoiseDecay,      // independent exponential decay for the noise layer (0 = follow amp)
  NoiseEnvShape,   // noise-layer decay contour (Exp legacy / Line / S-curve / ...)
  NoiseEnvCurve,   // the noise-decay shape's curve knob (0..1)
  NoiseEnvCycles,  // wave count for the noise-decay periodic shapes
  OscModType,      // Off / FM / Ring (second-operator cross-modulation)
  OscModRatio,     // modulator frequency as a ratio of the carrier
  OscModAmount,    // FM index / ring-mod depth
  Osc2Mix,         // level of the 2nd oscillator (0 = off)
  Osc2Detune,      // 2nd-oscillator detune in semitones
  Sync,            // hard-sync the 2nd oscillator to the 1st (Off/On)
  Fold,            // wavefolder amount (0 = off)
  Unison,          // primary-oscillator unison voice count (Off / 3 / 5 / 7)
  UnisonDetune,    // unison spread (0 = none .. 1 ≈ 50 cents)
  FmFeedback,      // FM operator self-feedback (0 = clean sine .. 1 = saw/noisy)
  WaveTable,       // wavetable family (Off / Formant / Harmonic / Vocal / Digital)
  WavePosition,    // scan/morph position through the table (0..1)
  ClickLevel,      // transient click layer level (0 = off)
  ClickType,       // Tick / Snap / Knock / Blip / Clank
  // --- Amp envelope (the master loudness shape; each LAYER's own decay lives with the
  // layer above, since it is that layer's clock rather than the note's) ---
  AmpAttack,
  AmpDecay,
  AmpSustain,
  AmpRelease,
  AmpAttackShape,  // attack curve: 0 plucky .. 0.5 linear .. 1 slow swell
  AmpDecayShape,   // decay+release curve: 0 gated hold .. 0.5 linear .. 1 percussive
  // --- Filter ---
  FilterType,
  FilterCutoff,
  FilterReso,
  // --- Physical-model resonators (struck/plucked objects, not filters) ---
  CombMix,         // Karplus-Strong/comb resonator dry/wet (0 = off)
  CombTune,        // resonator pitch as a ratio of the note
  CombDecay,       // resonator feedback: short pluck .. long ringing string
  ModalMix,        // tuned-resonator bank dry/wet (0 = off)
  ModalMaterial,   // Membrane / Bell / Bar / Bowl / Plate (mode ratio+decay tables)
  ModalDecay,      // scales every mode's ring time (0 = tight, 1 = long ring)
  // --- LFOs (three identical blocks: dest / rate / depth / shape / sync) ---
  Lfo1Target,
  Lfo1Rate,
  Lfo1Depth,
  Lfo1Shape,       // Sine / Tri / Saw / Square / S&H
  Lfo1Sync,        // Free = Rate Hz, else one cycle per tempo division (beat-locked)
  Lfo2Target,
  Lfo2Rate,
  Lfo2Depth,
  Lfo2Shape,
  Lfo2Sync,
  Lfo3Target,
  Lfo3Rate,
  Lfo3Depth,
  Lfo3Shape,
  Lfo3Sync,
  // --- Drive & FX ---
  Drive,
  Crush,           // bit-depth reduction (Off..3-bit)
  Downsample,      // sample-rate reduction (Off..16x)
  ModFxType,       // Off / Chorus / Flanger / Phaser
  ModFxRate,       // modulation LFO rate (Hz)
  ModFxDepth,      // sweep depth (0..1)
  ModFxFeedback,   // flanger/phaser resonance (ignored by chorus)
  ModFxMix,        // dry/wet (0 = off)
  EchoTime,
  EchoFeedback,
  EchoMix,
  EchoSync,        // Free (use EchoTime) or a tempo division (1/32 .. 1/2)
  EchoPing,        // stereo ping-pong echo (Off/On)
  ReverbSize,
  ReverbMix,
  // --- Per-hit life (varies each HIT, not the sound) ---
  Gate,            // note-hold in seconds before note-off (with Sustain = note length)
  AccentAmount,    // how much NON-accent hits duck (accent = first hit of the cycle)
  Humanize,        // per-hit random level/pitch/cutoff jitter
  HitChance,       // probability a scheduled hit plays (misses may become ghosts)
  Ratchet,         // probability a hit becomes a 2-4x retrigger burst
  ChokeGroup,      // Off / A / B / C / D — triggering chokes same-group sounds
  // --- Output ---
  Volume,
  Pan,             // -1 (L) .. +1 (R), constant-power
  NumParams,
}

export const NUM_PARAMS = ParamId.NumParams;

/** Every ParamId except the NumParams sentinel — what PARAMS is keyed by. */
export type RealParamId = Exclude<ParamId, ParamId.NumParams>;

// --- What a choice INDEX means to the DSP ------------------------------------
// A discrete param stores an index into its choice list. The label is what the UI shows;
// `engine` is what that index means once it reaches the worklet — a bit depth, a divisor,
// a length in beats, a decay in seconds, a contour name, a set of resonator modes. Putting
// the two beside each other is the whole point: a label can no longer drift from the
// number it stands for.

/** One material's resonator modes: frequency ratios, gains, and per-mode decay weights. */
export interface ModalModes {
  r: number[];
  g: number[];
  d: number[];
}

/** The DSP meaning of one choice index. `null` on a contour = the legacy exponential path. */
export type EngineMeaning = number | string | null | ModalModes;

export interface ParamChoice {
  label: string;
  engine?: EngineMeaning;
}

export interface ParamEntry {
  name: string;
  min: number;
  max: number;
  def: number;
  skew: number; // 1 = linear; <1 weights toward the low end
  step: number;
  unit: string;
  randomizable: boolean;
  choices?: ParamChoice[]; // present => discrete
}

/** Labels only — the stored index is used directly by the engine, with no lookup. */
const labels = (...ls: string[]): ParamChoice[] => ls.map((label) => ({ label }));

/** Labels paired with what each index means to the DSP. */
function meanings(ls: string[], es: EngineMeaning[]): ParamChoice[] {
  return ls.map((label, i) => ({ label, engine: es[i] }));
}

// --- Shared choice lists -----------------------------------------------------
// Referenced by more than one param (the three LFO blocks, the three envelope contours),
// so they are declared once and shared by reference.

// LFO destinations. The "None" entry disables the LFO, so shuffling a destination can
// leave 0-2 LFOs active. It sits LAST; always reference it via LFO_NONE (paramSpec).
const LFO_TARGET_CHOICES = labels(
  "Pitch", "Filter", "Amp", "Drive", "Reso", "Wave", "Noise", "Crush", "Ring", "WTPos", "None",
);

const LFO_SHAPE_CHOICES = labels("Sine", "Tri", "Saw", "Square", "S&H");

// Tempo-sync divisions: one LFO CYCLE spans the division, so "1/8" wobbles twice per beat.
// `engine` is that length in BEATS (quarter notes); 0 = "Free", meaning use the Rate knob.
// Synced LFOs also phase-lock to the transport's beat grid at each hit (see engine.js).
const LFO_SYNC_CHOICES = meanings(
  ["Free", "1/32", "1/16", "1/16.", "1/8", "1/8.", "1/4", "1/4.", "1/2", "1/1"],
  [0, 0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 4],
);

// Envelope-contour shapes for the pitch sweep and the Tone/Noise layer decays. `engine` is
// the BlendShapeId fed to shapeT() over the decay window (see lines.ts); index 0 = "Exp"
// keeps the classic e^(−t/D) code path, which is why its meaning is null.
const ENV_SHAPE_CHOICES = meanings(
  ["Exp", "Line", "S-curve", "Parabola", "Sine", "Cos", "Triangle", "Wobble"],
  [null, "ramp", "scurve", "parabola", "sine", "cos", "zigzag", "wobble"],
);

const ON_OFF_CHOICES = labels("Off", "On");

/** Compact constructor for a row — positional, so the table stays scannable. */
function p(
  name: string, min: number, max: number, def: number,
  skew: number, step: number, unit: string,
  randomizable = true, choices?: ParamChoice[],
): ParamEntry {
  return { name, min, max, def, skew, step, unit, randomizable, choices };
}

/** One row per parameter. Exhaustive by type: a missing row fails the build. */
export const PARAMS: Record<RealParamId, ParamEntry> = {
  // --- Tone ---
  [ParamId.Pitch]: p("Pitch", 30, 2000, 200, 0.3, 1, "Hz"),
  // Bipolar: negative amounts START the note low and rise into the base pitch
  // (reverse-cymbal swells, zap risers); positive is the classic drop-from-above.
  [ParamId.PitchEnvAmount]: p("Pitch Env", -2, 5, 0, 1, 0.05, "x"),
  // Max reaches 2s so a pitch sweep can span a long note (the shuffle keeps ordinary
  // draws short — see PITCH_DECAY_SHUFFLE_CAP in drumKit.ts — and only its occasional
  // "evolve to the end" pass uses the top of this range).
  [ParamId.PitchEnvDecay]: p("Pitch Dec", 0.005, 2.0, 0.06, 0.3, 0.005, "s"),
  // Pitch-sweep contour: Exp (default) = the classic exponential drop/rise; Line +
  // Curve = a straight sloped ramp bendable toward exponential; the rest give
  // s-curve / parabola / oscillating (sine/cos/triangle/wobble) motion over the decay.
  [ParamId.PitchEnvShape]: p("Pitch Shape", 0, ENV_SHAPE_CHOICES.length - 1, 0, 1, 1, "", true, ENV_SHAPE_CHOICES),
  [ParamId.PitchEnvCurve]: p("Pitch Curve", 0, 1, 0, 1, 0.01, ""),
  [ParamId.PitchEnvCycles]: p("Pitch Cycles", 0.25, 8, 1, 0.5, 0.25, "x"),
  [ParamId.Waveform]: p("Wave", 0, 3, 0, 1, 1, "", true, labels("Sine", "Tri", "Square", "Saw")),
  [ParamId.ToneLevel]: p("Tone", 0, 1, 0.8, 1, 0.02, ""),
  // The oscillator layer's OWN decay clock, separate from the amp envelope — it belongs
  // beside the level it fades, not with the note's master envelope. 0 = follow the amp.
  // Its contour family is PitchEnvShape's: Exp = the classic exponential fall, the rest
  // bend the slope or oscillate the layer level over its decay.
  [ParamId.ToneDecay]: p("Tone Dec", 0, 1.2, 0, 0.35, 0.005, "s"),
  // Layer-decay contours (same family as PitchEnvShape). Exp = the classic exponential
  // fall; the other shapes bend the slope or oscillate the layer level over its decay.
  [ParamId.ToneEnvShape]: p("Tone Shape", 0, ENV_SHAPE_CHOICES.length - 1, 0, 1, 1, "", true, ENV_SHAPE_CHOICES),
  [ParamId.ToneEnvCurve]: p("Tone Curve", 0, 1, 0, 1, 0.01, ""),
  [ParamId.ToneEnvCycles]: p("Tone Cycles", 0.25, 8, 1, 0.5, 0.25, "x"),
  [ParamId.NoiseLevel]: p("Noise", 0, 1, 0, 1, 0.02, ""),
  [ParamId.NoiseType]: p("Noise Col", 0, 6, 0, 1, 1, "", true,
    labels("White", "Pink", "Brown", "Blue", "Violet", "Crackle", "Metal")),
  // The noise layer's own decay clock and contour, same as the tone layer's above.
  [ParamId.NoiseDecay]: p("Noise Dec", 0, 1.2, 0, 0.35, 0.005, "s"),
  [ParamId.NoiseEnvShape]: p("Noise Shape", 0, ENV_SHAPE_CHOICES.length - 1, 0, 1, 1, "", true, ENV_SHAPE_CHOICES),
  [ParamId.NoiseEnvCurve]: p("Noise Curve", 0, 1, 0, 1, 0.01, ""),
  [ParamId.NoiseEnvCycles]: p("Noise Cycles", 0.25, 8, 1, 0.5, 0.25, "x"),
  [ParamId.OscModType]: p("Mod", 0, 2, 0, 1, 1, "", true, labels("Off", "FM", "Ring")),
  [ParamId.OscModRatio]: p("Mod Ratio", 0.5, 12, 1, 0.5, 0.01, "x"),
  [ParamId.OscModAmount]: p("Mod Amt", 0, 1, 0, 1, 0.02, ""),
  [ParamId.Osc2Mix]: p("Osc2", 0, 1, 0, 1, 0.02, ""),
  [ParamId.Osc2Detune]: p("Detune", -12, 12, 0, 1, 0.1, "st"),
  [ParamId.Sync]: p("Sync", 0, 1, 0, 1, 1, "", true, ON_OFF_CHOICES),
  [ParamId.Fold]: p("Fold", 0, 1, 0, 1, 0.02, ""),
  // `engine` is the voice count per index — "Off" is the single classic oscillator.
  [ParamId.Unison]: p("Unison", 0, 3, 0, 1, 1, "", true,
    meanings(["Off", "3", "5", "7"], [1, 3, 5, 7])),
  [ParamId.UnisonDetune]: p("Spread", 0, 1, 0.2, 1, 0.02, ""),
  [ParamId.FmFeedback]: p("FB", 0, 1, 0, 1, 0.02, ""),
  // Wavetable families — each a precomputed bank of morph frames in engine.js. "Off" keeps
  // the analog Sine/Tri/Square/Saw oscillator; the rest replace the primary oscillator's
  // shape with a scannable digital table (WavePosition = the scan). The engine's family
  // index is the stored value minus 1, so there is no lookup table to carry.
  [ParamId.WaveTable]: p("Table", 0, 4, 0, 1, 1, "", true,
    labels("Off", "Formant", "Harmonic", "Vocal", "Digital")),
  [ParamId.WavePosition]: p("Scan", 0, 1, 0, 1, 0.02, ""),
  [ParamId.ClickLevel]: p("Click", 0, 1, 0, 1, 0.02, ""),
  // Transient click-layer flavours: Tick = violet-noise spike, Snap = white burst,
  // Knock = low sine thud at 2x pitch, Blip = 1.1kHz sine ping, Clank = S&H metal grit.
  // `engine` is each one's exponential decay in seconds — a few ms each.
  [ParamId.ClickType]: p("Click Type", 0, 4, 0, 1, 1, "", true,
    meanings(["Tick", "Snap", "Knock", "Blip", "Clank"], [0.0015, 0.006, 0.012, 0.004, 0.008])),

  // --- Amp envelope ---
  [ParamId.AmpAttack]: p("Attack", 0, 0.1, 0.001, 0.4, 0.001, "s"),
  [ParamId.AmpDecay]: p("Decay", 0.01, 1.5, 0.2, 0.35, 0.005, "s"),
  [ParamId.AmpSustain]: p("Sustain", 0, 1, 0, 1, 0.02, ""),
  [ParamId.AmpRelease]: p("Release", 0.005, 1.2, 0.08, 0.35, 0.005, "s"),
  // Envelope curvature: shape 0.5 = linear.
  [ParamId.AmpAttackShape]: p("Att Shape", 0, 1, 0.5, 1, 0.01, ""),
  [ParamId.AmpDecayShape]: p("Dec Shape", 0, 1, 0.5, 1, 0.01, ""),

  // --- Filter ---
  // "Vowel" = 3 parallel formant bandpasses; Cutoff morphs A→E→I→O→U (LFO-able wah).
  [ParamId.FilterType]: p("Filter", 0, 3, 0, 1, 1, "", true, labels("LP", "HP", "BP", "Vowel")),
  [ParamId.FilterCutoff]: p("Cutoff", 80, 18000, 12000, 0.3, 10, "Hz"),
  [ParamId.FilterReso]: p("Reso", 0.5, 8, 0.7, 0.5, 0.05, "Q"),
  // --- Physical-model resonators ---
  [ParamId.CombMix]: p("Comb", 0, 1, 0, 1, 0.02, ""),
  [ParamId.CombTune]: p("Comb Tune", 0.25, 4, 1, 0.5, 0.01, "x"),
  [ParamId.CombDecay]: p("Comb Decay", 0, 1, 0.5, 1, 0.02, ""),
  [ParamId.ModalMix]: p("Modal", 0, 1, 0, 1, 0.02, ""),
  // Modal-resonator materials. `engine` is the material's measured mode table — frequency
  // ratios (r), gains (g) and decay weights (d) — the bells/bars/membranes synthesis a la
  // Collision/Elements. Classic measured sets: circular membrane, minor-third church bell,
  // free bar (marimba), singing bowl (detuned pairs beat against each other), thick metal
  // plate (inharmonic spread). The Sound Graph draws its curve from the same numbers.
  [ParamId.ModalMaterial]: p("Material", 0, 4, 0, 1, 1, "", true, meanings(
    ["Membrane", "Bell", "Bar", "Bowl", "Plate"],
    [
      { r: [1, 1.59, 2.14, 2.30, 2.65, 2.92], g: [1, 0.62, 0.40, 0.35, 0.25, 0.20], d: [1, 0.70, 0.55, 0.45, 0.40, 0.35] },
      { r: [0.5, 1, 1.2, 1.5, 2.0, 2.67], g: [0.5, 1, 0.70, 0.60, 0.50, 0.35], d: [1.4, 1, 0.90, 0.80, 0.70, 0.50] },
      { r: [1, 2.76, 5.40, 8.93], g: [1, 0.55, 0.30, 0.15], d: [1, 0.45, 0.25, 0.15] },
      { r: [1, 1.004, 2.78, 2.79, 5.18, 8.16], g: [0.8, 0.8, 0.60, 0.55, 0.30, 0.15], d: [1.6, 1.6, 1.1, 1.1, 0.70, 0.40] },
      { r: [1, 1.32, 1.72, 2.19, 2.71, 3.49], g: [1, 0.75, 0.65, 0.55, 0.45, 0.35], d: [0.8, 0.70, 0.65, 0.55, 0.50, 0.40] },
    ],
  )),
  [ParamId.ModalDecay]: p("Modal Dec", 0, 1, 0.5, 1, 0.02, ""),

  // --- LFOs. The three blocks are identical but for their default destinations, which
  // fan out (Pitch / Filter / Amp) so a fresh sound's three LFOs aren't stacked. ---
  [ParamId.Lfo1Target]: p("Dest", 0, 10, 0, 1, 1, "", true, LFO_TARGET_CHOICES),
  [ParamId.Lfo1Rate]: p("Rate", 0.1, 40, 5, 0.4, 0.1, "Hz"),
  [ParamId.Lfo1Depth]: p("Amt", 0, 1, 0, 1, 0.02, ""),
  [ParamId.Lfo1Shape]: p("Shape", 0, 4, 0, 1, 1, "", true, LFO_SHAPE_CHOICES),
  [ParamId.Lfo1Sync]: p("Sync", 0, 9, 0, 1, 1, "", true, LFO_SYNC_CHOICES),
  [ParamId.Lfo2Target]: p("Dest", 0, 10, 1, 1, 1, "", true, LFO_TARGET_CHOICES),
  [ParamId.Lfo2Rate]: p("Rate", 0.1, 40, 5, 0.4, 0.1, "Hz"),
  [ParamId.Lfo2Depth]: p("Amt", 0, 1, 0, 1, 0.02, ""),
  [ParamId.Lfo2Shape]: p("Shape", 0, 4, 0, 1, 1, "", true, LFO_SHAPE_CHOICES),
  [ParamId.Lfo2Sync]: p("Sync", 0, 9, 0, 1, 1, "", true, LFO_SYNC_CHOICES),
  [ParamId.Lfo3Target]: p("Dest", 0, 10, 2, 1, 1, "", true, LFO_TARGET_CHOICES),
  [ParamId.Lfo3Rate]: p("Rate", 0.1, 40, 5, 0.4, 0.1, "Hz"),
  [ParamId.Lfo3Depth]: p("Amt", 0, 1, 0, 1, 0.02, ""),
  [ParamId.Lfo3Shape]: p("Shape", 0, 4, 0, 1, 1, "", true, LFO_SHAPE_CHOICES),
  [ParamId.Lfo3Sync]: p("Sync", 0, 9, 0, 1, 1, "", true, LFO_SYNC_CHOICES),

  // --- Drive & FX ---
  [ParamId.Drive]: p("Drive", 0, 1, 0.1, 1, 0.02, ""),
  // `engine` is the quantiser's bit depth per index (0 = off) and the sample-rate divisor.
  [ParamId.Crush]: p("Crush", 0, 7, 0, 1, 1, "", true, meanings(
    ["Off", "12-bit", "10-bit", "8-bit", "6-bit", "5-bit", "4-bit", "3-bit"],
    [0, 12, 10, 8, 6, 5, 4, 3],
  )),
  [ParamId.Downsample]: p("Downsmpl", 0, 7, 0, 1, 1, "", true, meanings(
    ["Off", "2x", "3x", "4x", "6x", "8x", "12x", "16x"],
    [1, 2, 3, 4, 6, 8, 12, 16],
  )),
  // Modulation-FX flavours (a modulated delay / allpass cascade).
  [ParamId.ModFxType]: p("Mod FX", 0, 3, 0, 1, 1, "", true, labels("Off", "Chorus", "Flanger", "Phaser")),
  [ParamId.ModFxRate]: p("Rate", 0.05, 8, 0.6, 0.4, 0.01, "Hz"),
  [ParamId.ModFxDepth]: p("Depth", 0, 1, 0.4, 1, 0.02, ""),
  [ParamId.ModFxFeedback]: p("FB", 0, 1, 0.2, 1, 0.02, ""),
  [ParamId.ModFxMix]: p("Mix", 0, 1, 0, 1, 0.02, ""),
  [ParamId.EchoTime]: p("Echo Time", 0.02, 0.6, 0.18, 0.5, 0.005, "s"),
  [ParamId.EchoFeedback]: p("Echo FB", 0, 0.85, 0.2, 1, 0.02, ""),
  [ParamId.EchoMix]: p("Echo Mix", 0, 1, 0, 1, 0.02, ""),
  // Echo tempo-sync divisions; `engine` is each one's length in BEATS ("Free" = 0, meaning
  // use the EchoTime knob in seconds).
  [ParamId.EchoSync]: p("Echo Sync", 0, 8, 0, 1, 1, "", true, meanings(
    ["Free", "1/32", "1/16", "1/16.", "1/8", "1/8.", "1/4", "1/4.", "1/2"],
    [0, 0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2],
  )),
  [ParamId.EchoPing]: p("Ping-Pong", 0, 1, 0, 1, 1, "", true, ON_OFF_CHOICES),
  [ParamId.ReverbSize]: p("Verb Size", 0, 1, 0.3, 1, 0.02, ""),
  [ParamId.ReverbMix]: p("Verb Mix", 0, 1, 0, 1, 0.02, ""),

  // --- Per-hit life ---
  // Note-hold in seconds; default 0.4 matches the sequencer's default step gate.
  // Max 60s for drone-length holds (pair with Sustain > 0 so the note actually rings);
  // the low skew keeps most of the slider's travel on the ordinary short gates.
  // Not randomizable — it's a length choice, not part of the sound's character.
  [ParamId.Gate]: p("Gate", 0.02, 60, 0.4, 0.2, 0.005, "s", false),
  [ParamId.AccentAmount]: p("Accent", 0, 1, 0, 1, 0.02, ""),
  [ParamId.Humanize]: p("Humanize", 0, 1, 0, 1, 0.02, ""),
  [ParamId.HitChance]: p("Hit Chance", 0.25, 1, 1, 1, 0.01, ""),
  [ParamId.Ratchet]: p("Ratchet", 0, 1, 0, 1, 0.02, ""),
  // Choke groups: a triggering sound silences other sounds in its group (classic
  // closed-hat-chokes-open-hat). Deliberately NOT randomizable — it's a relationship
  // between sounds, so shuffling it would re-wire the kit at random.
  [ParamId.ChokeGroup]: p("Choke", 0, 4, 0, 1, 1, "", false, labels("Off", "A", "B", "C", "D")),

  // --- Output ---
  [ParamId.Volume]: p("Volume", 0, 1, 0.85, 1, 0.02, "", false),
  [ParamId.Pan]: p("Pan", -1, 1, 0, 1, 0.02, ""),
};

// --- Derived views -----------------------------------------------------------

/** A param's choice labels ([] when it is continuous). */
export function choiceLabels(id: RealParamId): string[] {
  return PARAMS[id].choices?.map((c) => c.label) ?? [];
}

/** A param's choice MEANINGS, in index order. Typed by the caller, which knows the shape
    it stored (numbers for the tables, strings for the contours, modes for materials). */
export function choiceMeanings<E extends EngineMeaning>(id: RealParamId): E[] {
  return (PARAMS[id].choices ?? []).map((c) => c.engine as E);
}

// --- What the worklet is given ------------------------------------------------
// Everything below is emitted into public/worklet/engine-params.js by the generator, under
// exactly these names, so engine.js reads `CRUSH_BITS[i]` as it always has. The tables are
// DERIVED from the choice lists above, so a label and its meaning cannot fall out of step.
//
// Only facts BOTH worlds need live here. Pure DSP tuning nobody predicts (CLIP_KNEE,
// CRACKLE_DENSITY, VOWELS, the wavetable bank) stays hand-written in engine.js.

/** LFO destination indices by name, for engine.js's routing switch. */
export const LFO_DESTINATIONS: Record<string, number> = Object.fromEntries(
  LFO_TARGET_CHOICES.map((c, i) => [c.label.toUpperCase(), i]),
);

export const ENGINE_TABLES = {
  /** Snapshot index per parameter — the contract itself. Built from the enum's own reverse
      mapping, so the emitted names and indices are the enum, not a second copy of it. */
  P: Object.fromEntries(
    Object.keys(PARAMS).map((k) => [ParamId[Number(k) as ParamId], Number(k)]),
  ) as Record<string, number>,
  LFO: LFO_DESTINATIONS,
  ENV_SHAPE_IDS: choiceMeanings<string | null>(ParamId.PitchEnvShape),
  UNISON_VOICES: choiceMeanings<number>(ParamId.Unison),
  CRUSH_BITS: choiceMeanings<number>(ParamId.Crush),
  DOWNSAMPLE_FACTOR: choiceMeanings<number>(ParamId.Downsample),
  CLICK_DECAY: choiceMeanings<number>(ParamId.ClickType),
  MODAL_TABLES: choiceMeanings<ModalModes>(ParamId.ModalMaterial),
  LFO_SYNC_BEATS: choiceMeanings<number>(ParamId.Lfo1Sync),
  ECHO_SYNC_BEATS: choiceMeanings<number>(ParamId.EchoSync),
  /** Max phase-mod depth (carrier cycles) at OscModAmount = 1. The shuffle's harshness
      guard predicts FM sideband spread from it, so both worlds need the same number. */
  FM_INDEX: 4,
  /** Seconds of ring for mode 0 at ModalDecay = 0.5 — the modal curve's time base. */
  MODAL_BASE_DECAY: 0.45,
};

export enum ParamGroup {
  Tone,
  Amp,
  Filter,
  Resonator,
  Lfo,
  Fx,
  Life,
  Output,
}

// Groups are contiguous in ParamId order, so a param's group is just which boundary it
// falls under (each check names the LAST id of its group). Keep these in enum order.
export function getParamGroup(id: ParamId): ParamGroup {
  if (id <= ParamId.ClickType) return ParamGroup.Tone;
  if (id <= ParamId.AmpDecayShape) return ParamGroup.Amp;
  if (id <= ParamId.FilterReso) return ParamGroup.Filter;
  if (id <= ParamId.ModalDecay) return ParamGroup.Resonator;
  if (id <= ParamId.Lfo3Sync) return ParamGroup.Lfo;
  if (id <= ParamId.ReverbMix) return ParamGroup.Fx;
  if (id <= ParamId.ChokeGroup) return ParamGroup.Life;
  return ParamGroup.Output;
}

export function getParamGroupName(g: ParamGroup): string {
  switch (g) {
    case ParamGroup.Tone: return "Tone";
    case ParamGroup.Amp: return "Amp Envelope";
    case ParamGroup.Filter: return "Filter";
    case ParamGroup.Resonator: return "Resonators";
    case ParamGroup.Lfo: return "LFO";
    case ParamGroup.Fx: return "Drive & FX";
    case ParamGroup.Life: return "Per-Hit Life";
    case ParamGroup.Output: return "Output";
  }
}
