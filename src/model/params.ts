// Parameter identity + grouping. The numeric order of ParamId IS the index used
// in the 23-float snapshots sent to the worklet, so only append before Volume.
// Keep in sync with the `P` map in public/worklet/engine.js.

export enum ParamId {
  Pitch = 0,
  PitchEnvAmount,
  PitchEnvDecay,
  Waveform,
  ToneLevel,
  NoiseLevel,
  AmpAttack,
  AmpDecay,
  AmpSustain,
  AmpRelease,
  FilterType,
  FilterCutoff,
  FilterReso,
  LfoTarget,
  LfoRate,
  LfoDepth,
  Drive,
  EchoTime,
  EchoFeedback,
  EchoMix,
  ReverbSize,
  ReverbMix,
  Volume,
  // LFO 2 & 3 appended AFTER Volume so every index above stays stable (old 23-float
  // snapshots still line up; the worklet/migration just default these). LFO 1 is the
  // original LfoTarget/LfoRate/LfoDepth (13–15).
  Lfo2Target,
  Lfo2Rate,
  Lfo2Depth,
  Lfo3Target,
  Lfo3Rate,
  Lfo3Depth,
  // Sound-verse expansion (all appended, all back-compatible): a noise colour,
  // a second-oscillator FM/ring modulator, a bitcrusher, and per-LFO waveshapes.
  NoiseType,     // White / Pink / Brown / Blue / Violet / Crackle / Metal
  OscModType,    // Off / FM / Ring (second-operator cross-modulation)
  OscModRatio,   // modulator frequency as a ratio of the carrier
  OscModAmount,  // FM index / ring-mod depth
  Crush,         // bit-depth reduction (Off..3-bit)
  Downsample,    // sample-rate reduction (Off..16x)
  Lfo1Shape,     // Sine / Tri / Saw / Square / S&H, per LFO
  Lfo2Shape,
  Lfo3Shape,
  // Second wave of expansion: a detuned 2nd oscillator (+ hard sync), a wavefolder,
  // and a Karplus-Strong/comb resonator (plucked & struck physical-modeling tones).
  Osc2Mix,       // level of the 2nd oscillator (0 = off)
  Osc2Detune,    // 2nd-oscillator detune in semitones
  Sync,          // hard-sync the 2nd oscillator to the 1st (Off/On)
  Fold,          // wavefolder amount (0 = off)
  CombMix,       // resonator dry/wet (0 = off)
  CombTune,      // resonator pitch as a ratio of the note
  CombDecay,     // resonator feedback: short pluck .. long ringing string
  // Third wave: envelope curvature + drum layering. The amp segments get a shape
  // (0.5 = linear, the old behaviour; low = snappy/gated, high = soft/exponential),
  // and a hit becomes up to three layers under the master ADSR: a transient click,
  // the tone with an optional independent decay, and noise likewise (0 = follow amp).
  AmpAttackShape, // attack curve: 0 plucky .. 0.5 linear .. 1 slow swell
  AmpDecayShape,  // decay+release curve: 0 gated hold .. 0.5 linear .. 1 percussive
  ToneDecay,      // independent exponential decay for the oscillator layer (0 = follow amp)
  NoiseDecay,     // independent exponential decay for the noise layer (0 = follow amp)
  ClickLevel,     // transient click layer level (0 = off)
  ClickType,      // Tick / Snap / Knock / Blip / Clank
  // Fourth wave: modal percussion, space, and per-hit life. Modal = a bank of tuned
  // resonators (bells/bars/membranes); Echo gains tempo-sync + stereo ping-pong; Pan
  // places the channel in the stereo field; the Life params vary each HIT (accents,
  // ghosts, humanize, ratchets) instead of the sound itself; ChokeGroup lets one
  // sound cut another (closed hat chokes open hat).
  ModalMix,       // tuned-resonator bank dry/wet (0 = off)
  ModalMaterial,  // Membrane / Bell / Bar / Bowl / Plate (mode ratio+decay tables)
  ModalDecay,     // scales every mode's ring time (0 = tight, 1 = long ring)
  EchoSync,       // Free (use EchoTime) or a tempo division (1/32 .. 1/2)
  EchoPing,       // stereo ping-pong echo (Off/On)
  Pan,            // -1 (L) .. +1 (R), constant-power
  AccentAmount,   // how much NON-accent hits duck (accent = first hit of the cycle)
  Humanize,       // per-hit random level/pitch/cutoff jitter
  HitChance,      // probability a scheduled hit plays (misses may become ghosts)
  Ratchet,        // probability a hit becomes a 2-4x retrigger burst
  ChokeGroup,     // Off / A / B / C / D — triggering chokes same-group sounds
  // Fifth wave: LFO tempo-sync, one per LFO (the echo's EchoSync, applied to
  // modulation). Free = the Rate knob in Hz; a division locks one LFO cycle to
  // that note length at the live tempo AND phase-locks it to the transport's
  // beat grid at each hit — the classic beat-synced dubstep wobble.
  Lfo1Sync,
  Lfo2Sync,
  Lfo3Sync,
  // Note-hold: how many seconds each hit is gated ON before note-off. With the amp
  // Sustain this is the note-length control. Appended last so every index above stays
  // stable; snapshots saved before it default to the legacy fixed hold (STEP_GATE_SEC
  // in engine.js) via rd() there and restore() in drumKit.ts.
  Gate,
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

export function getParamGroup(id: ParamId): ParamGroup {
  switch (id) {
    case ParamId.Pitch:
    case ParamId.PitchEnvAmount:
    case ParamId.PitchEnvDecay:
    case ParamId.Waveform:
    case ParamId.ToneLevel:
    case ParamId.NoiseLevel:
    case ParamId.NoiseType:
    case ParamId.OscModType:
    case ParamId.OscModRatio:
    case ParamId.OscModAmount:
    case ParamId.Osc2Mix:
    case ParamId.Osc2Detune:
    case ParamId.Sync:
    case ParamId.Fold:
    case ParamId.ClickLevel:
    case ParamId.ClickType:
      return ParamGroup.Tone;
    case ParamId.AmpAttack:
    case ParamId.AmpDecay:
    case ParamId.AmpSustain:
    case ParamId.AmpRelease:
    case ParamId.AmpAttackShape:
    case ParamId.AmpDecayShape:
    case ParamId.ToneDecay:
    case ParamId.NoiseDecay:
    case ParamId.Gate:
      return ParamGroup.Amp;
    case ParamId.FilterType:
    case ParamId.FilterCutoff:
    case ParamId.FilterReso:
    case ParamId.CombMix:
    case ParamId.CombTune:
    case ParamId.CombDecay:
    case ParamId.ModalMix:
    case ParamId.ModalMaterial:
    case ParamId.ModalDecay:
      return ParamGroup.Filter;
    case ParamId.LfoTarget:
    case ParamId.LfoRate:
    case ParamId.LfoDepth:
    case ParamId.Lfo2Target:
    case ParamId.Lfo2Rate:
    case ParamId.Lfo2Depth:
    case ParamId.Lfo3Target:
    case ParamId.Lfo3Rate:
    case ParamId.Lfo3Depth:
    case ParamId.Lfo1Shape:
    case ParamId.Lfo2Shape:
    case ParamId.Lfo3Shape:
    case ParamId.Lfo1Sync:
    case ParamId.Lfo2Sync:
    case ParamId.Lfo3Sync:
      return ParamGroup.Lfo;
    case ParamId.Drive:
    case ParamId.EchoTime:
    case ParamId.EchoFeedback:
    case ParamId.EchoMix:
    case ParamId.EchoSync:
    case ParamId.EchoPing:
    case ParamId.ReverbSize:
    case ParamId.ReverbMix:
    case ParamId.Crush:
    case ParamId.Downsample:
      return ParamGroup.Fx;
    case ParamId.AccentAmount:
    case ParamId.Humanize:
    case ParamId.HitChance:
    case ParamId.Ratchet:
    case ParamId.ChokeGroup:
      return ParamGroup.Life;
    case ParamId.Volume:
    case ParamId.Pan:
      return ParamGroup.Output;
    default:
      return ParamGroup.Tone;
  }
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
