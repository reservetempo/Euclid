// Parameter identity + grouping. The numeric order of ParamId IS the index used in the
// float snapshots sent to the worklet, so it must stay in sync with the `P` map in
// public/worklet/engine.js (a check script asserts this). Params are grouped contiguously
// by ParamGroup — reordering is a breaking change to the save format, which is fine.

export enum ParamId {
  // --- Tone ---
  Pitch = 0,
  PitchEnvAmount,
  PitchEnvDecay,
  Waveform,
  ToneLevel,
  NoiseLevel,
  NoiseType,       // White / Pink / Brown / Blue / Violet / Crackle / Metal
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
  // --- Amp envelope + per-layer decays ---
  AmpAttack,
  AmpDecay,
  AmpSustain,
  AmpRelease,
  AmpAttackShape,  // attack curve: 0 plucky .. 0.5 linear .. 1 slow swell
  AmpDecayShape,   // decay+release curve: 0 gated hold .. 0.5 linear .. 1 percussive
  ToneDecay,       // independent exponential decay for the oscillator layer (0 = follow amp)
  NoiseDecay,      // independent exponential decay for the noise layer (0 = follow amp)
  Gate,            // note-hold in seconds before note-off (with Sustain = note length)
  // --- Filter + physical-model resonators ---
  FilterType,
  FilterCutoff,
  FilterReso,
  CombMix,         // Karplus-Strong/comb resonator dry/wet (0 = off)
  CombTune,        // resonator pitch as a ratio of the note
  CombDecay,       // resonator feedback: short pluck .. long ringing string
  ModalMix,        // tuned-resonator bank dry/wet (0 = off)
  ModalMaterial,   // Membrane / Bell / Bar / Bowl / Plate (mode ratio+decay tables)
  ModalDecay,      // scales every mode's ring time (0 = tight, 1 = long ring)
  // --- LFOs (three identical blocks: dest / rate / depth / shape / sync) ---
  LfoTarget,
  LfoRate,
  LfoDepth,
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

export enum ParamGroup {
  Tone,
  Amp,
  Filter,
  Lfo,
  Fx,
  Life,
  Output,
}

// Groups are contiguous in ParamId order, so a param's group is just which boundary it
// falls under (each check names the LAST id of its group). Keep these in enum order.
export function getParamGroup(id: ParamId): ParamGroup {
  if (id <= ParamId.ClickType) return ParamGroup.Tone;
  if (id <= ParamId.Gate) return ParamGroup.Amp;
  if (id <= ParamId.ModalDecay) return ParamGroup.Filter;
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
    case ParamGroup.Lfo: return "LFO";
    case ParamGroup.Fx: return "Drive & FX";
    case ParamGroup.Life: return "Per-Hit Life";
    case ParamGroup.Output: return "Output";
  }
}
