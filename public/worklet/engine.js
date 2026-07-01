/*
  engine.js — AudioWorklet DSP for Euclid

  Plain JS by design: this runs in the AudioWorkletGlobalScope and is served
  verbatim (no bundler transform), so it must be self-contained with no imports.
  It is a faithful port of the C++ engine:
    - Voice            <- DrumVoice.cpp / .h  (osc + noise + SVF + LFO + drive + ADSR)
    - Channel          <- DrumChannel.cpp / .h (6-voice pool + echo + freeverb + volume)
    - Reverb           <- juce::Reverb (freeverb: 8 combs + 4 allpass, mono)

  The main thread owns parameter ranges/defaults; it sends plain fixed-length
  float snapshots in. Parameter indices below MUST match src/model/params.ts (ParamId).
*/

// --- Parameter indices (keep in sync with ParamId in src/model/params.ts) ---
const P = {
  Pitch: 0, PitchEnvAmount: 1, PitchEnvDecay: 2, Waveform: 3, ToneLevel: 4, NoiseLevel: 5,
  AmpAttack: 6, AmpDecay: 7, AmpSustain: 8, AmpRelease: 9,
  FilterType: 10, FilterCutoff: 11, FilterReso: 12,
  LfoTarget: 13, LfoRate: 14, LfoDepth: 15,
  Drive: 16, EchoTime: 17, EchoFeedback: 18, EchoMix: 19,
  ReverbSize: 20, ReverbMix: 21, Volume: 22,
  // LFO 2 & 3 (appended after Volume; see ParamId in src/model/params.ts).
  Lfo2Target: 23, Lfo2Rate: 24, Lfo2Depth: 25,
  Lfo3Target: 26, Lfo3Rate: 27, Lfo3Depth: 28,
  // Sound-verse expansion (appended after the LFOs; see ParamId in src/model/params.ts).
  NoiseType: 29, OscModType: 30, OscModRatio: 31, OscModAmount: 32,
  Crush: 33, Downsample: 34,
  Lfo1Shape: 35, Lfo2Shape: 36, Lfo3Shape: 37,
  // 2nd oscillator + sync, wavefolder, Karplus-Strong/comb resonator.
  Osc2Mix: 38, Osc2Detune: 39, Sync: 40, Fold: 41,
  CombMix: 42, CombTune: 43, CombDecay: 44,
};

// LFO destination indices, in sync with LFO_TARGETS in src/model/paramSpec.ts.
// LFO_NONE disables the LFO (handled by falling through the routing switch).
const LFO_PITCH = 0, LFO_FILTER = 1, LFO_AMP = 2, LFO_DRIVE = 3, LFO_RESO = 4, LFO_WAVE = 5, LFO_NONE = 6;

// Sound-verse expansion lookup tables — keep in sync with the choice lists in
// src/model/paramSpec.ts (the stored param is the index into these).
// Bit-depth per Crush index (0 = off); sample-rate divisor per Downsample index.
const CRUSH_BITS = [0, 12, 10, 8, 6, 5, 4, 3];
const DOWNSAMPLE_FACTOR = [1, 2, 3, 4, 6, 8, 12, 16];
const FM_INDEX = 4;          // max phase-mod depth (carrier cycles) at OscModAmount = 1
const CRACKLE_DENSITY = 0.03; // probability of a crackle/dust impulse per sample
const METAL_HOLD = 9;        // sample-and-hold period (samples) for "Metal" noise
const FOLD_GAIN = 4;         // extra pre-fold gain at Fold = 1 (more gain = more folds)
const COMB_MAXLEN = 8192;    // resonator delay buffer (≈5Hz lowest tuned pitch at 44.1k)

// One LFO sample for a given shape (0=Sine 1=Tri 2=Saw 3=Square) at phase∈[0,1).
// Sample-and-hold (shape 4) is handled in the voice loop (it needs held state).
function lfoWave(shape, phase) {
  if (shape === 1) return 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1; // triangle
  if (shape === 2) return 2 * phase - 1;                                            // saw (rising)
  if (shape === 3) return phase < 0.5 ? 1 : -1;                                     // square
  return Math.sin(TWO_PI * phase);                                                  // sine
}

const NUM_DRUMS = 32; // physical channel POOL; sounds are bound to channels on demand
const AUDITION = -2;  // reserved sound id for one-shot previews (editor + lane), reuses 1 channel
const NUM_VOICES = 6;
const VOICE_GAIN = 0.9;
const TWO_PI = Math.PI * 2;

const NUM_ROWS = 5;
const NUM_STEPS = 16;

// Note-hold for sequenced hits, in seconds. Tempo-independent so a sound plays
// its full envelope (as heard in the Sounds-view audition, which uses the same
// 0.4s gate) instead of being cut off by the very short 16th-note step length.
const STEP_GATE_SEC = 0.4;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

//============================================================================
// Melody scale -> frequency (port of MelodyScale.h / melodyScale.ts). Owns the
// pitch mapping because the clock lives here. Keep intervals in sync with
// src/model/melodyScale.ts.
const NUM_NOTES = 5;
const SCALE_INTERVALS = [
  [0, 2, 4, 5, 7, 9, 11], // Major
  [0, 2, 3, 5, 7, 8, 10], // Minor
  [0, 2, 4, 7, 9],        // Major pentatonic
  [0, 3, 5, 7, 10],       // Minor pentatonic
];
const ROOT_MIDI = 60;
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function semitoneForRow(row, scaleType) {
  const iv = SCALE_INTERVALS[clamp(scaleType | 0, 0, SCALE_INTERVALS.length - 1)];
  const len = iv.length;
  const degIdx = NUM_NOTES - 1 - row;
  return 12 * Math.floor(degIdx / len) + iv[degIdx % len];
}

// pitchLo/pitchHi = the drum's Pitch range, sent from the main thread.
function frequencyFor(row, rootSemitone, scaleType, pitchLo, pitchHi) {
  const midi = ROOT_MIDI + rootSemitone + semitoneForRow(row, scaleType);
  const refMidi = ROOT_MIDI + rootSemitone + semitoneForRow((NUM_NOTES / 2) | 0, scaleType);
  const drumCentre = Math.sqrt(pitchLo * pitchHi);
  const octaveShift = Math.round(Math.log2(drumCentre / midiToHz(refMidi)));
  const freq = midiToHz(midi) * Math.pow(2, octaveShift);
  return clamp(freq, pitchLo, pitchHi);
}

// Fast xorshift32 noise source (-1..1).
function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s / 4294967296) * 2 - 1;
  };
}

//============================================================================
// Linear ADSR — mirrors juce::ADSR (linear segments; release ramps from the
// current value to 0 over the release time).
class ADSR {
  constructor() {
    this.state = 0; // 0 idle, 1 attack, 2 decay, 3 sustain, 4 release
    this.value = 0;
    this.attackRate = 0; this.decayRate = 0; this.releaseRate = 0;
    this.sustain = 0; this.release = 0; this.sr = 44100;
  }
  setParameters(a, d, s, r, sr) {
    this.sr = sr; this.release = r; this.sustain = s;
    this.attackRate = a > 0 ? 1 / (a * sr) : 1e9;
    this.decayRate = d > 0 ? (1 - s) / (d * sr) : 1e9;
  }
  noteOn() { this.value = 0; this.state = 1; }
  noteOff() {
    if (this.state === 0) return;
    if (this.release > 0 && this.value > 0) {
      this.releaseRate = this.value / (this.release * this.sr);
      this.state = 4;
    } else { this.value = 0; this.state = 0; }
  }
  isActive() { return this.state !== 0; }
  next() {
    switch (this.state) {
      case 1: this.value += this.attackRate; if (this.value >= 1) { this.value = 1; this.state = 2; } break;
      case 2: this.value -= this.decayRate; if (this.value <= this.sustain) { this.value = this.sustain; this.state = 3; } break;
      case 3: break;
      case 4: this.value -= this.releaseRate; if (this.value <= 0) { this.value = 0; this.state = 0; } break;
      default: this.value = 0;
    }
    return this.value;
  }
}

//============================================================================
// TPT state-variable filter (Zavalishin). type: 0=LP, 1=HP, 2=BP.
class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; }
  reset() { this.ic1 = 0; this.ic2 = 0; }
  process(v0, g, k, type) {
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = v0 - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    if (type === 1) return v0 - k * v1 - v2; // high
    if (type === 2) return v1;               // band
    return v2;                               // low
  }
}

//============================================================================
// Karplus-Strong / tuned-comb resonator. A fractional-delay loop with a one-pole
// lowpass in the feedback path: excite it with a noise/osc burst and it rings at
// the tuned pitch — short feedback = a pluck, high feedback = a sustained string.
class KarplusComb {
  constructor() { this.buf = new Float32Array(COMB_MAXLEN); this.w = 0; this.lp = 0; }
  reset() { this.buf.fill(0); this.w = 0; this.lp = 0; }
  // delaySamples: fractional loop length (= sr / tuned-freq). feedback: 0..~1.
  process(input, delaySamples, feedback) {
    let d = delaySamples;
    if (d < 2) d = 2; else if (d > COMB_MAXLEN - 2) d = COMB_MAXLEN - 2;
    let rp = this.w - d;
    while (rp < 0) rp += COMB_MAXLEN;
    const i0 = rp | 0;
    const frac = rp - i0;
    const i1 = i0 + 1 >= COMB_MAXLEN ? 0 : i0 + 1;
    const delayed = this.buf[i0] * (1 - frac) + this.buf[i1] * frac;
    // Gentle loop damping keeps it musical (a touch darker each pass).
    this.lp = this.lp + (delayed - this.lp) * 0.5;
    // Soft-clip the stored sample so a high-Q tuned loop saturates (overdriven
    // string) instead of building up unbounded under sustained excitation.
    this.buf[this.w] = Math.tanh(input + this.lp * feedback);
    if (++this.w >= COMB_MAXLEN) this.w = 0;
    return delayed;
  }
}

//============================================================================
class Voice {
  constructor(sr) {
    this.sr = sr;
    this.active = false;
    this.adsr = new ADSR();
    this.filter = new SVF();
    this.rng = makeRng((Math.random() * 4294967296) >>> 0);
    this.oscPhase = 0; this.pitchEnv = 0; this.pitchEnvCoef = 0;
    this.lfoPhase = [0, 0, 0];
    this.lfoTargets = [0, 0, 0];
    this.lfoRates = [0, 0, 0];
    this.lfoDepths = [0, 0, 0];
    this.lfoShapes = [0, 0, 0];
    this.lfoSH = [0, 0, 0];     // sample-and-hold held value, per LFO
    this.gateSamples = 0; this.samplesPlayed = 0; this.noteOffSent = false;
    // Noise-colour filter state (white needs none; the others are shaped from it).
    this.noiseType = 0;
    this.pinkState = new Float32Array(7);
    this.brown = 0; this.prevWhite = 0; this.prevPink = 0;
    this.metalHold = 0; this.metalCtr = 0;
    // Second-operator (FM/ring) + crusher state.
    this.modType = 0; this.modRatio = 1; this.modAmount = 0; this.modPhase = 0;
    this.crushBits = 0; this.dsFactor = 1; this.dsCtr = 0; this.dsHold = 0;
    // 2nd oscillator (+ hard sync), wavefolder, comb resonator.
    this.osc2Mix = 0; this.osc2Ratio = 1; this.osc2Phase = 0; this.sync = false;
    this.fold = 0;
    this.combMix = 0; this.combRatio = 1; this.combFb = 0;
    this.comb = new KarplusComb();
  }
  start(s, gate) {
    this.basePitch = s[P.Pitch];
    this.pitchEnvAmount = s[P.PitchEnvAmount];
    this.pitchEnvDecay = Math.max(0.001, s[P.PitchEnvDecay]);
    this.waveform = Math.round(s[P.Waveform]);
    this.toneLevel = s[P.ToneLevel];
    this.noiseLevel = s[P.NoiseLevel];
    this.filterType = Math.round(s[P.FilterType]);
    this.filterCutoff = s[P.FilterCutoff];
    this.filterReso = Math.max(0.3, s[P.FilterReso]);
    // Three independent always-on LFOs, each routed by its own destination.
    this.lfoTargets = [Math.round(s[P.LfoTarget]), Math.round(s[P.Lfo2Target]), Math.round(s[P.Lfo3Target])];
    this.lfoRates = [s[P.LfoRate], s[P.Lfo2Rate], s[P.Lfo3Rate]];
    this.lfoDepths = [s[P.LfoDepth], s[P.Lfo2Depth], s[P.Lfo3Depth]];
    this.lfoShapes = [Math.round(s[P.Lfo1Shape]), Math.round(s[P.Lfo2Shape]), Math.round(s[P.Lfo3Shape])];
    this.lfoPhase = [0, 0, 0];
    this.lfoSH = [this.rng(), this.rng(), this.rng()]; // seed S&H for the first cycle
    this.drive = s[P.Drive];

    // --- Sound-verse expansion params ---
    this.noiseType = Math.round(s[P.NoiseType]) | 0;
    this.pinkState.fill(0); this.brown = 0; this.prevWhite = 0; this.prevPink = 0;
    this.metalHold = 0; this.metalCtr = 0;
    this.modType = Math.round(s[P.OscModType]) | 0;
    this.modRatio = s[P.OscModRatio] > 0 ? s[P.OscModRatio] : 1;
    this.modAmount = clamp(s[P.OscModAmount], 0, 1);
    this.modPhase = 0;
    const crushIdx = clamp(Math.round(s[P.Crush]) | 0, 0, CRUSH_BITS.length - 1);
    const dsIdx = clamp(Math.round(s[P.Downsample]) | 0, 0, DOWNSAMPLE_FACTOR.length - 1);
    this.crushBits = CRUSH_BITS[crushIdx];
    this.dsFactor = DOWNSAMPLE_FACTOR[dsIdx];
    this.dsCtr = 0; this.dsHold = 0;

    this.osc2Mix = clamp(s[P.Osc2Mix], 0, 1);
    this.osc2Ratio = Math.pow(2, s[P.Osc2Detune] / 12);
    this.osc2Phase = 0;
    this.sync = Math.round(s[P.Sync]) >= 1;
    this.fold = clamp(s[P.Fold], 0, 1);
    this.combMix = clamp(s[P.CombMix], 0, 1);
    this.combRatio = s[P.CombTune] > 0 ? s[P.CombTune] : 1;
    this.combFb = 0.85 + clamp(s[P.CombDecay], 0, 1) * 0.14; // 0.85 (pluck) .. 0.99 (string)
    this.comb.reset();

    this.adsr.setParameters(
      Math.max(0.0001, s[P.AmpAttack]),
      Math.max(0.0001, s[P.AmpDecay]),
      clamp(s[P.AmpSustain], 0, 1),
      Math.max(0.0001, s[P.AmpRelease]),
      this.sr
    );

    this.oscPhase = 0; this.pitchEnv = 1;
    this.pitchEnvCoef = Math.exp(-1 / (this.pitchEnvDecay * this.sr));
    this.filter.reset();
    this.samplesPlayed = 0; this.noteOffSent = false;
    this.gateSamples = Math.max(1, gate);
    this.adsr.noteOn();
    this.active = true;
  }
  // `pw` is the square-wave duty cycle (0..1, 0.5 = symmetric); ignored by sine/tri.
  osc(phase, wave, pw) {
    if (wave === 1) return 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1; // triangle
    if (wave === 2) return phase < pw ? 1 : -1;                                     // square
    return Math.sin(TWO_PI * phase);                                               // sine
  }
  // One step of the Paul Kellet "refined" pink-noise filter (state in pinkState),
  // returning a roughly -1..1 pink sample for the given white input.
  pinkStep(white) {
    const s = this.pinkState;
    s[0] = 0.99886 * s[0] + white * 0.0555179;
    s[1] = 0.99332 * s[1] + white * 0.0750759;
    s[2] = 0.96900 * s[2] + white * 0.1538520;
    s[3] = 0.86650 * s[3] + white * 0.3104856;
    s[4] = 0.55000 * s[4] + white * 0.5329522;
    s[5] = -0.7616 * s[5] - white * 0.0168980;
    const pink = (s[0] + s[1] + s[2] + s[3] + s[4] + s[5] + s[6] + white * 0.5362) * 0.11;
    s[6] = white * 0.115926;
    return pink;
  }
  // One noise sample shaped to the selected colour. White is flat; the others tilt
  // its spectrum (pink -3dB/oct, brown -6, blue +3, violet +6) or grain it
  // (crackle = sparse impulses, metal = sample-and-hold decimation).
  nextNoise() {
    const white = this.rng();
    switch (this.noiseType) {
      case 1: return this.pinkStep(white);                          // pink
      case 2: this.brown = clamp(this.brown + white * 0.02, -1, 1); // brown (leaky integral)
              return this.brown;
      case 3: { const pink = this.pinkStep(white);                  // blue (pink differentiated)
                const blue = (pink - this.prevPink) * 2; this.prevPink = pink;
                return clamp(blue, -1, 1); }
      case 4: { const violet = (white - this.prevWhite) * 0.5;      // violet (white differentiated)
                this.prevWhite = white; return violet; }
      case 5: return Math.random() < CRACKLE_DENSITY ? white * 3 : 0; // crackle / dust
      case 6: if (--this.metalCtr <= 0) { this.metalHold = white; this.metalCtr = METAL_HOLD; }
              return this.metalHold;                                 // metal (S&H decimated)
      default: return white;                                        // white
    }
  }
  renderAdding(out, n) {
    if (!this.active) return;
    const sr = this.sr;
    const nyquist = sr * 0.5;
    for (let i = 0; i < n; i++) {
      // Evaluate the three LFOs and fold each into its destination's modulator.
      let pitchMul = 1, cutoffMul = 1, ampMul = 1, resoMul = 1, driveAdd = 0, pwOff = 0;
      for (let L = 0; L < 3; L++) {
        const depth = this.lfoDepths[L];
        const shape = this.lfoShapes[L];
        // S&H holds one random value per cycle; the others read the shaped wave.
        const v = shape === 4 ? this.lfoSH[L] : lfoWave(shape, this.lfoPhase[L]); // -1..1
        this.lfoPhase[L] += this.lfoRates[L] / sr;     // advance even when silent
        if (this.lfoPhase[L] >= 1) { this.lfoPhase[L] -= 1; this.lfoSH[L] = this.rng(); }
        if (depth <= 0) continue;
        switch (this.lfoTargets[L]) {
          case LFO_PITCH:  pitchMul  *= Math.pow(2, v * depth * 0.5); break;
          case LFO_FILTER: cutoffMul *= Math.pow(2, v * depth * 2);   break;
          case LFO_AMP:    ampMul    *= 1 - depth * (0.5 * (1 - v));   break;
          case LFO_DRIVE:  driveAdd  += v * depth;                     break;
          case LFO_RESO:   resoMul   *= Math.pow(2, v * depth);        break;
          case LFO_WAVE:   pwOff     += v * depth * 0.45;              break;
          case LFO_NONE:   default:                                   break; // disabled
        }
      }

      let freq = this.basePitch * (1 + this.pitchEnvAmount * this.pitchEnv) * pitchMul;
      this.pitchEnv *= this.pitchEnvCoef;

      // Second operator: a sine modulator at `freq * ratio`, applied as either
      // phase modulation (FM) or amplitude/ring modulation of the carrier.
      let modOut = 0;
      if (this.modType !== 0) {
        modOut = Math.sin(TWO_PI * this.modPhase);
        this.modPhase += (freq * this.modRatio) / sr;
        if (this.modPhase >= 1) this.modPhase -= Math.floor(this.modPhase);
      }
      const pw = clamp(0.5 + pwOff, 0.05, 0.95);
      let carrierPhase = this.oscPhase;
      if (this.modType === 1) carrierPhase += modOut * this.modAmount * FM_INDEX; // FM
      let osc = this.osc(carrierPhase - Math.floor(carrierPhase), this.waveform, pw);
      if (this.modType === 2) osc *= 1 - this.modAmount + this.modAmount * modOut; // ring

      // Detuned 2nd oscillator, blended in (hard-sync handled at the phase advance).
      if (this.osc2Mix > 0) {
        const o2 = this.osc(this.osc2Phase - Math.floor(this.osc2Phase), this.waveform, pw);
        osc += o2 * this.osc2Mix;
      }
      // Wavefolder: drive the wave into a sine fold so it folds back on itself,
      // adding harmonics (bypassed at 0 so the dry wave is untouched).
      if (this.fold > 0) osc = Math.sin(osc * (1 + this.fold * FOLD_GAIN) * 1.5707963);

      const noise = this.nextNoise();
      let mixed = this.toneLevel * osc + this.noiseLevel * noise;

      // Bit/sample-rate crush: decimate (sample-and-hold), then quantise to N bits.
      if (this.dsFactor > 1) {
        if (--this.dsCtr <= 0) { this.dsHold = mixed; this.dsCtr = this.dsFactor; }
        mixed = this.dsHold;
      }
      if (this.crushBits > 0) {
        const step = 2 / (1 << this.crushBits);
        mixed = Math.round(mixed / step) * step;
      }

      this.oscPhase += freq / sr;
      let masterWrapped = false;
      if (this.oscPhase >= 1) { this.oscPhase -= Math.floor(this.oscPhase); masterWrapped = true; }
      if (this.osc2Mix > 0) {
        this.osc2Phase += (freq * this.osc2Ratio) / sr;
        if (this.osc2Phase >= 1) this.osc2Phase -= Math.floor(this.osc2Phase);
        if (this.sync && masterWrapped) this.osc2Phase = 0; // hard sync to oscillator 1
      }

      const cutoff = clamp(this.filterCutoff * cutoffMul, 20, nyquist * 0.99);
      const g = Math.tan(Math.PI * cutoff / sr);
      const k = 1 / clamp(this.filterReso * resoMul, 0.3, 20);
      let filtered = this.filter.process(mixed, g, k, this.filterType);

      const drive = clamp(this.drive + driveAdd, 0, 2);
      if (drive > 0) filtered = Math.tanh(filtered * (1 + drive * 5));

      // Karplus-Strong/comb resonator: excite the tuned loop with the dry signal and
      // blend its ringing output back in. Tuned to the note's pitch × CombTune.
      if (this.combMix > 0) {
        const combFreq = clamp(freq * this.combRatio, 20, nyquist);
        const ringing = this.comb.process(filtered, sr / combFreq, this.combFb);
        filtered = filtered * (1 - this.combMix) + ringing * this.combMix;
      }

      const env = this.adsr.next() * ampMul;
      out[i] += filtered * env * VOICE_GAIN;

      if (!this.noteOffSent && ++this.samplesPlayed >= this.gateSamples) {
        this.adsr.noteOff();
        this.noteOffSent = true;
      }
      if (!this.adsr.isActive()) { this.active = false; break; }
    }
  }
}

//============================================================================
// Simple mono feedback-delay echo.
class Echo {
  constructor(sr) {
    this.bufLen = ((sr * 0.7) | 0) + 4;
    this.buf = new Float32Array(this.bufLen);
    this.w = 0;
  }
  process(input, delay, fb, mix) {
    delay = clamp(delay | 0, 1, this.bufLen - 1);
    let r = this.w - delay;
    if (r < 0) r += this.bufLen;
    const delayed = this.buf[r];
    this.buf[this.w] = input + delayed * fb;
    this.w = (this.w + 1) % this.bufLen;
    return input * (1 - mix) + delayed * mix;
  }
  clear() { this.buf.fill(0); this.w = 0; }
}

//============================================================================
// Freeverb (port of juce::Reverb), mono path.
class Comb {
  constructor(size) { this.buf = new Float32Array(size); this.i = 0; this.last = 0; }
  process(input, damp, fb) {
    const out = this.buf[this.i];
    this.last = out * (1 - damp) + this.last * damp;
    this.buf[this.i] = input + this.last * fb;
    if (++this.i >= this.buf.length) this.i = 0;
    return out;
  }
  clear() { this.buf.fill(0); this.last = 0; }
}
class Allpass {
  constructor(size) { this.buf = new Float32Array(size); this.i = 0; }
  process(input) {
    const buffered = this.buf[this.i];
    this.buf[this.i] = input + buffered * 0.5;
    if (++this.i >= this.buf.length) this.i = 0;
    return buffered - input;
  }
  clear() { this.buf.fill(0); }
}
class Reverb {
  constructor(sr) {
    const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const apT = [556, 441, 341, 225];
    const scale = (t) => Math.max(1, ((sr * t) / 44100) | 0);
    this.combs = combT.map((t) => new Comb(scale(t)));
    this.aps = apT.map((t) => new Allpass(scale(t)));
    this.roomSize = 0.7; this.damp = 0; this.wet = 0; this.dry = 0; this.gain = 0.015;
  }
  // wetLevel/dryLevel scaling matches juce::Reverb (wet*3, dry*2); mono so the
  // two width-split wet gains sum back to `wet`.
  setParameters(roomSize, damping, wetLevel, dryLevel) {
    this.wet = wetLevel * 3.0;
    this.dry = dryLevel * 2.0;
    this.roomSize = roomSize * 0.28 + 0.7;
    this.damp = damping * 0.4;
  }
  processMono(buf, n) {
    for (let i = 0; i < n; i++) {
      const input = buf[i] * this.gain;
      let out = 0;
      for (let c = 0; c < this.combs.length; c++) out += this.combs[c].process(input, this.damp, this.roomSize);
      for (let a = 0; a < this.aps.length; a++) out = this.aps[a].process(out);
      buf[i] = out * this.wet + buf[i] * this.dry;
    }
  }
  reset() { this.combs.forEach((c) => c.clear()); this.aps.forEach((a) => a.clear()); }
}

//============================================================================
class Channel {
  constructor(sr) {
    this.sr = sr;
    this.voices = [];
    for (let i = 0; i < NUM_VOICES; i++) this.voices.push(new Voice(sr));
    this.next = 0;
    this.echo = new Echo(sr);
    this.reverb = new Reverb(sr);
    // Live params (FX/volume + pitch base). Set via setParams, NEVER by trigger,
    // so a pitched melody hit can't clobber the drum's base sound. Mirrors how
    // the C++ engine reads kit.params live while triggering from a snapshot.
    this.params = null;
    // Dynamic allocation: which sound this channel is currently bound to (-1 = free)
    // and the sample-clock time until which it's considered still ringing (its tail),
    // used to choose which channel to steal. See EngineProcessor.allocate.
    this.soundId = -1;
    this.busyUntil = 0;
  }
  setParams(snap) { this.params = snap; }
  hasActiveVoices() {
    for (let i = 0; i < NUM_VOICES; i++) if (this.voices[i].active) return true;
    return false;
  }
  resetFx() { this.echo.clear(); this.reverb.reset(); }
  killVoices() { for (let i = 0; i < NUM_VOICES; i++) this.voices[i].active = false; }
  trigger(snap, gate) {
    for (let i = 0; i < NUM_VOICES; i++) {
      if (!this.voices[i].active) { this.voices[i].start(snap, gate); return; }
    }
    this.voices[this.next].start(snap, gate);
    this.next = (this.next + 1) % NUM_VOICES;
  }
  // Render `n` samples and ADD into master at `offset`. `scratch` is shared temp.
  renderInto(master, scratch, offset, n) {
    if (!this.params) return;
    for (let i = 0; i < n; i++) scratch[i] = 0;
    for (let v = 0; v < NUM_VOICES; v++) this.voices[v].renderAdding(scratch, n);

    const p = this.params;
    const echoMix = p[P.EchoMix];
    if (echoMix > 0.0001) {
      const delay = (p[P.EchoTime] * this.sr) | 0;
      const fb = p[P.EchoFeedback];
      for (let i = 0; i < n; i++) scratch[i] = this.echo.process(scratch[i], delay, fb, echoMix);
    }
    const verbMix = p[P.ReverbMix];
    if (verbMix > 0.0001) {
      this.reverb.setParameters(p[P.ReverbSize], 0.4, verbMix, 1 - verbMix);
      this.reverb.processMono(scratch, n);
    }
    const vol = p[P.Volume];
    for (let i = 0; i < n; i++) master[offset + i] += scratch[i] * vol;
  }
}

//============================================================================
class EngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate; // AudioWorkletGlobalScope global
    this.channels = [];
    for (let i = 0; i < NUM_DRUMS; i++) this.channels.push(new Channel(this.sr));
    this.scratch = new Float32Array(128);
    this.master = new Float32Array(128);

    // --- dynamic sound allocation ---
    // Sound table: id -> { snap (base FX/pitch), lo, hi (pitch range), tail (ring secs) }.
    // Grid cells reference these ids; the engine binds each to a pool channel on demand.
    this.sounds = new Map();
    this.soundToChannel = new Map(); // id -> channel index currently bound to it
    this.clock = 0; // running sample counter, for busyUntil/steal decisions

    // --- pattern + transport state ---
    // Active pattern the loop is currently playing.
    this.blocks = null;      // [{cells:Int, root, scale, keyEnabled} x NUM_BLOCKS]
    this.order = null;       // [grid index | -1] x ORDER_SLOTS
    // Staged pattern: edits while playing land here and are promoted to active
    // only when the loop restarts, so the current pass plays unchanged.
    this.pendingBlocks = null;
    this.pendingOrder = null;
    this.hasPending = false;

    this.tempo = 120;
    this.playing = false;
    this.seqPos = 0;         // position within the ordered sequence
    this.samplesToNextStep = 0;
    this.lastGrid = -2;      // for change-only playhead reporting
    this.lastCol = -2;
    this.lastSlot = -2;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case "setSounds": {
        // Replace the sound table with the painted lanes (id + base snapshot + range + tail).
        this.sounds.clear();
        for (const s of m.sounds) this.sounds.set(s.id, { snap: s.snap, lo: s.lo, hi: s.hi, tail: s.tail });
        break;
      }
      case "audition": // one-shot preview now (editor / lane), on the reserved channel
        this.triggerSound(AUDITION, m.snapshot, m.snapshot, m.gate | 0, m.tail);
        break;
      case "pattern":
        if (this.playing) {
          // Stage; applied at the next loop restart.
          this.pendingBlocks = m.blocks;
          this.pendingOrder = m.order;
          this.hasPending = true;
        } else {
          this.blocks = m.blocks;
          this.order = m.order;
        }
        break;
      case "tempo": this.tempo = m.bpm; break;
      case "play":
        this.promotePending();
        this.playing = true;
        this.seqPos = 0;
        this.samplesToNextStep = 0;
        break;
      case "stop":
        this.playing = false;
        this.promotePending(); // settle staged edits once stopped
        this.reportPlayhead(-1, -1, -1);
        break;
    }
  }

  promotePending() {
    if (this.hasPending) {
      this.blocks = this.pendingBlocks;
      this.order = this.pendingOrder;
      this.hasPending = false;
    }
  }

  samplesPerStep() {
    // 16th notes: four steps per beat.
    return (this.sr * 60) / Math.max(1, this.tempo) / 4;
  }

  reportPlayhead(grid, col, slot, fired) {
    if (grid !== this.lastGrid || col !== this.lastCol || slot !== this.lastSlot) {
      this.lastGrid = grid;
      this.lastCol = col;
      this.lastSlot = slot;
      // `fired` = drum channels triggered on this step, for the mixer's flash LEDs.
      this.port.postMessage({ type: "playhead", grid, col, slot, fired: fired || [] });
    }
  }

  // Pick a pool channel for sound `id`: reuse its current binding, else a free
  // channel, else STEAL the most-idle one (no active voices + earliest busyUntil),
  // which protects sounds still ringing out (large busyUntil) — the longer a sound's
  // tail, the later it's stolen. Returns the channel index, bound to `id`.
  allocate(id) {
    const cur = this.soundToChannel.get(id);
    if (cur !== undefined && this.channels[cur].soundId === id) return cur;

    let best = -1, bestScore = Infinity;
    for (let c = 0; c < NUM_DRUMS; c++) {
      const ch = this.channels[c];
      if (ch.soundId === -1) { best = c; break; } // truly free -> take it
      const score = (ch.hasActiveVoices() ? 1e15 : 0) + ch.busyUntil;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    const ch = this.channels[best];
    if (ch.soundId !== id) {
      if (ch.soundId !== -1) this.soundToChannel.delete(ch.soundId);
      if (ch.hasActiveVoices()) ch.killVoices(); // forced steal of a live channel (rare)
      ch.resetFx();                              // don't bleed the old sound's tail
      ch.soundId = id;
    }
    this.soundToChannel.set(id, best);
    return best;
  }

  // Trigger sound `id`: bind/steal a channel, load its FX params, mark it busy for the
  // estimated tail, and start a voice with the (possibly key-pitched) snapshot.
  triggerSound(id, baseSnap, voiceSnap, gate, tailSec) {
    const c = this.allocate(id);
    const ch = this.channels[c];
    ch.setParams(baseSnap);
    ch.busyUntil = this.clock + gate + Math.max(0, tailSec || 0) * this.sr;
    ch.trigger(voiceSnap, gate);
  }

  // Fire one step of the ordered sequence. Grids are variable-length: a manual grid is
  // 16 steps; a Euclidean grid is its loop length (`len`). Each entry carries its start
  // offset so we can find which grid + local step `seqPos` lands on. Staged edits are
  // promoted only at the loop boundary.
  fireStep(gate) {
    const blocks = this.blocks;
    const order = this.order;
    if (!blocks || !order) { this.reportPlayhead(-1, -1, -1); return; }

    // Build the play sequence with cumulative start offsets + per-grid lengths.
    const seq = [];
    let total = 0;
    for (let i = 0; i < order.length; i++) {
      const gi = order[i];
      if (gi >= 0 && gi < blocks.length) {
        const b = blocks[gi];
        const len = b.euclid ? Math.max(1, b.len | 0) : NUM_STEPS;
        seq.push({ grid: gi, slot: i, start: total, len });
        total += len;
      }
    }
    if (total === 0) { this.reportPlayhead(-1, -1, -1); return; }
    if (this.seqPos >= total) this.seqPos %= total;

    // Find the entry whose [start, start+len) window contains seqPos.
    let e = 0;
    while (e + 1 < seq.length && seq[e + 1].start <= this.seqPos) e++;
    const entry = seq[e];
    const localStep = this.seqPos - entry.start;
    const g = blocks[entry.grid];

    const fired = [];
    if (g.euclid) {
      // Euclidean: each voice (circle) triggers when its pattern hits at localStep,
      // cycling independently (polyrhythm) within the grid's loop length.
      const voices = g.voices || [];
      for (let v = 0; v < voices.length; v++) {
        const vo = voices[v];
        if (!vo || vo.soundId < 0 || !vo.pattern || vo.steps < 1) continue;
        if (!vo.pattern[localStep % vo.steps]) continue;
        const snd = this.sounds.get(vo.soundId);
        if (!snd) continue;
        this.triggerSound(vo.soundId, snd.snap, snd.snap.slice(), gate, snd.tail);
        fired.push(vo.soundId);
      }
    } else {
      // Manual: key targeting — only sounds in keyedDrums get pitched to the row's note
      // (a missing list = all, for older patterns).
      const keyedSet = Array.isArray(g.keyedDrums) ? new Set(g.keyedDrums) : null;
      for (let row = 0; row < NUM_ROWS; row++) {
        const id = g.cells[row * NUM_STEPS + localStep]; // cell = stable sound id
        if (id < 0) continue;
        const snd = this.sounds.get(id);
        if (!snd) continue; // sound was removed -> skip (no empty-channel trigger)

        const voiceSnap = snd.snap.slice();
        if (g.keyEnabled !== false && (keyedSet === null || keyedSet.has(id))) {
          voiceSnap[P.Pitch] = frequencyFor(row, g.root, g.scale, snd.lo, snd.hi);
        }
        this.triggerSound(id, snd.snap, voiceSnap, gate, snd.tail);
        fired.push(id);
      }
    }

    this.reportPlayhead(entry.grid, localStep, entry.slot, fired);

    this.seqPos = (this.seqPos + 1) % total;
    if (this.seqPos === 0) this.promotePending(); // loop completed -> apply staged edits
  }

  renderChannels(master, offset, n) {
    for (let c = 0; c < NUM_DRUMS; c++) this.channels[c].renderInto(master, this.scratch, offset, n);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const n = out[0].length;
    if (this.scratch.length < n) {
      this.scratch = new Float32Array(n);
      this.master = new Float32Array(n);
    }
    const master = this.master;
    for (let i = 0; i < n; i++) master[i] = 0;
    this.clock += n; // sample clock for allocation/steal decisions

    if (!this.playing) {
      this.renderChannels(master, 0, n); // audition / tails keep ringing
    } else {
      let pos = 0;
      while (pos < n) {
        if (this.samplesToNextStep <= 0) {
          this.fireStep((this.sr * STEP_GATE_SEC) | 0);
          this.samplesToNextStep += this.samplesPerStep();
        }
        let chunk = Math.min(n - pos, Math.ceil(this.samplesToNextStep));
        if (chunk < 1) chunk = 1;
        this.renderChannels(master, pos, chunk);
        pos += chunk;
        this.samplesToNextStep -= chunk;
      }
    }

    for (let ch = 0; ch < out.length; ch++) {
      const o = out[ch];
      for (let i = 0; i < n; i++) o[i] = master[i];
    }
    return true;
  }
}

registerProcessor("engine-processor", EngineProcessor);
