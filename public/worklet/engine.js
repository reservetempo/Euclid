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

// --- Parameter indices: mirror ParamId in src/model/params.ts EXACTLY (grouped
// Tone / Amp / Filter / LFO / Fx / Life / Output). A check script asserts they match. ---
const P = {
  // Tone
  Pitch: 0, PitchEnvAmount: 1, PitchEnvDecay: 2, Waveform: 3, ToneLevel: 4, NoiseLevel: 5,
  NoiseType: 6, OscModType: 7, OscModRatio: 8, OscModAmount: 9,
  Osc2Mix: 10, Osc2Detune: 11, Sync: 12, Fold: 13,
  Unison: 14, UnisonDetune: 15, FmFeedback: 16, WaveTable: 17, WavePosition: 18,
  ClickLevel: 19, ClickType: 20,
  // Amp envelope + per-layer decays
  AmpAttack: 21, AmpDecay: 22, AmpSustain: 23, AmpRelease: 24,
  AmpAttackShape: 25, AmpDecayShape: 26, ToneDecay: 27, NoiseDecay: 28, Gate: 29,
  // Filter + physical-model resonators
  FilterType: 30, FilterCutoff: 31, FilterReso: 32,
  CombMix: 33, CombTune: 34, CombDecay: 35,
  ModalMix: 36, ModalMaterial: 37, ModalDecay: 38,
  // LFOs (three blocks: dest / rate / depth / shape / sync)
  LfoTarget: 39, LfoRate: 40, LfoDepth: 41, Lfo1Shape: 42, Lfo1Sync: 43,
  Lfo2Target: 44, Lfo2Rate: 45, Lfo2Depth: 46, Lfo2Shape: 47, Lfo2Sync: 48,
  Lfo3Target: 49, Lfo3Rate: 50, Lfo3Depth: 51, Lfo3Shape: 52, Lfo3Sync: 53,
  // Drive & FX
  Drive: 54, Crush: 55, Downsample: 56,
  ModFxType: 57, ModFxRate: 58, ModFxDepth: 59, ModFxFeedback: 60, ModFxMix: 61,
  EchoTime: 62, EchoFeedback: 63, EchoMix: 64, EchoSync: 65, EchoPing: 66,
  ReverbSize: 67, ReverbMix: 68,
  // Per-hit life
  AccentAmount: 69, Humanize: 70, HitChance: 71, Ratchet: 72, ChokeGroup: 73,
  // Output
  Volume: 74, Pan: 75,
};

// LFO destination indices, in sync with LFO_TARGETS in src/model/paramSpec.ts. LFO_NONE
// disables the LFO (falls through the routing switch); it sits LAST in the list.
const LFO_PITCH = 0, LFO_FILTER = 1, LFO_AMP = 2, LFO_DRIVE = 3, LFO_RESO = 4, LFO_WAVE = 5;
const LFO_NOISE = 6, LFO_CRUSH = 7, LFO_RING = 8, LFO_WTPOS = 9, LFO_NONE = 10; // WTPos = wavetable scan sweep

// Primary-oscillator unison voice count per Unison index (0 = Off = single voice).
const UNISON_VOICES = [1, 3, 5, 7];
const UNISON_MAX = 7;                 // sized for the phase/detune scratch arrays

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
// Click transient layer: exponential decay (seconds) per ClickType index — keep in
// sync with CLICK_TYPES in src/model/paramSpec.ts (Tick/Snap/Knock/Blip/Clank).
const CLICK_DECAY = [0.0015, 0.006, 0.012, 0.004, 0.008];
const CLICK_GAIN = 1.2;      // click peak level at ClickLevel = 1
const BLIP_HZ = 1100;        // fixed pitch of the "Blip" click sine
// Master soft-clip knee: linear (transparent) below, tanh-rounded above, so stacked
// resonant/driven channels saturate gently instead of hard digital clipping at ±1.
const CLIP_KNEE = 0.9;

// --- Modal resonator bank -----------------------------------------------------
// Mode frequency ratios / gains / decay weights per material — indices match
// MODAL_MATERIALS in src/model/paramSpec.ts. Classic measured sets: circular
// membrane, minor-third church bell, free bar (marimba), singing bowl (detuned
// pairs beat against each other), thick metal plate (inharmonic spread).
const MODAL_TABLES = [
  { r: [1, 1.59, 2.14, 2.30, 2.65, 2.92], g: [1, 0.62, 0.40, 0.35, 0.25, 0.20], d: [1, 0.70, 0.55, 0.45, 0.40, 0.35] },
  { r: [0.5, 1, 1.2, 1.5, 2.0, 2.67],     g: [0.5, 1, 0.70, 0.60, 0.50, 0.35],  d: [1.4, 1, 0.90, 0.80, 0.70, 0.50] },
  { r: [1, 2.76, 5.40, 8.93],             g: [1, 0.55, 0.30, 0.15],             d: [1, 0.45, 0.25, 0.15] },
  { r: [1, 1.004, 2.78, 2.79, 5.18, 8.16], g: [0.8, 0.8, 0.60, 0.55, 0.30, 0.15], d: [1.6, 1.6, 1.1, 1.1, 0.70, 0.40] },
  { r: [1, 1.32, 1.72, 2.19, 2.71, 3.49], g: [1, 0.75, 0.65, 0.55, 0.45, 0.35], d: [0.8, 0.70, 0.65, 0.55, 0.50, 0.40] },
];
const MODAL_BASE_DECAY = 0.45; // seconds of ring for mode 0 at ModalDecay = 0.5
const MODAL_MAX_MODES = 6;

// --- Vowel formant filter (FilterType 3) ----------------------------------------
// F1/F2/F3 centre frequencies per vowel; Cutoff (log-mapped 200..8000 Hz) morphs
// A -> E -> I -> O -> U, so a filter LFO literally makes the sound talk.
const VOWELS = [
  [730, 1090, 2440], // A
  [530, 1840, 2480], // E
  [390, 1990, 2550], // I
  [570, 840, 2410],  // O
  [440, 1020, 2240], // U
];
const VOWEL_GAINS = [1, 0.5, 0.25];
const VOWEL_MAKEUP = 1.5;

// --- Wavetable morph oscillator bank --------------------------------------------
// Each family is a set of morph FRAMES; WavePosition scans/crossfades between them.
// Every frame is band-limited into MIP levels (harmonic caps) so high notes don't
// alias — the standard band-limited-wavetable technique. Built once at module load by
// additive synthesis: harmonics are accumulated into one running table and snapshotted
// at each mip's harmonic cap (a single pass per frame). Keep WATABLES/WAVETABLES in
// src/model/paramSpec.ts in sync: family index here = stored WaveTable value minus 1.
const WT_SIZE = 2048;                 // power of two, so phase wrap is a bit-mask
const WT_FRAMES = 4;                  // morph frames per family
const WT_MIP_CAPS = [256, 64, 16];    // harmonics kept per mip (bright -> dull)
const WT_SIN = new Float32Array(WT_SIZE);
// Math.PI*2 spelled out: this table is built at module load, before TWO_PI is declared.
for (let i = 0; i < WT_SIZE; i++) WT_SIN[i] = Math.sin((Math.PI * 2 * i) / WT_SIZE);
// Per-family harmonic amplitude for harmonic h (1-based) at morph position m (0..1).
const WT_FAMILIES = [
  // Formant: a resonant peak that slides UP the harmonic series as m rises.
  (h, m) => { const peak = 1 + m * 22, bw = 4; return Math.exp(-((h - peak) * (h - peak)) / (2 * bw * bw)); },
  // Harmonic: a near-sine that opens into a full 1/h saw as m rises.
  (h, m) => (1 / h) * Math.exp(-h * (1 - m) * 0.12),
  // Vocal: a fixed low formant plus a second peak that moves with m (vowel-ish).
  (h, m) => (Math.exp(-((h - 3) * (h - 3)) / 6) + 0.6 * Math.exp(-((h - (6 + m * 18)) * (h - (6 + m * 18))) / 10)) / Math.sqrt(h),
  // Digital: odd-harmonic square morphing toward a bright inharmonic comb.
  (h, m) => { const odd = h % 2 ? 1 / h : 0; const comb = (1 / h) * (0.5 + 0.5 * Math.sin(h * (1 + m * 3))); return odd * (1 - m) + comb * m; },
];
function buildWavetableBank() {
  const bank = [];
  const maxH = WT_MIP_CAPS[0];
  for (let fam = 0; fam < WT_FAMILIES.length; fam++) {
    const prof = WT_FAMILIES[fam];
    const frames = [];
    for (let fr = 0; fr < WT_FRAMES; fr++) {
      const m = WT_FRAMES > 1 ? fr / (WT_FRAMES - 1) : 0;
      const mips = WT_MIP_CAPS.map(() => new Float32Array(WT_SIZE));
      const acc = new Float32Array(WT_SIZE);
      let mip = WT_MIP_CAPS.length - 1; // start at the dullest cap and brighten
      for (let h = 1; h <= maxH; h++) {
        const a = prof(h, m) || 0;
        if (a > 1e-6 || a < -1e-6) {
          for (let i = 0; i < WT_SIZE; i++) acc[i] += a * WT_SIN[(h * i) % WT_SIZE];
        }
        while (mip >= 0 && h === WT_MIP_CAPS[mip]) { mips[mip].set(acc); mip--; }
      }
      for (const t of mips) {                 // normalise each mip to unit peak
        let pk = 1e-9;
        for (let i = 0; i < WT_SIZE; i++) { const v = t[i] < 0 ? -t[i] : t[i]; if (v > pk) pk = v; }
        const g = 1 / pk;
        for (let i = 0; i < WT_SIZE; i++) t[i] *= g;
      }
      frames.push(mips);
    }
    bank.push(frames);
  }
  return bank;
}
const WT_BANK = buildWavetableBank();
// Read family `fam` (0-based) at morph `pos`, phase `ph` (0..1), picking a mip from the
// per-sample phase step `dt` so partials stay below Nyquist; crossfades the two frames
// nearest `pos` and linearly interpolates within the table.
function wtSample(fam, pos, ph, dt) {
  const frames = WT_BANK[fam];
  const maxHarm = 0.5 / (dt > 1e-6 ? dt : 1e-6);
  let mip = WT_MIP_CAPS.length - 1;
  for (let mm = 0; mm < WT_MIP_CAPS.length; mm++) { if (WT_MIP_CAPS[mm] <= maxHarm) { mip = mm; break; } }
  const fp = clamp(pos, 0, 1) * (WT_FRAMES - 1);
  const f0 = Math.min(WT_FRAMES - 1, fp | 0);
  const f1 = Math.min(WT_FRAMES - 1, f0 + 1);
  const ff = fp - f0;
  const t0 = frames[f0][mip], t1 = frames[f1][mip];
  const x = ph * WT_SIZE;
  const i0 = x | 0, fr = x - i0, i1 = (i0 + 1) & (WT_SIZE - 1);
  const s0 = t0[i0] * (1 - fr) + t0[i1] * fr;
  const s1 = t1[i0] * (1 - fr) + t1[i1] * fr;
  return s0 * (1 - ff) + s1 * ff;
}

// Echo tempo-sync divisions in BEATS (quarter notes) per EchoSync index; 0 = Free
// (use EchoTime seconds). Mirrors ECHO_SYNC_BEATS in src/model/paramSpec.ts.
const ECHO_SYNC_BEATS = [0, 0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2];
// LFO tempo-sync: BEATS spanned by ONE LFO cycle per Lfo*Sync index; 0 = Free (use
// LfoRate Hz). Mirrors LFO_SYNC_BEATS in src/model/paramSpec.ts.
const LFO_SYNC_BEATS = [0, 0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 4];
const ECHO_BUF_SEC = 1.3; // echo buffer length (covers a 1/2-note at >=93 BPM)

// --- Per-hit Life ---------------------------------------------------------------
const ACCENT_DUCK = 0.5;      // non-accent hits duck to 1 - amount*this
const GHOST_P = 0.5;          // a missed hit becomes a quiet ghost this often (else skipped)
const GHOST_LEVEL = 0.3;      // ghost velocity
const HUMANIZE_LEVEL = 0.25;  // ±level jitter at Humanize = 1
const HUMANIZE_PITCH = 0.015; // ±pitch jitter (fraction) at Humanize = 1
const HUMANIZE_CUTOFF = 0.2;  // ±cutoff jitter (fraction) at Humanize = 1
const RATCHET_VEL_DECAY = 0.85; // each ratchet sub-hit is a bit quieter
const CHOKE_RELEASE = 0.02;   // seconds — fast fade when a choke group cuts a sound

// Deterministic accent/ghost weight (0..1) for one hit, from a per-loop LifePlacement
// (see lines.ts). "everyN" marks one hit per group of N at full weight, the rest 0: the
// offset picks WHICH hit in each group (0 = the first, so hits 0, N, 2N…; 1 = the second;
// a negative offset counts from the end, -1 = the last). "ramp" swells the weight across
// the loop (pos01 0→1), bent from linear (curve 0) toward exponential (curve 1), growing
// toward the loop's END (dir "up") or its START (dir "down").
function lifeWeight(spec, hitIndex, pos01) {
  if (!spec) return 0;
  if (spec.mode === "everyN") {
    const n = Math.max(1, spec.every | 0);
    const off = spec.offset | 0;
    return ((((hitIndex - off) % n) + n) % n) === 0 ? 1 : 0;
  }
  const exp = Math.pow(4, clamp(spec.curve || 0, 0, 1)); // 1 (linear) .. 4 (exponential)
  const t = spec.dir === "down" ? 1 - pos01 : pos01;
  return Math.pow(clamp(t, 0, 1), exp);
}

// Bend a transition's blend progress t∈[0,1] (see fireBlend): `curve` 0 (linear) → 1
// (exponential); `dir` "out" (default) eases slowly out of the near end then rushes to the
// far end, "in" rushes early then eases into the far end. Both keep the endpoints (0→0,
// 1→1) so the fade still spans fully. curve 0 / unset = the old linear ramp.
function bendT(t, curve, dir) {
  const c = clamp(curve || 0, 0, 1);
  t = clamp(t, 0, 1);
  if (c <= 0) return t;
  const exp = Math.pow(4, c);
  return dir === "in" ? 1 - Math.pow(1 - t, exp) : Math.pow(t, exp);
}

// Evaluate a transition's blend FUNCTION at span progress t∈[0,1] → blend position
// y∈[0,1]. `env` carries shape/curve/dir/cycles (see BlendShapeId in lines.ts); unset
// shape = "ramp", the old bent line, so bendT keeps its meaning. MUST match blendShape
// in lines.ts (the UI's curve graph and the speed warp use that copy).
// A freehand-drawn function (uniformly sampled y values 0..1), read back by linear
// interpolation. MUST match drawnShapeY in lines.ts.
function drawnY(points, t) {
  const n = points.length;
  if (!n) return clamp(t, 0, 1);
  if (n === 1) return clamp(points[0], 0, 1);
  const x = clamp(t, 0, 1) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  return clamp(points[i] + (points[i + 1] - points[i]) * (x - i), 0, 1);
}

function shapeT(t, env) {
  t = clamp(t, 0, 1);
  const c = clamp(env.curve || 0, 0, 1);
  const cyc = (def) => Math.max(0.25, Math.min(999, env.cycles == null ? def : env.cycles));
  switch (env.shape) {
    case "drawn":
      if (env.points && env.points.length) return drawnY(env.points, t);
      return bendT(t, c, env.dir);
    case "scurve": {
      const k = 4 + c * 12;
      const s = (x) => 1 / (1 + Math.exp(-k * (x - 0.5)));
      const lo = s(0), hi = s(1);
      return (s(t) - lo) / (hi - lo);
    }
    case "parabola": {
      // A smooth arch out and back; `curve` skews the peak late (dir "in") or early.
      const peak = Math.min(0.9, Math.max(0.1, 0.5 + (env.dir === "in" ? 1 : -1) * c * 0.35));
      const x = t <= peak ? t / peak : (1 - t) / (1 - peak);
      return clamp(x * (2 - x), 0, 1);
    }
    case "sine":
      return 0.5 - 0.5 * Math.cos(TWO_PI * cyc(1.5) * bendT(t, c, env.dir));
    case "cos":
      return 0.5 + 0.5 * Math.cos(TWO_PI * cyc(1) * bendT(t, c, env.dir));
    case "zigzag": {
      const ph = (cyc(1.5) * bendT(t, c, env.dir)) % 1;
      return ph < 0.5 ? ph * 2 : 2 - ph * 2;
    }
    case "wobble": {
      // A ramp with a damped swing riding it — lands exactly; `curve` = swing depth.
      const depth = 0.15 + 0.85 * c;
      return clamp(t + 0.5 * depth * Math.sin(TWO_PI * cyc(2) * t) * (1 - t), 0, 1);
    }
    case "steps": {
      const n = Math.max(2, Math.round(env.cycles == null ? 4 : env.cycles));
      return Math.min(1, Math.floor(bendT(t, c, env.dir) * n) / (n - 1));
    }
    case "halfwave": {
      // Half-sine humps centred in their slots, flat rest between; `curve` = the gap
      // (see blendShape in lines.ts — the copies must match).
      const n = cyc(3);
      const w = 1 - 0.9 * c;
      const ph = (t * n) % 1;
      const lo = (1 - w) / 2;
      return ph < lo || ph > lo + w ? 0 : Math.sin(Math.PI * ((ph - lo) / w));
    }
    default: // "ramp" / unset
      return bendT(t, c, env.dir);
  }
}

// shapeT with the graph-calculator TRANSFORM applied on top (the transition Graph tab):
// y·gain + shift, clamped to [min, max] and then to [0,1]. All fields default to the
// identity so plain envelopes/sweeps are untouched. MUST match blendShapeY in lines.ts.
function shapeY(t, env) {
  let y = shapeT(t, env) * (env.yGain == null ? 1 : env.yGain) + (env.yBias == null ? 0 : env.yBias);
  y = clamp(y, env.yMin == null ? 0 : env.yMin, env.yMax == null ? 1 : env.yMax);
  return clamp(y, 0, 1);
}

// The ONE parameter each silence-end fade sweeps (see silentVariant / nearVariant and the
// UI's TRANSITION_SWEEP). The far end may also touch secondary params (crush's Downsample,
// echo's Feedback, wash's Size) — those stay automatic; only this primary one is From→To
// editable. Modes not listed here (pair morphs) don't sweep a single param.
const SWEEP_PARAM = {
  fade: P.Volume, filter: P.FilterCutoff, wash: P.ReverbMix,
  thin: P.HitChance, drive: P.Drive, crush: P.Crush, echo: P.EchoMix,
};

// Standard 2-sample polyBLEP residual: the correction to add around a unit step
// discontinuity at phase 0 (t = distance into/before the edge in cycles, dt = phase
// increment per sample). Smooths oscillator edges so they don't alias.
function polyBlep(t, dt) {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}

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

// One bar = 16 sixteenth-note steps (4/4). Node lengths are bars × this; staged
// pattern edits are promoted at bar boundaries so changes land musically.
const STEPS_PER_BAR = 16;

// Note-hold for sequenced hits, in seconds. Tempo-independent so a sound plays
// its full envelope (as heard in the Sounds-view audition, which uses the same
// 0.4s gate) instead of being cut off by the very short 16th-note step length.
const STEP_GATE_SEC = 0.4;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

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
// Shaped ADSR. Each segment advances a linear phase t∈[0,1] and maps it through a
// power curve, so the segment TIME is exact and only its contour changes:
//   attack  value = t^aExp                          (from 0 to 1)
//   decay   value = sustain + (1-sustain)·(1-t)^dExp (from 1 to sustain)
//   release value = start·(1-t)^dExp                 (from the current value to 0)
// A shape of 0.5 maps to exponent 1 = the exact legacy linear ADSR. Shape < 0.5
// (exp < 1) starts fast: a plucky attack / a gated hold-then-drop decay. Shape > 0.5
// (exp > 1) starts slow: a swelling attack / a percussive fast-drop-long-tail decay.
function shapeExp(shape) {
  const s = shape === undefined ? 0.5 : clamp(shape, 0, 1);
  return Math.pow(4, s * 2 - 1); // 0..1 -> 0.25..4, 0.5 -> 1 (linear)
}
class ADSR {
  constructor() {
    this.state = 0; // 0 idle, 1 attack, 2 decay, 3 sustain, 4 release
    this.value = 0;
    this.t = 0; // linear phase of the current segment
    this.attackInc = 0; this.decayInc = 0; this.releaseInc = 0;
    this.aExp = 1; this.dExp = 1;
    this.sustain = 0; this.release = 0; this.releaseStart = 0; this.sr = 44100;
  }
  setParameters(a, d, s, r, sr, aShape, dShape) {
    this.sr = sr; this.release = r; this.sustain = s;
    this.attackInc = a > 0 ? 1 / (a * sr) : 2;
    this.decayInc = d > 0 ? 1 / (d * sr) : 2;
    this.aExp = shapeExp(aShape);
    this.dExp = shapeExp(dShape);
  }
  noteOn() { this.value = 0; this.t = 0; this.state = 1; }
  noteOff() {
    if (this.state === 0) return;
    if (this.release > 0 && this.value > 0) {
      this.releaseStart = this.value;
      this.releaseInc = 1 / (this.release * this.sr);
      this.t = 0;
      this.state = 4;
    } else { this.value = 0; this.state = 0; }
  }
  isActive() { return this.state !== 0; }
  next() {
    switch (this.state) {
      case 1:
        this.t += this.attackInc;
        if (this.t >= 1) { this.value = 1; this.t = 0; this.state = 2; }
        else this.value = Math.pow(this.t, this.aExp);
        break;
      case 2:
        this.t += this.decayInc;
        if (this.t >= 1) { this.value = this.sustain; this.state = 3; }
        else this.value = this.sustain + (1 - this.sustain) * Math.pow(1 - this.t, this.dExp);
        break;
      case 3: break;
      case 4:
        this.t += this.releaseInc;
        if (this.t >= 1) { this.value = 0; this.state = 0; }
        else this.value = this.releaseStart * Math.pow(1 - this.t, this.dExp);
        break;
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
// Modal resonator bank: up to 6 two-pole resonators tuned to a material's mode
// ratios (see MODAL_TABLES) — the classic bells/bars/membranes synthesis. Driven
// continuously like the comb: feed it the dry signal, blend its ringing output.
// Each resonator: y[n] = b1·y[n-1] + b2·y[n-2] + g·x[n], with r set from the mode's
// decay time and g normalised by (1-r) so ring level is decay-independent.
class ModalBank {
  constructor() {
    this.n = 0;
    this.b1 = new Float32Array(MODAL_MAX_MODES);
    this.b2 = new Float32Array(MODAL_MAX_MODES);
    this.g = new Float32Array(MODAL_MAX_MODES);
    this.y1 = new Float32Array(MODAL_MAX_MODES);
    this.y2 = new Float32Array(MODAL_MAX_MODES);
  }
  // Configure for a material at a base frequency; modes above 0.45·sr are dropped
  // (they'd alias), which naturally darkens high-pitched modal sounds.
  setup(material, baseFreq, decayScale, sr) {
    const t = MODAL_TABLES[clamp(material | 0, 0, MODAL_TABLES.length - 1)];
    let n = 0;
    for (let k = 0; k < t.r.length && n < MODAL_MAX_MODES; k++) {
      const f = baseFreq * t.r[k];
      if (f > sr * 0.45 || f < 15) continue;
      const decay = Math.max(0.01, MODAL_BASE_DECAY * t.d[k] * decayScale);
      const r = Math.exp(-1 / (decay * sr));
      const w = TWO_PI * f / sr;
      this.b1[n] = 2 * r * Math.cos(w);
      this.b2[n] = -r * r;
      // Unit-order gains suit the impulsive excitation drums provide; the tanh on
      // the summed output (below) bounds the rare sustained-resonance blow-up the
      // way the comb's in-loop tanh does (reads as an overdriven ringing bell).
      this.g[n] = t.g[k] * 0.9;
      n++;
    }
    this.n = n;
    this.y1.fill(0);
    this.y2.fill(0);
  }
  process(x) {
    let out = 0;
    for (let k = 0; k < this.n; k++) {
      const y = this.b1[k] * this.y1[k] + this.b2[k] * this.y2[k] + x * this.g[k];
      this.y2[k] = this.y1[k];
      this.y1[k] = y;
      out += y;
    }
    return Math.tanh(out);
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
    this.lfoSyncs = [0, 0, 0];  // tempo-sync index per LFO (0 = Free, use lfoRates Hz)
    this.lfoInc = [0, 0, 0];    // per-sample phase increments, refreshed per block (live tempo)
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
    // Fatter oscillators: primary-osc unison stack + FM operator self-feedback, and a
    // wavetable morph oscillator that replaces the analog shape when wtFamily > 0.
    this.unisonCount = 1; this.unisonNorm = 1;
    this.uPhase = new Float32Array(UNISON_MAX);
    this.uDetune = new Float32Array(UNISON_MAX);
    this.fmFeedback = 0; this.fbMod = 0;
    this.wtFamily = 0; this.wtPos = 0;
    this.combMix = 0; this.combRatio = 1; this.combFb = 0;
    this.comb = new KarplusComb();
    // Layer envelopes (per-source exponential decays) + click transient state.
    this.toneEnvCoef = 0; this.noiseEnvCoef = 0; this.toneEnv = 1; this.noiseEnv = 1;
    this.clickLevel = 0; this.clickType = 0; this.clickEnv = 0; this.clickCoef = 0;
    this.clickPhase = 0; this.clickFreq = 0; this.clickPrev = 0;
    this.clickHold = 0; this.clickCtr = 0;
    // Modal resonator bank + vowel formant filters (formants only run in vowel mode).
    this.modal = new ModalBank(); this.modalMix = 0;
    this.vf = [new SVF(), new SVF(), new SVF()];
    // Per-hit life: velocity scale + ratchet retrigger schedule.
    this.vel = 1;
    this.ratchetLeft = 0; this.ratchetInterval = 0; this.ratchetCountdown = 0;
    // Sub-step onset delay (samples): silence before the note begins, so a speed
    // transition's warped hits land BETWEEN grid steps instead of snapping to them.
    this.startDelay = 0;
    // Per-note pitch TRACK: a sampled multiplier curve the note's pitch keeps following
    // AFTER note-on (a held drone inside a morph transition glides with the function
    // instead of freezing at its note-on pitch). { mults, durSamples } or null.
    this.pitchTrack = null;
    this.trackPos = 0;
  }
  // `vel` scales the hit (accents/ghosts/humanize); `ratchetCount`/`ratchetInterval`
  // (samples) re-strike the envelope for drum-roll bursts within the step.
  // `beatPos` is the transport position in BEATS at the hit (0 when not sequenced),
  // used to phase-lock tempo-synced LFOs to the beat grid. `startDelay` (samples) holds
  // the note off for a fraction of a step (speed-transition sub-step timing).
  // `pitchTrack` ({ mults, durSamples }) keeps the note's pitch following a transition's
  // blend function across its hold — see morphPitchTrack.
  start(s, gate, vel, ratchetCount, ratchetInterval, beatPos, startDelay, pitchTrack) {
    this.vel = vel === undefined ? 1 : vel;
    this.startDelay = Math.max(0, startDelay | 0);
    this.pitchTrack = pitchTrack && pitchTrack.mults && pitchTrack.mults.length > 1 && pitchTrack.durSamples > 0
      ? pitchTrack : null;
    this.trackPos = 0;
    this.ratchetLeft = (ratchetCount | 0) > 1 ? (ratchetCount | 0) - 1 : 0;
    this.ratchetInterval = Math.max(1, ratchetInterval | 0);
    this.ratchetCountdown = this.ratchetInterval;
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
    this.lfoSyncs = [Math.round(s[P.Lfo1Sync]), Math.round(s[P.Lfo2Sync]), Math.round(s[P.Lfo3Sync])];
    // A tempo-synced LFO starts phase-locked to the transport's beat grid (the
    // echo's tempo-sync applied to modulation): every hit's wobble lands the same
    // way against the bar, wherever in the cycle the note falls. Free LFOs keep
    // the legacy per-hit restart at phase 0.
    for (let L = 0; L < 3; L++) {
      const beats = LFO_SYNC_BEATS[this.lfoSyncs[L]] || 0;
      this.lfoPhase[L] = beats > 0 && beatPos > 0 ? (beatPos / beats) % 1 : 0;
    }
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

    // Fatter oscillators: unison stack (primary osc only), FM operator self-feedback,
    // and the wavetable morph oscillator.
    const uIdx = clamp(Math.round(s[P.Unison]) | 0, 0, UNISON_VOICES.length - 1);
    this.unisonCount = UNISON_VOICES[uIdx];
    this.unisonNorm = 1 / Math.sqrt(this.unisonCount);
    const spreadCents = clamp(s[P.UnisonDetune], 0, 1) * 50; // up to ~50 cents each way
    for (let u = 0; u < this.unisonCount; u++) {
      const c = this.unisonCount > 1 ? (u / (this.unisonCount - 1)) * 2 - 1 : 0; // -1..1
      this.uDetune[u] = Math.pow(2, (c * spreadCents) / 1200);
      this.uPhase[u] = this.rng() * 0.5 + 0.5; // decorrelate the stack (rng is -1..1)
    }
    this.fmFeedback = clamp(s[P.FmFeedback], 0, 1) * Math.PI; // up to ±π feedback
    this.fbMod = 0;
    this.wtFamily = clamp(Math.round(s[P.WaveTable]) | 0, 0, WT_FAMILIES.length);
    this.wtPos = clamp(s[P.WavePosition], 0, 1);
    this.combMix = clamp(s[P.CombMix], 0, 1);
    this.combRatio = s[P.CombTune] > 0 ? s[P.CombTune] : 1;
    this.combFb = 0.85 + clamp(s[P.CombDecay], 0, 1) * 0.14; // 0.85 (pluck) .. 0.99 (string)
    this.comb.reset();

    // Layering: per-source exponential decays (0 = follow the amp envelope) and the
    // click transient.
    const toneDec = s[P.ToneDecay];
    const noiseDec = s[P.NoiseDecay];
    this.toneEnvCoef = toneDec > 0.004 ? Math.exp(-1 / (toneDec * this.sr)) : 0;
    this.noiseEnvCoef = noiseDec > 0.004 ? Math.exp(-1 / (noiseDec * this.sr)) : 0;
    this.toneEnv = 1; this.noiseEnv = 1;
    this.clickLevel = clamp(s[P.ClickLevel], 0, 1);
    this.clickType = clamp(Math.round(s[P.ClickType]), 0, CLICK_DECAY.length - 1);
    this.clickEnv = this.clickLevel > 0 ? 1 : 0;
    this.clickCoef = Math.exp(-1 / (CLICK_DECAY[this.clickType] * this.sr));
    this.clickPhase = 0;
    this.clickFreq = this.clickType === 3 ? BLIP_HZ : Math.max(60, this.basePitch * 2);
    this.clickPrev = 0; this.clickHold = 0; this.clickCtr = 0;

    // Modal resonator bank, tuned to the note's base pitch. ModalDecay scales every
    // mode's ring time by 4^(2(v-0.5)) — 0.25x tight .. 4x long ring.
    this.modalMix = clamp(s[P.ModalMix], 0, 1);
    if (this.modalMix > 0) {
      const decayScale = Math.pow(4, (clamp(s[P.ModalDecay], 0, 1) - 0.5) * 2);
      this.modal.setup(Math.round(s[P.ModalMaterial]), this.basePitch, decayScale, this.sr);
    }
    for (let i = 0; i < 3; i++) this.vf[i].reset();

    this.adsr.setParameters(
      Math.max(0.0001, s[P.AmpAttack]),
      Math.max(0.0001, s[P.AmpDecay]),
      clamp(s[P.AmpSustain], 0, 1),
      Math.max(0.0001, s[P.AmpRelease]),
      this.sr,
      s[P.AmpAttackShape], // 0.5 = linear, see shapeExp
      s[P.AmpDecayShape]
    );

    this.oscPhase = 0; this.pitchEnv = 1;
    this.pitchEnvCoef = Math.exp(-1 / (this.pitchEnvDecay * this.sr));
    this.filter.reset();
    this.samplesPlayed = 0; this.noteOffSent = false;
    // A per-sound Gate (seconds) sets the note-hold; an absent/zero param (old
    // snapshots) falls back to the fixed gate the sequencer passed in.
    const gateSec = s[P.Gate];
    this.gateSamples = gateSec > 0 ? Math.max(1, (gateSec * this.sr) | 0) : Math.max(1, gate);
    this.adsr.noteOn();
    this.active = true;
  }
  // Choke-group cut: force a fast release (~20ms) so the sound ducks out of the way
  // of the incoming same-group hit instead of being hard-silenced with a click.
  choke() {
    if (!this.active) return;
    this.adsr.release = CHOKE_RELEASE;
    this.adsr.noteOff();
    this.noteOffSent = true;
    this.ratchetLeft = 0;
  }
  // `pw` is the square-wave duty cycle (0..1, 0.5 = symmetric); ignored by sine/tri/saw.
  // `dt` is the per-sample phase increment (freq/sr), used to polyBLEP-smooth the
  // square/saw edges — naive edges alias badly at high pitch (a big screech source).
  osc(phase, wave, pw, dt) {
    if (wave === 1) return 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1; // triangle
    if (wave === 2) {                                                               // square
      let v = phase < pw ? 1 : -1;
      v += polyBlep(phase, dt);                     // rising edge at 0
      let tf = phase - pw + 1; if (tf >= 1) tf -= 1;
      v -= polyBlep(tf, dt);                        // falling edge at pw
      return v;
    }
    if (wave === 3) return 2 * phase - 1 - polyBlep(phase, dt);                     // saw (rising)
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
  renderAdding(out, n, tempo) {
    if (!this.active) return;
    const sr = this.sr;
    const nyquist = sr * 0.5;
    // Effective LFO phase increments for this block: a synced LFO's cycle spans its
    // division at the LIVE tempo (mirroring the echo's tempo-sync, so BPM changes
    // retune it mid-ring); Free uses the Rate knob in Hz.
    for (let L = 0; L < 3; L++) {
      const beats = LFO_SYNC_BEATS[this.lfoSyncs[L]] || 0;
      this.lfoInc[L] = (beats > 0 ? Math.max(1, tempo || 120) / (60 * beats) : this.lfoRates[L]) / sr;
    }
    for (let i = 0; i < n; i++) {
      // Sub-step onset delay: stay silent until the warped onset time arrives (the note
      // is armed but hasn't begun), so speed-transition hits sit off the grid.
      if (this.startDelay > 0) { this.startDelay--; continue; }
      // Ratchet: re-strike the envelope (and the one-shot transients) on schedule so
      // one step becomes a 2-4 hit burst. Each sub-hit re-arms its own gate and lands
      // slightly quieter than the last.
      if (this.ratchetLeft > 0 && --this.ratchetCountdown <= 0) {
        this.ratchetLeft--;
        this.ratchetCountdown = this.ratchetInterval;
        this.adsr.noteOn();
        this.pitchEnv = 1;
        this.toneEnv = 1; this.noiseEnv = 1;
        if (this.clickLevel > 0) { this.clickEnv = 1; this.clickPhase = 0; }
        this.vel *= RATCHET_VEL_DECAY;
        this.samplesPlayed = 0;
        this.noteOffSent = false;
      }
      // Evaluate the three LFOs and fold each into its destination's modulator.
      let pitchMul = 1, cutoffMul = 1, ampMul = 1, resoMul = 1, driveAdd = 0, pwOff = 0;
      let noiseMul = 1, ringMul = 1, crushShift = 0, wtPosOff = 0;
      for (let L = 0; L < 3; L++) {
        const depth = this.lfoDepths[L];
        const shape = this.lfoShapes[L];
        // S&H holds one random value per cycle; the others read the shaped wave.
        const v = shape === 4 ? this.lfoSH[L] : lfoWave(shape, this.lfoPhase[L]); // -1..1
        this.lfoPhase[L] += this.lfoInc[L];            // advance even when silent
        if (this.lfoPhase[L] >= 1) { this.lfoPhase[L] -= 1; this.lfoSH[L] = this.rng(); }
        if (depth <= 0) continue;
        switch (this.lfoTargets[L]) {
          case LFO_PITCH:  pitchMul  *= Math.pow(2, v * depth * 0.5); break;
          case LFO_FILTER: cutoffMul *= Math.pow(2, v * depth * 2);   break;
          case LFO_AMP:    ampMul    *= 1 - depth * (0.5 * (1 - v));   break;
          case LFO_DRIVE:  driveAdd  += v * depth;                     break;
          case LFO_RESO:   resoMul   *= Math.pow(2, v * depth);        break;
          case LFO_WAVE:   pwOff     += v * depth * 0.45;              break;
          case LFO_NOISE:  noiseMul  *= 1 - depth * (0.5 * (1 - v));   break; // noise-layer tremolo
          case LFO_CRUSH:  crushShift += v * depth * 4;                break; // ± bit-depth swing
          case LFO_RING:   ringMul   *= 1 + v * depth;                 break; // bipolar AM (ring)
          case LFO_WTPOS:  wtPosOff  += v * depth * 0.5;               break; // wavetable scan sweep
          case LFO_NONE:   default:                                   break; // disabled
        }
      }

      // Pitch track: keep gliding along the transition's function through the hold
      // (linear interpolation over the sampled multiplier curve; holds its final
      // value past the end). Rides UNDER the pitch env / LFOs — they modulate around
      // the moving centre. Ratchet re-strikes don't reset it (time keeps flowing).
      let trackMul = 1;
      if (this.pitchTrack) {
        const tr = this.pitchTrack;
        const last = tr.mults.length - 1;
        if (this.trackPos >= tr.durSamples) {
          trackMul = tr.mults[last];
        } else {
          const x = (this.trackPos / tr.durSamples) * last;
          const i0 = Math.min(last - 1, x | 0);
          trackMul = tr.mults[i0] + (tr.mults[i0 + 1] - tr.mults[i0]) * (x - i0);
        }
        this.trackPos++;
      }

      // Bipolar pitch env: positive drops from above; negative starts low/pinned at
      // the 5Hz floor and RISES into the note as the envelope decays (swells/zaps).
      let freq = this.basePitch * trackMul * (1 + this.pitchEnvAmount * this.pitchEnv) * pitchMul;
      if (freq < 5) freq = 5;
      this.pitchEnv *= this.pitchEnvCoef;

      // Second operator: a sine modulator at `freq * ratio`, applied as either
      // phase modulation (FM) or amplitude/ring modulation of the carrier.
      let modOut = 0;
      if (this.modType !== 0) {
        // Self-feedback FM: the operator's own last output bends its phase, morphing the
        // modulator sine -> saw -> noisy for grittier FM (0 feedback = the plain sine).
        this.fbMod = Math.sin(TWO_PI * this.modPhase + this.fmFeedback * this.fbMod);
        modOut = this.fbMod;
        this.modPhase += (freq * this.modRatio) / sr;
        if (this.modPhase >= 1) this.modPhase -= Math.floor(this.modPhase);
      }
      const pw = clamp(0.5 + pwOff, 0.05, 0.95);
      const dt = Math.min(0.25, freq / sr); // phase step for the polyBLEP edges
      const fmOff = this.modType === 1 ? modOut * this.modAmount * FM_INDEX : 0; // FM phase offset
      const wtScan = this.wtPos + wtPosOff;
      // Primary oscillator: a wavetable frame (wtFamily>0) or the analog Sine/Tri/Square/
      // Saw shape, optionally stacked as a detuned unison (primary osc only) summed and
      // normalised by 1/√count. Unison=Off runs the single-voice path = today's sound.
      let osc;
      if (this.unisonCount > 1) {
        let sum = 0;
        for (let u = 0; u < this.unisonCount; u++) {
          let ph = this.uPhase[u] + fmOff; ph -= Math.floor(ph);
          const dtu = Math.min(0.25, dt * this.uDetune[u]);
          sum += this.wtFamily > 0 ? wtSample(this.wtFamily - 1, wtScan, ph, dtu)
                                   : this.osc(ph, this.waveform, pw, dtu);
        }
        osc = sum * this.unisonNorm;
      } else {
        let ph = this.oscPhase + fmOff; ph -= Math.floor(ph);
        osc = this.wtFamily > 0 ? wtSample(this.wtFamily - 1, wtScan, ph, dt)
                                : this.osc(ph, this.waveform, pw, dt);
      }
      if (this.modType === 2) osc *= 1 - this.modAmount + this.modAmount * modOut; // ring

      // Detuned 2nd oscillator, blended in (hard-sync handled at the phase advance).
      if (this.osc2Mix > 0) {
        const dt2 = Math.min(0.25, dt * this.osc2Ratio);
        const o2 = this.osc(this.osc2Phase - Math.floor(this.osc2Phase), this.waveform, pw, dt2);
        osc += o2 * this.osc2Mix;
      }
      // Wavefolder: drive the wave into a sine fold so it folds back on itself,
      // adding harmonics (bypassed at 0 so the dry wave is untouched).
      if (this.fold > 0) osc = Math.sin(osc * (1 + this.fold * FOLD_GAIN) * 1.5707963);

      const noise = this.nextNoise();
      // Layer envelopes: each source can decay on its own clock (0 = follow the amp
      // ADSR, which still gates the whole voice at the end of the chain).
      let toneAmp = this.toneLevel, noiseAmp = this.noiseLevel;
      if (this.toneEnvCoef > 0) { toneAmp *= this.toneEnv; this.toneEnv *= this.toneEnvCoef; }
      if (this.noiseEnvCoef > 0) { noiseAmp *= this.noiseEnv; this.noiseEnv *= this.noiseEnvCoef; }
      if (noiseMul !== 1) noiseAmp *= noiseMul; // a NOISE-destination LFO breathes the layer
      let mixed = toneAmp * osc + noiseAmp * noise;

      // A RING-destination LFO amplitude-modulates the whole mix (bipolar — full depth
      // swings through zero, the classic ring-mod tremble).
      if (ringMul !== 1) mixed *= ringMul;

      // Bit/sample-rate crush: decimate (sample-and-hold), then quantise to N bits.
      // A CRUSH-destination LFO swings the bit depth around the knob (or around 10
      // bits when the crusher is off), so the grit itself wobbles.
      if (this.dsFactor > 1) {
        if (--this.dsCtr <= 0) { this.dsHold = mixed; this.dsCtr = this.dsFactor; }
        mixed = this.dsHold;
      }
      let bits = this.crushBits;
      if (crushShift !== 0) bits = clamp((bits || 10) - crushShift, 2, 16);
      if (bits > 0) {
        const step = 2 / Math.pow(2, bits);
        mixed = Math.round(mixed / step) * step;
      }

      this.oscPhase += freq / sr;
      let masterWrapped = false;
      if (this.oscPhase >= 1) { this.oscPhase -= Math.floor(this.oscPhase); masterWrapped = true; }
      if (this.unisonCount > 1) {
        for (let u = 0; u < this.unisonCount; u++) {
          this.uPhase[u] += (freq * this.uDetune[u]) / sr;
          if (this.uPhase[u] >= 1) this.uPhase[u] -= Math.floor(this.uPhase[u]);
        }
      }
      if (this.osc2Mix > 0) {
        this.osc2Phase += (freq * this.osc2Ratio) / sr;
        if (this.osc2Phase >= 1) this.osc2Phase -= Math.floor(this.osc2Phase);
        if (this.sync && masterWrapped) this.osc2Phase = 0; // hard sync to oscillator 1
      }

      const cutoff = clamp(this.filterCutoff * cutoffMul, 20, nyquist * 0.99);
      let filtered;
      if (this.filterType === 3) {
        // Vowel mode: Cutoff (log 200..8000Hz) is a morph position along A-E-I-O-U;
        // three parallel bandpasses sit on the interpolated formants. The filter LFO
        // therefore sweeps through vowels — a talking wah.
        const c = clamp(cutoff, 200, 8000);
        const pos = (Math.log(c / 200) / Math.log(40)) * (VOWELS.length - 1); // log(8000/200)=log(40)
        const i0 = clamp(pos | 0, 0, VOWELS.length - 2);
        const fr = clamp(pos - i0, 0, 1);
        const kf = 1 / clamp(this.filterReso * resoMul * 3, 0.5, 30); // formants want high Q
        filtered = 0;
        for (let f = 0; f < 3; f++) {
          const ff = VOWELS[i0][f] * (1 - fr) + VOWELS[i0 + 1][f] * fr;
          const gf = Math.tan(Math.PI * clamp(ff, 40, nyquist * 0.9) / sr);
          filtered += this.vf[f].process(mixed, gf, kf, 2) * VOWEL_GAINS[f];
        }
        filtered *= VOWEL_MAKEUP;
      } else {
        const g = Math.tan(Math.PI * cutoff / sr);
        const k = 1 / clamp(this.filterReso * resoMul, 0.3, 20);
        filtered = this.filter.process(mixed, g, k, this.filterType);
      }

      // Click transient layer: a few-ms burst injected AFTER the main filter (so a
      // low-pass body can't dull it) and before drive/comb (so drive glues it in and
      // it can pluck the resonator). One-shot per note, independent of the gate.
      if (this.clickEnv > 1e-4) {
        let c;
        switch (this.clickType) {
          case 1: c = this.rng(); break;                                  // snap: white burst
          case 2: case 3:                                                 // knock / blip: sine thud/ping
            c = Math.sin(TWO_PI * this.clickPhase);
            this.clickPhase += this.clickFreq / sr;
            if (this.clickPhase >= 1) this.clickPhase -= 1;
            break;
          case 4:                                                         // clank: S&H metal grit
            if (--this.clickCtr <= 0) { this.clickHold = this.rng(); this.clickCtr = METAL_HOLD; }
            c = this.clickHold; break;
          default: {                                                      // tick: violet spike
            const w = this.rng(); c = (w - this.clickPrev) * 0.7; this.clickPrev = w;
          }
        }
        filtered += c * this.clickEnv * this.clickLevel * CLICK_GAIN;
        this.clickEnv *= this.clickCoef;
      }

      const drive = clamp(this.drive + driveAdd, 0, 2);
      if (drive > 0) filtered = Math.tanh(filtered * (1 + drive * 5));

      // Karplus-Strong/comb resonator: excite the tuned loop with the dry signal and
      // blend its ringing output back in. Tuned to the note's pitch × CombTune.
      if (this.combMix > 0) {
        const combFreq = clamp(freq * this.combRatio, 20, nyquist);
        const ringing = this.comb.process(filtered, sr / combFreq, this.combFb);
        filtered = filtered * (1 - this.combMix) + ringing * this.combMix;
      }

      // Modal resonator bank: bells/bars/membranes ringing at the note's mode set.
      if (this.modalMix > 0) {
        const ring = this.modal.process(filtered);
        filtered = filtered * (1 - this.modalMix) + ring * this.modalMix;
      }

      const env = this.adsr.next() * ampMul;
      out[i] += filtered * env * VOICE_GAIN * this.vel;

      if (!this.noteOffSent && ++this.samplesPlayed >= this.gateSamples) {
        this.adsr.noteOff();
        this.noteOffSent = true;
      }
      if (!this.adsr.isActive()) { this.active = false; break; }
    }
  }
}

//============================================================================
// Simple mono feedback-delay echo. Buffer sized for the longest tempo-synced
// division (a 1/2-note) at reasonable tempos; longer delays clamp to the buffer.
class Echo {
  constructor(sr) {
    this.bufLen = ((sr * ECHO_BUF_SEC) | 0) + 4;
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
// Modulation FX (chorus / flanger / phaser). Mono in, STEREO out: two quadrature
// LFO phases (L = sin, R = sin+90°) give real width. Chorus/flanger are a modulated
// delay line (chorus = longer delay, no/low feedback; flanger = short delay + feedback
// resonance); phaser is a 6-stage allpass cascade whose notch frequency the LFO sweeps,
// also with feedback. `type` 1/2/3 = chorus/flanger/phaser; mirrors MODFX_TYPES.
class ModFx {
  constructor(sr) {
    this.sr = sr;
    this.buf = new Float32Array(((sr * 0.05) | 0) + 4); // 50 ms max delay
    this.w = 0;
    this.phase = 0;
    this.fbL = 0; this.fbR = 0;         // 1-sample feedback memory (per side)
    this.apL = new Float32Array(6);     // phaser allpass state (per stage, per side)
    this.apR = new Float32Array(6);
    this.type = 0; this.rate = 0; this.depth = 0; this.fbAmt = 0;
    this.baseD = 0; this.modD = 0;      // delay centre / sweep (samples)
  }
  setup(type, rate, depth, fb) {
    this.type = type;
    this.rate = clamp(rate, 0.01, 8);
    this.depth = clamp(depth, 0, 1);
    this.fbAmt = clamp(fb, 0, 1) * 0.9; // keep below self-oscillation
    const sr = this.sr;
    if (type === 1) { this.baseD = 0.012 * sr; this.modD = 0.008 * sr * this.depth; }      // chorus
    else if (type === 2) { this.baseD = 0.0015 * sr; this.modD = 0.003 * sr * this.depth; } // flanger
  }
  readInterp(d) {
    const len = this.buf.length;
    let rp = this.w - d;
    while (rp < 0) rp += len;
    const i0 = rp | 0, fr = rp - i0, i1 = (i0 + 1) % len;
    return this.buf[i0] * (1 - fr) + this.buf[i1] * fr;
  }
  // Phaser: run one side's 6 allpass stages, notch swept by `lfo` (-1..1), with feedback.
  phaser(x, lfo, state, fbPrev) {
    const f = 300 * Math.pow(30, (0.5 + 0.5 * lfo)); // ~300 Hz .. ~9 kHz sweep
    const t = Math.tan(Math.PI * clamp(f, 20, this.sr * 0.45) / this.sr);
    const a = (t - 1) / (t + 1);
    let s = x + fbPrev * this.fbAmt;
    for (let k = 0; k < 6; k++) { const y = a * s + state[k]; state[k] = s - a * y; s = y; }
    return s;
  }
  // Fill stereo `outL`/`outR` (length n) from mono `inp`. No dry mix here — the caller
  // blends wet against dry so the mix knob and pan stay in one place.
  render(inp, n, outL, outR) {
    const inc = this.rate / this.sr;
    for (let i = 0; i < n; i++) {
      const x = inp[i];
      const lfoL = Math.sin(TWO_PI * this.phase);
      const lfoR = Math.sin(TWO_PI * (this.phase + 0.25));
      this.phase += inc; if (this.phase >= 1) this.phase -= 1;
      if (this.type === 3) {
        this.fbL = this.phaser(x, lfoL, this.apL, this.fbL);
        this.fbR = this.phaser(x, lfoR, this.apR, this.fbR);
        outL[i] = this.fbL; outR[i] = this.fbR;
      } else {
        const dL = this.baseD + this.modD * (0.5 + 0.5 * lfoL);
        const dR = this.baseD + this.modD * (0.5 + 0.5 * lfoR);
        const wetL = this.readInterp(dL), wetR = this.readInterp(dR);
        this.buf[this.w] = x + (wetL + wetR) * 0.5 * this.fbAmt; // flanger feedback
        this.w = (this.w + 1) % this.buf.length;
        outL[i] = wetL; outR[i] = wetR;
      }
    }
  }
  reset() { this.buf.fill(0); this.w = 0; this.phase = 0; this.fbL = 0; this.fbR = 0; this.apL.fill(0); this.apR.fill(0); }
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
    this.modfx = new ModFx(sr);
    this.wetL = new Float32Array(128); // stereo modulation-FX wet (block <= 128 samples)
    this.wetR = new Float32Array(128);
    // Live params (FX/volume + pitch base). Set via setParams, NEVER by trigger,
    // so a pitched melody hit can't clobber the drum's base sound. Mirrors how
    // the C++ engine reads kit.params live while triggering from a snapshot.
    this.params = null;
    // Dynamic allocation: which sound this channel is currently bound to (-1 = free)
    // and the sample-clock time until which it's considered still ringing (its tail),
    // used to choose which channel to steal. See EngineProcessor.allocate.
    this.soundId = -1;
    this.busyUntil = 0;
    // Ping-pong echo delay lines, allocated lazily the first time a sound here
    // actually uses ping-pong (they double the echo memory otherwise).
    this.pingL = null;
    this.pingR = null;
    this.pingW = 0;
  }
  setParams(snap) { this.params = snap; }
  hasActiveVoices() {
    for (let i = 0; i < NUM_VOICES; i++) if (this.voices[i].active) return true;
    return false;
  }
  resetFx() {
    this.echo.clear();
    this.reverb.reset();
    this.modfx.reset();
    if (this.pingL) { this.pingL.fill(0); this.pingR.fill(0); this.pingW = 0; }
  }
  killVoices() { for (let i = 0; i < NUM_VOICES; i++) this.voices[i].active = false; }
  chokeVoices() { for (let i = 0; i < NUM_VOICES; i++) this.voices[i].choke(); }
  trigger(snap, gate, vel, ratchetCount, ratchetInterval, beatPos, startDelay, pitchTrack) {
    for (let i = 0; i < NUM_VOICES; i++) {
      if (!this.voices[i].active) { this.voices[i].start(snap, gate, vel, ratchetCount, ratchetInterval, beatPos, startDelay, pitchTrack); return; }
    }
    this.voices[this.next].start(snap, gate, vel, ratchetCount, ratchetInterval, beatPos, startDelay, pitchTrack);
    this.next = (this.next + 1) % NUM_VOICES;
  }
  // Render `n` samples and ADD into the STEREO master at `offset`. `scratch` is
  // shared temp; `tempo` sizes tempo-synced echo delays.
  renderInto(masterL, masterR, scratch, offset, n, tempo) {
    if (!this.params) return;
    for (let i = 0; i < n; i++) scratch[i] = 0;
    for (let v = 0; v < NUM_VOICES; v++) this.voices[v].renderAdding(scratch, n, tempo);

    const p = this.params;
    const echoMix = p[P.EchoMix];
    const ping = echoMix > 0.0001 && p[P.EchoPing] >= 0.5;
    // Effective echo delay: a tempo division when synced, else free EchoTime seconds.
    const sync = Math.round(p[P.EchoSync]);
    const beats = ECHO_SYNC_BEATS[sync] || 0;
    const delaySec = beats > 0 ? (beats * 60) / Math.max(1, tempo || 120) : p[P.EchoTime];
    const delay = (delaySec * this.sr) | 0;
    const fb = p[P.EchoFeedback];
    if (echoMix > 0.0001 && !ping) {
      for (let i = 0; i < n; i++) scratch[i] = this.echo.process(scratch[i], delay, fb, echoMix);
    }
    const verbMix = p[P.ReverbMix];
    if (verbMix > 0.0001) {
      this.reverb.setParameters(p[P.ReverbSize], 0.4, verbMix, 1 - verbMix);
      this.reverb.processMono(scratch, n);
    }
    // Modulation FX (chorus/flanger/phaser): a stereo wet pair from the mono chain, blended
    // in by ModFxMix. Dry is scaled by (1-mix) and the wet added to L/R below.
    const modType = Math.round(p[P.ModFxType]);
    const modMix = clamp(p[P.ModFxMix], 0, 1);
    const modOn = modType > 0 && modMix > 0.0001;
    if (modOn) {
      this.modfx.setup(modType, p[P.ModFxRate], p[P.ModFxDepth], p[P.ModFxFeedback]);
      this.modfx.render(scratch, n, this.wetL, this.wetR);
    }
    const dryG = modOn ? 1 - modMix : 1;
    const vol = p[P.Volume];
    // Constant-power pan, normalised so a CENTRED sound sums into L/R at exactly the
    // old mono level (legacy projects sound identical); hard-panned sides gain +3dB.
    const pan = clamp(p[P.Pan], -1, 1);
    const ang = (pan + 1) * 0.25 * Math.PI;
    const gl = Math.cos(ang) * Math.SQRT2;
    const gr = Math.sin(ang) * Math.SQRT2;

    if (ping) {
      // Stereo ping-pong: the dry (panned) signal feeds the L line, the L line feeds
      // the R line, and R feeds back into L — repeats bounce L, R, L·fb, R·fb, ...
      // spread wide regardless of the dry pan position.
      if (!this.pingL) {
        this.pingL = new Float32Array(this.echo.bufLen);
        this.pingR = new Float32Array(this.echo.bufLen);
        this.pingW = 0;
      }
      const len = this.echo.bufLen;
      const d = clamp(delay, 1, len - 1);
      for (let i = 0; i < n; i++) {
        const dry = scratch[i] * vol;
        let r = this.pingW - d;
        if (r < 0) r += len;
        const dl = this.pingL[r], drt = this.pingR[r];
        this.pingL[this.pingW] = dry + drt * fb;
        this.pingR[this.pingW] = dl;
        this.pingW = (this.pingW + 1) % len;
        const wl = modOn ? this.wetL[i] * vol * modMix : 0;
        const wr = modOn ? this.wetR[i] * vol * modMix : 0;
        masterL[offset + i] += (dry * gl * (1 - echoMix) + dl * echoMix) * dryG + wl;
        masterR[offset + i] += (dry * gr * (1 - echoMix) + drt * echoMix) * dryG + wr;
      }
    } else if (modOn) {
      for (let i = 0; i < n; i++) {
        const s = scratch[i] * vol;
        masterL[offset + i] += s * gl * dryG + this.wetL[i] * vol * modMix;
        masterR[offset + i] += s * gr * dryG + this.wetR[i] * vol * modMix;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const s = scratch[i] * vol;
        masterL[offset + i] += s * gl;
        masterR[offset + i] += s * gr;
      }
    }
  }
}

//============================================================================
class EngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.sr = sampleRate; // AudioWorkletGlobalScope global
    this.channels = [];
    for (let i = 0; i < NUM_DRUMS; i++) this.channels.push(new Channel(this.sr));
    this.scratch = new Float32Array(128);
    this.masterL = new Float32Array(128);
    this.masterR = new Float32Array(128);

    // --- dynamic sound allocation ---
    // Sound table: id -> { snap (base FX/pitch), lo, hi (pitch range), tail (ring secs) }.
    // Grid cells reference these ids; the engine binds each to a pool channel on demand.
    this.sounds = new Map();
    this.soundToChannel = new Map(); // id -> channel index currently bound to it
    this.clock = 0; // running sample counter, for busyUntil/steal decisions

    // --- lines + transport state ---
    // Active voice lines: [{ nodes: [{soundId, steps, lenSteps, waitSteps, pattern, intro?, outro?}] } x 6].
    // The loop is the LONGEST line; each reads pos = absStep % loopTotal, plays its
    // chain once (active node by cumulative lenSteps; inside a node the leading
    // waitSteps are silent, then the pattern cycles via activeLocal % steps), then
    // rests once pos passes its own length.
    this.lines = null;
    // Staged lines: edits while playing land here and are promoted at the next BAR
    // boundary, so changes land musically instead of mid-bar.
    this.pendingLines = null;
    this.hasPending = false;

    // Section loop: when the UI is editing one node, the transport loops just that
    // node's [start, start+len) window of the global loop (every line still plays its
    // own content there), so you audition the edit in context. 0 len = whole loop.
    this.sectionStart = 0;
    this.sectionLen = 0;

    this.tempo = 120;
    this.playing = false;
    // Monotonic 16th-note counter since the last play/restart — the single clock
    // every line reads its own phase from.
    this.absStep = 0;
    // Bounded render: stop sequencing after this many steps (0 = play forever). Used by
    // the offline export to render exactly N loops, then let tails/FX ring out.
    this.maxSteps = 0;
    this.samplesToNextStep = 0;
    this.playheadStopped = false; // one "stopped" playhead post per stop

    this.port.onmessage = (e) => this.onMessage(e.data);

    // Offline export bootstrap: an OfflineAudioContext renders to completion the moment
    // startRendering() is called, so port messages posted just before it race the render
    // and can be missed. Instead the whole render config is passed in processorOptions and
    // applied synchronously here, so playback is fully set up before the first quantum.
    const o = options && options.processorOptions;
    if (o && o.render) {
      if (Array.isArray(o.sounds)) {
        for (const s of o.sounds) this.sounds.set(s.id, { snap: s.snap, lo: s.lo, hi: s.hi, tail: s.tail });
      }
      this.lines = o.lines || null;
      this.tempo = o.tempo || 120;
      this.maxSteps = o.maxSteps | 0;
      this.sectionStart = o.sectionStart | 0; // optional: render just a section
      this.sectionLen = o.sectionLen | 0;
      this.playing = true;
      this.absStep = 0;
    }
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
      case "lines":
        if (this.playing && !m.restart) {
          // Stage; applied at the next bar boundary so the current bar plays unchanged.
          this.pendingLines = m.lines;
          this.hasPending = true;
        } else {
          // Not playing, or an explicit restart — apply now and, if playing, jump the
          // transport back to the top.
          this.lines = m.lines;
          this.hasPending = false;
          this.pendingLines = null;
          if (this.playing) { this.absStep = 0; this.samplesToNextStep = 0; }
        }
        break;
      case "section":
        // Loop just a node's window (immediate). len 0 clears it (whole loop).
        this.sectionStart = Math.max(0, m.start | 0);
        this.sectionLen = Math.max(0, m.len | 0);
        break;
      case "tempo": this.tempo = m.bpm; break;
      case "play":
        this.promotePending();
        this.playing = true;
        this.absStep = 0;
        this.maxSteps = m.maxSteps | 0;
        this.samplesToNextStep = 0;
        break;
      case "stop":
        this.playing = false;
        this.promotePending(); // settle staged edits once stopped
        this.reportPlayhead(null, []);
        break;
    }
  }

  promotePending() {
    if (this.hasPending) {
      this.lines = this.pendingLines;
      this.hasPending = false;
    }
  }

  samplesPerStep() {
    // 16th notes: four steps per beat.
    return (this.sr * 60) / Math.max(1, this.tempo) / 4;
  }

  // `lines` = per-line { node, step } (the active node index + the step within its
  // pattern cycle), or null when stopped. `fired` = sound ids triggered this step.
  // `pos` = the global loop position in 16th steps (section offset included), for the
  // UI's bar-grid playhead. Posted once per 16th step while playing (each line has its
  // own phase, so the state genuinely changes every step) and once with null on stop.
  reportPlayhead(lines, fired, pos) {
    if (lines === null) {
      if (this.playheadStopped) return;
      this.playheadStopped = true;
    } else {
      this.playheadStopped = false;
    }
    this.port.postMessage({ type: "playhead", lines, fired: fired || [], pos: pos || 0 });
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
  // `vel` and the ratchet pair come from perHit (accents/ghosts/humanize/rolls);
  // `beatPos` (transport beats at the hit) phase-locks tempo-synced LFOs to the grid.
  // `startDelay` (samples) holds a warped speed-transition hit off the grid.
  // `pitchTrack` keeps a held note's pitch following a morph window (see morphPitchTrack).
  triggerSound(id, baseSnap, voiceSnap, gate, tailSec, vel, ratchetCount, ratchetInterval, beatPos, startDelay, pitchTrack) {
    // Choke groups: this hit silences every other sound in its group (fast-release,
    // not a hard cut) — the classic closed-hat-chokes-open-hat relationship.
    const group = Math.round(baseSnap[P.ChokeGroup]);
    if (group > 0) {
      for (const [sid, ci] of this.soundToChannel) {
        if (sid === id) continue;
        const os = this.sounds.get(sid);
        if (os && Math.round(os.snap[P.ChokeGroup]) === group) this.channels[ci].chokeVoices();
      }
    }
    const c = this.allocate(id);
    const ch = this.channels[c];
    ch.setParams(baseSnap);
    // Match the voice's per-sound gate so a long-held sound keeps its channel for the
    // whole hold (not just the default gate) before it's eligible to be stolen.
    const gateSec = baseSnap[P.Gate];
    const holdSamples = gateSec > 0 ? (gateSec * this.sr) | 0 : gate;
    ch.busyUntil = this.clock + holdSamples + Math.max(0, tailSec || 0) * this.sr;
    ch.trigger(voiceSnap, gate, vel, ratchetCount, ratchetInterval, beatPos, startDelay, pitchTrack);
  }

  // Per-hit Life: given a sound's snapshot and the hit CONTEXT, roll velocity/
  // ghosting/ratcheting for ONE hit. Returns null when the hit is dropped entirely,
  // else { vel, human, count, interval }. Uses Math.random (not the shuffle's seeded
  // RNG) — this is live feel, not design.
  //
  // `ctx` = { isAccent, hitIndex, pos01, accent?, ghost? }. When the node carries a
  // per-loop accent/ghost LifePlacement (see lines.ts), placement is DETERMINISTIC —
  // every Nth hit, or a ramp across the loop — overriding the sound's own random
  // accent/HitChance for that axis; each axis falls back to the sound's random feel
  // when its spec is absent. `hitIndex` is the hit's ordinal across the loop and
  // `pos01` its position 0..1 through the sounding window.
  perHit(s, ctx) {
    const isAccent = ctx && ctx.isAccent;
    const accentSpec = ctx && ctx.accent;
    const ghostSpec = ctx && ctx.ghost;
    let vel = 1;

    // Accent axis: per-loop placement (deterministic) or the sound's own accent.
    if (accentSpec) {
      const w = lifeWeight(accentSpec, ctx.hitIndex, ctx.pos01); // 1 = full, 0 = ducked
      vel *= 1 - ACCENT_DUCK * accentSpec.amount * (1 - w);
    } else {
      const accent = clamp(s[P.AccentAmount], 0, 1);
      if (accent > 0 && !isAccent) vel *= 1 - ACCENT_DUCK * accent;
    }

    // Ghost axis: per-loop placement designates quiet hits; else the random HitChance
    // path (a missed hit becomes a ghost or a full drop).
    if (ghostSpec) {
      const w = lifeWeight(ghostSpec, ctx.hitIndex, ctx.pos01); // 1 = fully ghosted
      vel *= 1 - (1 - GHOST_LEVEL) * ghostSpec.amount * w;
    } else {
      const chance = clamp(s[P.HitChance], 0, 1);
      if (chance < 1 && Math.random() > chance) {
        if (Math.random() < GHOST_P) vel *= GHOST_LEVEL;
        else return null; // dropped hit
      }
    }

    const human = clamp(s[P.Humanize], 0, 1);
    if (human > 0) vel *= 1 + (Math.random() * 2 - 1) * HUMANIZE_LEVEL * human;
    let count = 0, interval = 0;
    const ratchet = clamp(s[P.Ratchet], 0, 1);
    if (ratchet > 0 && Math.random() < ratchet) {
      const r = Math.random();
      count = r < 0.5 ? 2 : r < 0.8 ? 3 : 4;
      interval = Math.max(1, Math.round(this.samplesPerStep() / count));
    }
    return { vel: Math.max(0.05, vel), human, count, interval };
  }

  // Humanize jitters the per-hit COPY of the snapshot (a few cents of pitch, a bit
  // of cutoff) so repeats stop being bit-identical. The base sound is untouched.
  jitterSnap(voiceSnap, human) {
    if (human <= 0) return;
    voiceSnap[P.Pitch] *= 1 + (Math.random() * 2 - 1) * HUMANIZE_PITCH * human;
    voiceSnap[P.FilterCutoff] *= 1 + (Math.random() * 2 - 1) * HUMANIZE_CUTOFF * human;
  }

  // A copy of a snapshot tuned to an absolute pitch in Hz (for melody notes — one
  // instrument re-pitched per scale degree). The rest of the sound is unchanged.
  pitchedSnap(snap, hz) {
    const v = snap.slice();
    v[P.Pitch] = hz;
    return v;
  }

  // The "silence end" of a fade transition: a copy of a sound's snapshot pushed to
  // inaudibility the way the chosen style wants — pure level ("fade"), a shut filter
  // ("filter"; up for HP so every type sweeps from its quiet end), drowned far away
  // in reverb ("wash"), hits that mostly don't play ("thin" — HitChance 0, so near
  // the silent end most hits vanish and the survivors are ghosts), or an FX extreme
  // the sound emerges from / dissolves into — heavy saturation ("drive"), bit/rate
  // crush ("crush"), or a wash of delay ("echo") — the same drive/FX palette as the
  // voice params, each still ducked in level so it reads as the quiet end. Morphing
  // between this and the real snapshot IS the fade.
  // `to`, when given (a per-transition From→To override, see lines.ts TRANSITION_SWEEP),
  // replaces the built-in far-end value of the mode's PRIMARY swept param; the secondary
  // params and the volume duck are unchanged.
  silentVariant(snap, mode, to) {
    const v = snap.slice();
    const vol = v[P.Volume];
    const has = to !== undefined && to !== null;
    if (mode === "filter") {
      const hp = Math.round(v[P.FilterType]) === 1;
      v[P.FilterCutoff] = has ? to : (hp ? 9000 : 120); // just past the UI's 200..8000 sweep
      v[P.Volume] = vol * 0.25;
    } else if (mode === "wash") {
      v[P.ReverbMix] = has ? to : 1;
      v[P.ReverbSize] = Math.max(0.8, v[P.ReverbSize]);
      v[P.Volume] = vol * 0.2;
    } else if (mode === "thin") {
      v[P.HitChance] = has ? to : 0;
      v[P.Volume] = vol * 0.5;
    } else if (mode === "drive") {
      v[P.Drive] = has ? to : 1.5;  // hard saturation at the far end, easing to the clean sound
      v[P.Volume] = vol * 0.35;
    } else if (mode === "crush") {
      v[P.Crush] = has ? to : 4;    // low bit-depth index (see CRUSH_BITS) + coarse sample-rate
      v[P.Downsample] = 5;          // (see DOWNSAMPLE_FACTOR) for a degraded, lo-fi far end
      v[P.Volume] = vol * 0.4;
    } else if (mode === "echo") {
      v[P.EchoMix] = has ? to : 0.6; // drowned in delay at the far end, drying into the sound
      v[P.EchoFeedback] = Math.max(0.6, v[P.EchoFeedback]);
      v[P.Volume] = vol * 0.3;
    } else {
      v[P.Volume] = has ? to : 0; // "fade": a pure level ramp
    }
    return v;
  }

  // The NEAR/steady end of a silence-end fade: the real sound, but with the mode's primary
  // swept param overridden to `from` when given (else the sound's own value). Paired with
  // silentVariant (the far end) to run a From→To sweep instead of always starting from the
  // sound as-is. Identity when `from` is unset — the pre-sweep behaviour.
  nearVariant(snap, mode, from) {
    if (from === undefined || from === null) return snap;
    const id = SWEEP_PARAM[mode];
    if (id === undefined) return snap;
    const v = snap.slice();
    v[id] = from;
    return v;
  }

  // Linear blend of two parameter snapshots at t∈[0,1] — the per-hit morph a
  // transition node plays. Continuous params glide; discrete "type" params (waveform,
  // filter, etc.) land on the nearer end because the voice reads them through
  // Math.round, so they flip at the midpoint. Both snapshots are full-length.
  lerpSnap(a, b, t) {
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
    return out;
  }

  // Fire one blended hit for a node's intro/outro fade at blend point t∈[0,1]. `from`
  // and `to` are the two ends' sounds (null = silence). `ownId` is the channel the
  // morph/fade sounds on (the node's OWN sound); `fromId`/`toId` name the channels used
  // when both voices play at once (crossfade/alternate/filter). Modes mirror the four
  // pair blends plus the silence-end fade styles (fade/filter/wash/thin/drive/crush/echo).
  // `mode` may be an ARRAY of silence-end styles (a multi-select) — they compose via
  // sweptSnap; pair blends only ever receive a single mode.
  // `ctx` is the per-hit Life context (accent/ghost placement) forwarded to perHit.
  fireBlend(ownId, fromId, from, toId, to, mode, t, ctx, gate, beat, fired, nearV, farV) {
    if (!from && !to) return;
    const modes = Array.isArray(mode) ? mode : [mode];
    mode = modes[0];
    if (!from || !to) {
      // One end is silence: morph the real sound between its near variant (From) and each
      // style's silent variant, composed in order. `nearV`/`farV` are the optional From→To
      // overrides (primary style only). An intro (`to` set) rises effect → sound.
      const real = to || from;
      const snap = this.sweptSnap(real.snap, modes, t, to ? "in" : "out", nearV, farV);
      const hit = this.perHit(snap, ctx);
      if (!hit) return;
      const voiceSnap = snap.slice(); this.jitterSnap(voiceSnap, hit.human);
      this.triggerSound(ownId, snap, voiceSnap, gate, real.tail, hit.vel, hit.count, hit.interval, beat);
      fired.push(ownId);
    } else if (mode === "crossfade") {
      // Both sounds play on their own channels, from fading out as to fades in.
      const hit = this.perHit(from.snap, ctx);
      if (!hit) return;
      if (1 - t > 0.02) {
        const vsA = from.snap.slice(); this.jitterSnap(vsA, hit.human);
        this.triggerSound(fromId, from.snap, vsA, gate, from.tail, hit.vel * (1 - t), hit.count, hit.interval, beat);
        fired.push(fromId);
      }
      if (t > 0.02) {
        const vsB = to.snap.slice(); this.jitterSnap(vsB, hit.human);
        this.triggerSound(toId, to.snap, vsB, gate, to.tail, hit.vel * t, hit.count, hit.interval, beat);
        fired.push(toId);
      }
    } else if (mode === "alternate") {
      // Every hit comes from ONE side, the coin weighting to→1 as t rises.
      const pickTo = Math.random() < t;
      const src = pickTo ? to : from;
      const id = pickTo ? toId : fromId;
      const hit = this.perHit(src.snap, ctx);
      if (!hit) return;
      const vs = src.snap.slice(); this.jitterSnap(vs, hit.human);
      this.triggerSound(id, src.snap, vs, gate, src.tail, hit.vel, hit.count, hit.interval, beat);
      fired.push(id);
    } else if (mode === "filter") {
      // Spectral crossfade: both play while from's filter closes and to's opens.
      const hit = this.perHit(from.snap, ctx);
      if (!hit) return;
      if (1 - t > 0.02) {
        const a = this.lerpSnap(from.snap, this.silentVariant(from.snap, "filter"), t);
        const vsA = a.slice(); this.jitterSnap(vsA, hit.human);
        this.triggerSound(fromId, a, vsA, gate, from.tail, hit.vel, hit.count, hit.interval, beat);
        fired.push(fromId);
      }
      if (t > 0.02) {
        const b = this.lerpSnap(this.silentVariant(to.snap, "filter"), to.snap, t);
        const vsB = b.slice(); this.jitterSnap(vsB, hit.human);
        this.triggerSound(toId, b, vsB, gate, to.tail, hit.vel, hit.count, hit.interval, beat);
        fired.push(toId);
      }
    } else {
      // Morph: one voice with its parameters lerped from→to (the sound mutates).
      const snap = this.lerpSnap(from.snap, to.snap, t);
      const hit = this.perHit(snap, ctx);
      if (!hit) return;
      const voiceSnap = snap.slice(); this.jitterSnap(voiceSnap, hit.human);
      this.triggerSound(ownId, snap, voiceSnap, gate, Math.max(from.tail || 0, to.tail || 0), hit.vel, hit.count, hit.interval, beat);
      fired.push(ownId);
    }
  }

  // Fire the re-timed hits of a SPEED transition for the current step. `env` is the
  // intro/outro carrying the span's precomputed warped onsets (`env.warp` — fractional
  // steps within the sounding window, see warpOnsets in lines.ts). Those whose integer
  // step equals `activeLocal` fire now, held off the grid by their fractional part
  // (startDelay samples) so the hits rush / drag smoothly.
  // Speed STACKS with tonal styles: any other modes in `env.modes` morph each hit's
  // snapshot at its own blend position through the span (sweptSnap — an intro rises
  // effect → sound as its onsets settle onto the grid, an outro the reverse), so a
  // "Rush + Filter" intro rushes in WHILE the filter opens. Speed alone keeps the plain
  // sound — timing only.
  fireSpeedStep(nd, snd, env, side, span, activeLocal, activeLen, gate, beat, fired) {
    const onsets = env.warp;
    if (!onsets || !onsets.length) return;
    const spb = this.samplesPerStep();
    const baseSnap = nd.pitchHz > 0 ? this.pitchedSnap(snd.snap, nd.pitchHz) : snd.snap;
    const tonal = (env.modes || [env.mode]).filter((m) => m !== "speed");
    const spanStart = side === "intro" ? 0 : activeLen - span;
    for (let k = 0; k < onsets.length; k++) {
      const o = onsets[k];
      if (Math.floor(o) !== activeLocal) continue; // not this step's onset(s)
      const delay = Math.round((o - activeLocal) * spb);
      const pos01 = activeLen > 1 ? clamp(o / (activeLen - 1), 0, 1) : 1;
      const life = { isAccent: k === 0, hitIndex: k, pos01, accent: nd.accent, ghost: nd.ghost };
      let snap = baseSnap;
      if (tonal.length) {
        const raw = clamp((o - spanStart) / Math.max(1, span), 0, 1);
        const t = shapeY(raw, env);
        snap = this.sweptSnap(baseSnap, tonal, t, side === "intro" ? "in" : "out", env.from, env.to);
      }
      const hit = this.perHit(snap, life);
      if (!hit) continue;
      const voiceSnap = snap.slice(); this.jitterSnap(voiceSnap, hit.human);
      this.triggerSound(nd.soundId, snap, voiceSnap, gate, snd.tail, hit.vel, hit.count, hit.interval, beat, delay);
      fired.push(nd.soundId);
    }
  }

  // Fire the re-timed hits of any SPEED row sweeps covering lane position `pos`, and
  // report whether one covers it at all (its span then owns the grid — steady hits are
  // replaced by the warp, like a node's own speed span). Each warp entry fires its
  // SOURCE node's sound (the window may cross node boundaries), morphed through every
  // covering window's TONAL styles at the onset's own progress, and held off the grid
  // by its fractional part. See warpSweepOnsets in lines.ts for the precompute.
  fireRowWarpAt(ln, pos, gate, fired) {
    const sweeps = ln && ln.sweeps;
    if (!sweeps) return false;
    const spb = this.samplesPerStep();
    const beat = this.absStep * 0.25;
    let covered = false;
    for (let si = 0; si < sweeps.length; si++) {
      const sw = sweeps[si];
      if (!sw.warp || pos < sw.from || pos >= sw.to) continue;
      covered = true;
      const warp = sw.warp;
      for (let k = 0; k < warp.length; k++) {
        const e = warp[k];
        if (Math.floor(e.o) !== pos) continue; // not this step's onset(s)
        const nd = ln.nodes[e.ni];
        const snd = nd ? this.sounds.get(nd.soundId) : null;
        if (!snd) continue;
        let snap = nd.pitchHz > 0 ? this.pitchedSnap(snd.snap, nd.pitchHz) : snd.snap;
        const preSweepPitch = snap[P.Pitch];
        // Compose every covering window's tonal morph at the onset's own position —
        // the speed window's own tonal styles included (a "Rush + Filter" sweep rushes
        // WHILE the filter closes), other windows at the same progress they'd give a
        // grid hit here.
        const sws = this.sweepsAt(ln, pos);
        if (sws) {
          for (let i = 0; i < sws.length; i++) {
            const sw2 = sws[i];
            const raw = clamp((e.o - sw2.from) / Math.max(1, sw2.to - sw2.from), 0, 1);
            const modes = (sw2.modes && sw2.modes.length ? sw2.modes : [sw2.mode]).filter((m) => m !== "speed");
            if (!modes.length) continue;
            snap = this.sweptSnap(snap, modes, shapeY(raw, sw2), sw2.side, sw2.fromV, sw2.toV, sw2.morphSnap);
          }
        }
        const span = Math.max(1, sw.to - sw.from);
        const pos01 = clamp((e.o - sw.from) / span, 0, 1);
        const life = { isAccent: k === 0, hitIndex: k, pos01, accent: nd.accent, ghost: nd.ghost };
        const hit = this.perHit(snap, life);
        if (!hit) continue;
        const delay = Math.round((e.o - pos) * spb);
        const voiceSnap = snap.slice();
        this.jitterSnap(voiceSnap, hit.human);
        // Held notes keep gliding with the morph windows through their hold.
        const track = this.morphPitchTrack(sws, e.o, preSweepPitch, snap);
        this.triggerSound(nd.soundId, snap, voiceSnap, gate, snd.tail, hit.vel, hit.count, hit.interval, beat, delay, track);
        fired.push(nd.soundId);
      }
    }
    return covered;
  }

  // ALL row-sweep windows covering global loop position `pos` on line `ln`, or null.
  // Overlapping windows are allowed — the caller composes them in list order, each
  // morphing the result of the previous. See SweepWindow in lines.ts.
  sweepsAt(ln, pos) {
    const sweeps = ln && ln.sweeps;
    if (!sweeps) return null;
    let out = null;
    for (let i = 0; i < sweeps.length; i++) {
      const s = sweeps[i];
      if (pos >= s.from && pos < s.to) (out || (out = [])).push(s);
    }
    return out;
  }

  // Morph `snap` between its near variant and the silent/FX extreme of each style in
  // `modes` at blend point t∈[0,1] — the one composition step behind every silence-end
  // fade and row sweep. Styles CHAIN: each reads the previous result, so two styles both
  // shape the hit (their level ducks compound — stacked extremes read as a deeper fade).
  // `side` "out" runs sound → effect as t rises; "in" runs effect → sound. The optional
  // From/To overrides (`nearV`/`farV`) apply to the PRIMARY (first) style only.
  // The "morph" style (per-loop transitions) lerps toward `morphSnap` — a FULL target
  // snapshot whose Volume slot holds a RATIO of the loop's own volume (so a muted /
  // soloed-out row stays silent and the loudness makeup keeps riding along).
  // A held note fired inside "morph" sweep windows keeps FOLLOWING the blend function
  // through its hold: sample the composed swept PITCH across the note's gate and ship
  // it to the voice as a multiplier curve (relative to its note-on pitch), so a
  // long-gate drone glides with the transition — one hit every 4 bars still traces the
  // whole function — instead of freezing at note-on. Pitch is the one param a sounding
  // voice can keep tracking; the other swept params stay per-hit.
  // `sws` = the windows covering the hit, `posFloat` the hit's (fractional) lane step,
  // `basePitch` the PRE-sweep pitch, `snap` the hit's final swept snapshot (its Gate
  // sets the hold). Windows are evaluated with their progress CLAMPED to [0,1], so a
  // hold running past the window's end settles on the function's final value.
  morphPitchTrack(sws, posFloat, basePitch, snap) {
    if (!sws || !(basePitch > 0)) return null;
    let hasMorph = false;
    for (let i = 0; i < sws.length && !hasMorph; i++) {
      const sw = sws[i];
      const modes = sw.modes && sw.modes.length ? sw.modes : [sw.mode];
      hasMorph = modes.includes("morph") && !!sw.morphSnap;
    }
    if (!hasMorph) return null;
    const gateSec = snap[P.Gate];
    const durSamples = gateSec > 0 ? Math.max(1, (gateSec * this.sr) | 0) : Math.max(1, (this.sr * STEP_GATE_SEC) | 0);
    const durSteps = durSamples / this.samplesPerStep();
    // Composed swept pitch at lane position `fp` — mirrors sweptSnap's morph lerp,
    // pitch only (no other style touches P.Pitch).
    const pitchAt = (fp) => {
      let p = basePitch;
      for (let i = 0; i < sws.length; i++) {
        const sw = sws[i];
        const modes = sw.modes && sw.modes.length ? sw.modes : [sw.mode];
        if (!modes.includes("morph") || !sw.morphSnap) continue;
        const raw = clamp((fp - sw.from) / Math.max(1, sw.to - sw.from), 0, 1);
        const t = shapeY(raw, sw);
        const tgt = sw.morphSnap[P.Pitch];
        p = sw.side === "in" ? tgt + (p - tgt) * t : p + (tgt - p) * t;
      }
      return Math.max(1, p);
    };
    // Sample density: ~8 points per second of hold keeps even wavy functions smooth
    // over a 30s drone without bloating short notes.
    const K = Math.max(9, Math.min(257, Math.ceil((durSamples / this.sr) * 8) + 1));
    const p0 = pitchAt(posFloat);
    const mults = new Float32Array(K);
    let moves = false;
    for (let k = 0; k < K; k++) {
      const m = pitchAt(posFloat + (k / (K - 1)) * durSteps) / p0;
      mults[k] = m;
      if (m > 1.0005 || m < 0.9995) moves = true;
    }
    return moves ? { mults, durSamples } : null;
  }

  sweptSnap(snap, modes, t, side, nearV, farV, morphSnap) {
    let v = snap;
    for (let i = 0; i < modes.length; i++) {
      const m = modes[i];
      if (m === "morph") {
        if (!morphSnap) continue;
        const tgt = morphSnap.slice();
        tgt[P.Volume] = v[P.Volume] * morphSnap[P.Volume];
        v = side === "in" ? this.lerpSnap(tgt, v, t) : this.lerpSnap(v, tgt, t);
        continue;
      }
      const near = this.nearVariant(v, m, i === 0 ? nearV : undefined);
      const ghost = this.silentVariant(v, m, i === 0 ? farV : undefined);
      v = side === "in" ? this.lerpSnap(ghost, near, t) : this.lerpSnap(near, ghost, t);
    }
    return v;
  }

  // Fire one step. The loop length is the LONGEST line's chain; every line reads its
  // position as `absStep % loopTotal`, plays its chain once (active NODE by cumulative
  // lenSteps, the node's pattern cycling inside its window via `activeLocal % steps`),
  // then RESTS once past its own length — so all lines realign at the top of the loop
  // instead of a short line repeating under a long one. Silent nodes are rests too, and
  // a node's leading `waitSteps` are silent lead-in (it waits, then its pattern starts).
  fireStep(gate) {
    const lines = this.lines;
    if (!lines) { this.reportPlayhead(null, []); return; }

    // Bounded render (offline export): once the requested steps have fired, stop
    // sequencing so process() renders only the ringing tails from here on.
    if (this.maxSteps > 0 && this.absStep >= this.maxSteps) { this.playing = false; return; }

    // Loop length = the longest line's total (in steps); every line wraps here.
    const totals = [];
    let loopTotal = 0;
    for (let li = 0; li < lines.length; li++) {
      const nodes = (lines[li] && lines[li].nodes) || [];
      let total = 0;
      for (let k = 0; k < nodes.length; k++) total += Math.max(1, nodes[k].lenSteps | 0);
      totals.push(total);
      if (total > loopTotal) loopTotal = total;
    }
    // Section loop: while a node is being edited the transport cycles just that
    // node's window of the loop (clamped inside it); every line still plays its own
    // content there, so you hear the edit in the track's context. 0 = whole loop.
    let pos;
    if (this.sectionLen > 0 && loopTotal > 0) {
      const start = Math.min(this.sectionStart, loopTotal - 1);
      const len = Math.max(1, Math.min(this.sectionLen, loopTotal - start));
      pos = start + (this.absStep % len);
    } else {
      pos = loopTotal > 0 ? this.absStep % loopTotal : 0;
    }

    const fired = [];
    const states = []; // per line: { node, step } for the playhead (-1 = resting)
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li];
      const nodes = (ln && ln.nodes) || [];
      const total = totals[li];
      // Past this line's own length (or empty): the line rests until the loop wraps.
      if (total <= 0 || pos >= total) { states.push({ node: -1, step: -1 }); continue; }

      let acc = 0, ni = 0;
      while (ni < nodes.length - 1 && pos >= acc + Math.max(1, nodes[ni].lenSteps | 0)) {
        acc += Math.max(1, nodes[ni].lenSteps | 0);
        ni++;
      }
      const nd = nodes[ni];
      const nodeLocal = pos - acc;
      const vs = nd.steps | 0;
      // Lead-in silence: the first `waitSteps` of the window are quiet (the node waits,
      // then plays), so the pattern clock starts AFTER the wait. <0 = still waiting.
      const waitSteps = Math.max(0, nd.waitSteps | 0);
      const activeLocal = nodeLocal - waitSteps;
      states.push({ node: ni, step: vs >= 1 && activeLocal >= 0 ? activeLocal % vs : -1 });

      // Still waiting (lead-in)? A speed row sweep may have dragged hits INTO the wait
      // span — fire those; the grid is silent here anyway.
      if (activeLocal < 0) { this.fireRowWarpAt(ln, pos, gate, fired); continue; }

      // Speed transition: within an intro/outro SPEED span the node's hits are RE-TIMED —
      // a precomputed onset list (fractional steps, off the grid) replaces the pattern's
      // grid hits. Handled BEFORE the pattern gate below so onsets can land on steps the
      // grid pattern would skip. Outside the span the node plays its pattern normally.
      // Speed may STACK with tonal styles (env.modes) — fireSpeedStep morphs each re-timed
      // hit through them at its own blend position. (`warp` is only shipped when the
      // env's style set includes "speed" — see linesMessage.)
      const speedIntro = nd.intro && nd.intro.warp;
      const speedOutro = nd.outro && nd.outro.warp;
      if (speedIntro || speedOutro) {
        const snd2 = this.sounds.get(nd.soundId);
        if (snd2) {
          const aLen = Math.max(1, (nd.lenSteps | 0) - waitSteps);
          const beat2 = this.absStep * 0.25;
          const iSpan = speedIntro ? Math.min(aLen, Math.max(1, nd.intro.steps | 0)) : 0;
          const oSpan = speedOutro ? Math.min(aLen, Math.max(1, nd.outro.steps | 0)) : 0;
          if (iSpan > 0 && activeLocal < iSpan) {
            this.fireSpeedStep(nd, snd2, nd.intro, "intro", iSpan, activeLocal, aLen, gate, beat2, fired);
            continue;
          }
          if (oSpan > 0 && activeLocal >= aLen - oSpan) {
            this.fireSpeedStep(nd, snd2, nd.outro, "outro", oSpan, activeLocal, aLen, gate, beat2, fired);
            continue;
          }
        }
      }

      // SPEED row sweeps (see fireRowWarpAt): inside a warp-carrying window the lane's
      // grid hits are replaced by the window's re-timed onsets — rushing in / dragging
      // out across the whole row, node boundaries included. A node's OWN speed span
      // still wins (handled above; its hits were left out of the window's warp).
      if (this.fireRowWarpAt(ln, pos, gate, fired)) continue;

      // A pattern rest (rests ship an empty pattern) — nothing to fire on the grid here.
      if (vs < 1 || !nd.pattern || !nd.pattern[activeLocal % vs]) continue;

      // Accent = the first hit of this node's pattern cycle. beat = LFO-sync phase.
      let firstHit = 0;
      for (let h = 0; h < vs; h++) if (nd.pattern[h]) { firstHit = h; break; }
      const isAccent = (activeLocal % vs) === firstHit;
      const beat = this.absStep * 0.25;

      // Normal node: play its own sound, but shape its ends where it carries fades.
      // A node keeps its sound throughout; an intro fades the first `introSteps` of the
      // sounding window, an outro the last `outroSteps` (clampEnvelopes keeps them from
      // overlapping, so at most one region contains any given step).
      const snd = this.sounds.get(nd.soundId);
      if (!snd) continue;
      const activeLen = Math.max(1, (nd.lenSteps | 0) - waitSteps);
      const introSteps = nd.intro ? Math.min(activeLen, Math.max(1, nd.intro.steps | 0)) : 0;
      const outroSteps = nd.outro ? Math.min(activeLen, Math.max(1, nd.outro.steps | 0)) : 0;

      // Per-hit Life context for a per-loop accent/ghost layer: the hit's ordinal
      // across the whole loop (so "every Nth hit" runs continuously past pattern-cycle
      // boundaries) and its position 0..1 through the sounding window (for ramps).
      const localStep = activeLocal % vs;
      let hitsPerCycle = 0, hitPrefix = 0;
      for (let h = 0; h < vs; h++) if (nd.pattern[h]) { if (h < localStep) hitPrefix++; hitsPerCycle++; }
      const hitIndex = Math.floor(activeLocal / vs) * hitsPerCycle + hitPrefix;
      const pos01 = activeLen > 1 ? clamp(activeLocal / (activeLen - 1), 0, 1) : 1;
      const life = { isAccent, hitIndex, pos01, accent: nd.accent, ghost: nd.ghost };

      // Intro: rise from silence (fromId < 0) or morph from a previous sound into this
      // one, over introSteps. t runs 0→1 across the span.
      if (introSteps > 0 && activeLocal < introSteps) {
        const fromId = nd.intro.fromId;
        const from = fromId >= 0 ? this.sounds.get(fromId) : null;
        if (fromId < 0 || from) {
          const raw = introSteps > 1 ? clamp(activeLocal / (introSteps - 1), 0, 1) : 1;
          const t = shapeY(raw, nd.intro);
          this.fireBlend(nd.soundId, fromId, from, nd.soundId, snd, nd.intro.modes || nd.intro.mode, t, life, gate, beat, fired, nd.intro.from, nd.intro.to);
          continue;
        }
        // Source sound gone — fall through and play this node plainly.
      }
      // Outro: fall to silence (toId < 0) or morph this sound into a next one, over the
      // last outroSteps. t runs 0→1 as the sound gives way.
      if (outroSteps > 0 && activeLocal >= activeLen - outroSteps) {
        const toId = nd.outro.toId;
        const to = toId >= 0 ? this.sounds.get(toId) : null;
        if (toId < 0 || to) {
          const local = activeLocal - (activeLen - outroSteps);
          const raw = outroSteps > 1 ? clamp(local / (outroSteps - 1), 0, 1) : 1;
          const t = shapeY(raw, nd.outro);
          this.fireBlend(nd.soundId, nd.soundId, snd, toId, to, nd.outro.modes || nd.outro.mode, t, life, gate, beat, fired, nd.outro.from, nd.outro.to);
          continue;
        }
        // Destination sound gone — play plainly.
      }

      // Row FX sweeps: lane-wide windows (see SweepWindow) that morph the steady hit
      // toward (side "out") or out of (side "in") each style's FX extreme by the window's
      // global progress across [from, to). Every window covering this position applies —
      // overlaps COMPOSE, each morphing the result of the previous — and a window may
      // itself carry several styles (sw.modes). Overrides the plain steady trigger; a
      // node's own intro/outro (handled above with `continue`) still wins where they
      // overlap.
      const sws = this.sweepsAt(ln, pos);
      if (sws) {
        // Melody notes carry their own pitch: sweep a pitched copy so the fade keeps the tune.
        let snap = nd.pitchHz > 0 ? this.pitchedSnap(snd.snap, nd.pitchHz) : snd.snap;
        const preSweepPitch = snap[P.Pitch];
        for (let si = 0; si < sws.length; si++) {
          const sw = sws[si];
          const raw = clamp((pos - sw.from) / Math.max(1, sw.to - sw.from), 0, 1);
          const t = shapeY(raw, sw);
          const modes = sw.modes && sw.modes.length ? sw.modes : [sw.mode];
          snap = this.sweptSnap(snap, modes, t, sw.side, sw.fromV, sw.toV, sw.morphSnap);
        }
        const hit = this.perHit(snap, life);
        if (!hit) continue;
        const voiceSnap = snap.slice();
        this.jitterSnap(voiceSnap, hit.human);
        // A long-held note keeps following the morph windows' function (drone glide).
        const track = this.morphPitchTrack(sws, pos, preSweepPitch, snap);
        this.triggerSound(nd.soundId, snap, voiceSnap, gate, snd.tail, hit.vel, hit.count, hit.interval, beat, 0, track);
        fired.push(nd.soundId);
        continue;
      }

      // Steady middle: the node's own sound. A melody note carries its own pitch
      // (`pitchHz`) — the one re-pitched instrument playing a scale degree — so it plays
      // from a copy of the snapshot with P.Pitch swapped to that note.
      const baseSnap = nd.pitchHz > 0 ? this.pitchedSnap(snd.snap, nd.pitchHz) : snd.snap;
      const hit = this.perHit(baseSnap, life);
      if (!hit) continue; // dropped by HitChance
      const voiceSnap = baseSnap.slice();
      this.jitterSnap(voiceSnap, hit.human);
      this.triggerSound(nd.soundId, baseSnap, voiceSnap, gate, snd.tail, hit.vel, hit.count, hit.interval, beat);
      fired.push(nd.soundId);
    }
    this.reportPlayhead(states, fired, pos);

    this.absStep += 1;
    // Apply staged edits at bar boundaries so changes land musically.
    if (this.absStep % STEPS_PER_BAR === 0) this.promotePending();
  }

  renderChannels(offset, n) {
    for (let c = 0; c < NUM_DRUMS; c++) {
      this.channels[c].renderInto(this.masterL, this.masterR, this.scratch, offset, n, this.tempo);
    }
  }

  // Soft-knee master clip: transparent below CLIP_KNEE, tanh-rounded above (peaks
  // asymptote to ±1), so stacked resonant/driven channels saturate gently instead
  // of hard digital clipping at the DAC.
  softClip(buf, n) {
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const a = x < 0 ? -x : x;
      if (a > CLIP_KNEE) {
        const soft = CLIP_KNEE + (1 - CLIP_KNEE) * Math.tanh((a - CLIP_KNEE) / (1 - CLIP_KNEE));
        buf[i] = x < 0 ? -soft : soft;
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const n = out[0].length;
    if (this.scratch.length < n) {
      this.scratch = new Float32Array(n);
      this.masterL = new Float32Array(n);
      this.masterR = new Float32Array(n);
    }
    const masterL = this.masterL, masterR = this.masterR;
    for (let i = 0; i < n; i++) { masterL[i] = 0; masterR[i] = 0; }
    this.clock += n; // sample clock for allocation/steal decisions

    if (!this.playing) {
      this.renderChannels(0, n); // audition / tails keep ringing
    } else {
      let pos = 0;
      while (pos < n) {
        if (this.samplesToNextStep <= 0) {
          this.fireStep((this.sr * STEP_GATE_SEC) | 0);
          this.samplesToNextStep += this.samplesPerStep();
        }
        let chunk = Math.min(n - pos, Math.ceil(this.samplesToNextStep));
        if (chunk < 1) chunk = 1;
        this.renderChannels(pos, chunk);
        pos += chunk;
        this.samplesToNextStep -= chunk;
      }
    }

    this.softClip(masterL, n);
    this.softClip(masterR, n);
    if (out.length === 1) {
      // Mono destination: fold the stereo bus down.
      const o = out[0];
      for (let i = 0; i < n; i++) o[i] = (masterL[i] + masterR[i]) * 0.5;
    } else {
      for (let ch = 0; ch < out.length; ch++) {
        const o = out[ch];
        const src = ch === 1 ? masterR : masterL;
        for (let i = 0; i < n; i++) o[i] = src[i];
      }
    }
    return true;
  }
}

registerProcessor("engine-processor", EngineProcessor);
