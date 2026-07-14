// Plain-words help for the deep sound editor: every section head carries a little
// "?" that opens a glossary of that section's controls — tap a name, read what it
// does, and see the actual lines of engine code that make it work. Descriptions
// live here, not in paramSpec, so the DSP tables stay lean. The snippets quote
// public/worklet/engine.js (the AudioWorklet DSP) and src/model/drumKit.ts (the
// shuffle) — if those change shape, refresh the quotes here.

import { DrumType } from "../model/drums";
import { ParamId, ParamGroup, NUM_PARAMS, getParamGroup } from "../model/params";
import { getParamSpec } from "../model/paramSpec";
import { mkBtn } from "./controls";

export interface HelpItem {
  name: string;
  desc: string;
  code?: string; // the behind-the-scenes lines, shown under the description
}

// What each parameter does, in the user's language (units and choice names spelled
// out). LFO 2/3 share LFO 1's text — the three blocks are identical.
function paramDesc(id: ParamId): string {
  switch (id) {
    // --- Tone ---
    case ParamId.Pitch:
      return "The oscillator's base frequency in Hz — how high or low the tone of the hit sits. On a melody row each note re-tunes it, so treat it as the home pitch.";
    case ParamId.PitchEnvAmount:
      return "A pitch sweep at the start of each hit. Positive starts above and drops down onto the pitch (the classic kick punch); negative starts low and rises into it (reverse swells, zap risers). 0 = no sweep.";
    case ParamId.PitchEnvDecay:
      return "How long the pitch sweep takes to settle onto the base pitch, in seconds. Short = a tight click of punch; long = an audible whoop or riser.";
    case ParamId.Waveform:
      return "The oscillator's waveform: Sine is pure and round, Tri adds a little edge, Square is hollow and buzzy, Saw is the brightest and richest.";
    case ParamId.ToneLevel:
      return "Level of the oscillator — the tonal, pitched body of the hit. Balance it against Noise.";
    case ParamId.NoiseLevel:
      return "Level of the noise layer — the hiss/sizzle part of the hit (snares and hats live here). Its character is picked by Noise Col.";
    case ParamId.NoiseType:
      return "The noise's colour: White is flat hiss, Pink warmer, Brown dark rumble, Blue and Violet increasingly bright sizzle, Crackle sparse pops, Metal a gritty drum-machine clang.";
    case ParamId.OscModType:
      return "Runs a second operator into the main oscillator: FM (frequency modulation) makes bells, clangs and growls; Ring (ring modulation) makes metallic, inharmonic tones. Off disables it.";
    case ParamId.OscModRatio:
      return "The modulator's frequency as a multiple of the pitch. Simple ratios (1x, 2x, 3x) stay harmonic; in-between values go clangy and bell-like.";
    case ParamId.OscModAmount:
      return "How hard the modulator works — the FM index / ring-mod depth. 0 = off; higher = wilder sidebands.";
    case ParamId.Osc2Mix:
      return "Level of a second oscillator layered under the first (0 = off). Use it with Detune for thickness, a sub octave, or an interval clang.";
    case ParamId.Osc2Detune:
      return "The second oscillator's tuning offset in semitones. Tiny offsets (±0.2) give a slow beating thickness; -12 adds a sub octave; +7 a fifth (the 808-cowbell clang).";
    case ParamId.Sync:
      return "Hard-syncs the second oscillator's cycle to the first. With some detune this gives the classic ripping 'sync' timbre.";
    case ParamId.Fold:
      return "Wavefolder: folds the waveform back on itself instead of clipping, piling on harmonics. Subtle amounts thicken; high amounts snarl.";
    case ParamId.ClickLevel:
      return "Level of a tiny transient click (a few milliseconds) layered onto the attack for extra snap and definition. 0 = off.";
    case ParamId.ClickType:
      return "The click's flavour: Tick a sharp spike, Snap a white-noise burst, Knock a low thud, Blip a high sine ping, Clank sample-and-hold metal grit.";

    // --- Amp envelope ---
    case ParamId.AmpAttack:
      return "How long the hit takes to reach full level, in seconds. 0 = instant drum snap; longer = a soft fade-in or swell.";
    case ParamId.AmpDecay:
      return "How long the level takes to fall from the attack peak down to the Sustain level, in seconds — the main 'length of the hit' control for percussive sounds.";
    case ParamId.AmpSustain:
      return "The level held for as long as the note lasts. 0 = a pure percussive hit that dies after the decay; higher values hold on like a synth note.";
    case ParamId.AmpRelease:
      return "The fade-out time after the held part of the note ends, in seconds.";
    case ParamId.AmpAttackShape:
      return "Curvature of the attack: 0 is plucky (jumps up fast), 0.5 a straight line, 1 a slow swell that arrives late.";
    case ParamId.AmpDecayShape:
      return "Curvature of the decay and release: 0 holds then drops like a gate, 0.5 a straight line, 1 falls fast then trails off — the natural percussive shape.";
    case ParamId.ToneDecay:
      return "A separate decay for just the oscillator layer, so the tone can die quicker (or ring longer) than the noise. 0 = follow the main envelope.";
    case ParamId.NoiseDecay:
      return "A separate decay for just the noise layer — e.g. a short tone with a longer sizzle tail. 0 = follow the main envelope.";
    case ParamId.Gate:
      return "How long each hit is held 'on' before it releases, in seconds — the note-length control. With Sustain at 0 the hit already dies during its Decay, so gate barely matters; with any Sustain the sound holds for the whole gate and then Release fades it. Short gate = choked/staccato; long = it rings for the full hit.";

    // --- Filter & resonators ---
    case ParamId.FilterType:
      return "The filter's mode: LP cuts highs (darker), HP cuts lows (thinner), BP keeps only a band around the cutoff, Vowel is a formant filter that morphs A–E–I–O–U as the cutoff moves (instant wah when an LFO drives it).";
    case ParamId.FilterCutoff:
      return "Where the filter bites, in Hz: the corner frequency for LP/HP/BP, or the position along the vowels for Vowel.";
    case ParamId.FilterReso:
      return "Resonance — a peak of emphasis right at the cutoff. Low = smooth; high = whistling, ringing, on the edge of self-oscillation.";
    case ParamId.CombMix:
      return "Blends in a plucked-string resonator (a Karplus–Strong comb): hits ring like a plucked or struck string. 0 = off.";
    case ParamId.CombTune:
      return "The string resonator's pitch, as a ratio of the hit's pitch — 1x rings in tune, 2x an octave up, odd ratios go metallic.";
    case ParamId.CombDecay:
      return "The string's feedback: low = a short dead pluck, high = a long ringing sustain.";
    case ParamId.ModalMix:
      return "Blends in a bank of tuned resonators — physical-modelling bells, bars and drumheads ringing at the hit's pitch. 0 = off.";
    case ParamId.ModalMaterial:
      return "What the modal bank is 'made of' — the set of overtones it rings with: Membrane (drumhead), Bell, Bar (glockenspiel-like), Bowl, Plate (dense inharmonic wash).";
    case ParamId.ModalDecay:
      return "Scales how long every mode rings: 0 a tight thud, 1 a long bell-like ring.";

    // --- LFO (2/3 mirror 1) ---
    case ParamId.LfoTarget:
    case ParamId.Lfo2Target:
    case ParamId.Lfo3Target:
      return "What this LFO wobbles: Pitch (vibrato, sirens), Filter (cutoff sweeps — wah and wobble), Amp (tremolo), Drive, Reso, or Wave (waveform morphing). None switches the LFO off.";
    case ParamId.Lfo1Shape:
    case ParamId.Lfo2Shape:
    case ParamId.Lfo3Shape:
      return "The wobble's motion: Sine smooth, Tri even up-down, Saw a rising ramp that snaps back, Square an on/off trill, S&H stepped random values.";
    case ParamId.LfoRate:
    case ParamId.Lfo2Rate:
    case ParamId.Lfo3Rate:
      return "The wobble speed in Hz. Only used while Sync is Free — a division overrides it.";
    case ParamId.Lfo1Sync:
    case ParamId.Lfo2Sync:
    case ParamId.Lfo3Sync:
      return "Locks one LFO cycle to a beat division at the song tempo (1/8 = two wobbles per beat), phase-locked to the grid at each hit — the beat-synced dubstep wobble. Free uses the Rate knob instead.";
    case ParamId.LfoDepth:
    case ParamId.Lfo2Depth:
    case ParamId.Lfo3Depth:
      return "How deep the wobble is. 0 = off; full throws the target across its whole range.";

    // --- Drive & FX ---
    case ParamId.Drive:
      return "Saturation on the whole voice: a little warms and fattens, a lot distorts and crunches.";
    case ParamId.EchoTime:
      return "The gap between echo repeats, in seconds. Only used while Echo Sync is Free.";
    case ParamId.EchoFeedback:
      return "How much of each echo is fed back in: low = one or two repeats, high = a long trail.";
    case ParamId.EchoMix:
      return "The echo's volume against the dry hit. 0 = echo off.";
    case ParamId.EchoSync:
      return "Locks the echo's gap to a beat division at the song tempo (1/8, dotted values…) so repeats land on the grid. Free uses Echo Time instead.";
    case ParamId.EchoPing:
      return "Ping-pong: successive echoes bounce between the left and right speakers instead of repeating in place.";
    case ParamId.ReverbSize:
      return "The size of the reverb space, from a small room to a long wash.";
    case ParamId.ReverbMix:
      return "The reverb's volume against the dry hit. 0 = reverb off.";
    case ParamId.Crush:
      return "Bitcrusher: reduces bit depth for gritty, fizzy lo-fi crunch — 12-bit is subtle, 3-bit is destroyed.";
    case ParamId.Downsample:
      return "Sample-rate reduction: plays the sound at a cheaper rate (2x–16x less), adding aliased vintage-sampler grit.";

    // --- Per-hit Life ---
    case ParamId.AccentAmount:
      return "Accents the first hit of each cycle by playing all the other hits softer. 0 = every hit equal; higher = a stronger pulse on the downbeat.";
    case ParamId.Humanize:
      return "Adds a little random per-hit drift to level, pitch and cutoff, so the pattern feels played rather than programmed.";
    case ParamId.HitChance:
      return "The probability each scheduled hit actually plays. Below 1, some hits drop out — and a dropped hit may sneak through as a quiet ghost note.";
    case ParamId.Ratchet:
      return "The chance a hit becomes a fast 2–4x retrigger burst — rolls, flams and stutters.";
    case ParamId.ChokeGroup:
      return "Sounds in the same group cut each other off: when one fires, the others stop ringing (the classic closed hat choking the open hat). Off = never choked.";

    // --- Output ---
    case ParamId.Volume:
      return "This voice's overall loudness in the mix. Shuffle never touches it.";
    case ParamId.Pan:
      return "Where the voice sits in the stereo field, left to right (constant-power, so the middle isn't louder).";

    default:
      return "";
  }
}

// The behind-the-scenes lines for each parameter, quoted from the DSP that reads
// it (public/worklet/engine.js unless the header comment says otherwise).
function paramCode(id: ParamId): string {
  switch (id) {
    // --- Tone ---
    case ParamId.Pitch:
      return `// engine.js — the oscillator steps freq/sampleRate through its cycle
let freq = this.basePitch * (1 + this.pitchEnvAmount * this.pitchEnv) * pitchMul;
this.oscPhase += freq / sr;`;
    case ParamId.PitchEnvAmount:
      return `// engine.js — pitchEnv falls 1 → 0; the amount scales how far off it starts
let freq = this.basePitch * (1 + this.pitchEnvAmount * this.pitchEnv) * pitchMul;
if (freq < 5) freq = 5; // negative amounts pin low, then RISE into the note`;
    case ParamId.PitchEnvDecay:
      return `// engine.js — the sweep decays exponentially with this time constant
this.pitchEnvCoef = Math.exp(-1 / (this.pitchEnvDecay * this.sr));
this.pitchEnv *= this.pitchEnvCoef; // every sample`;
    case ParamId.Waveform:
      return `// engine.js — osc(): one sample of the chosen shape (polyBLEP de-aliased)
if (wave === 1) return 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1; // tri
if (wave === 2) { let v = phase < pw ? 1 : -1; v += polyBlep(phase, dt); ... }   // square
if (wave === 3) return 2 * phase - 1 - polyBlep(phase, dt);                      // saw
return Math.sin(TWO_PI * phase);                                                 // sine`;
    case ParamId.ToneLevel:
      return `// engine.js — the two sources are mixed by their levels
let toneAmp = this.toneLevel, noiseAmp = this.noiseLevel;
let mixed = toneAmp * osc + noiseAmp * noise;`;
    case ParamId.NoiseLevel:
      return `// engine.js
const noise = this.nextNoise(); // shaped to the chosen colour
let mixed = toneAmp * osc + noiseAmp * noise;`;
    case ParamId.NoiseType:
      return `// engine.js — nextNoise(): white is shaped into the chosen colour
case 1: return this.pinkStep(white);                             // pink (-3dB/oct)
case 2: this.brown = clamp(this.brown + white * 0.02, -1, 1);    // brown (integrated)
case 4: return (white - this.prevWhite) * 0.5;                   // violet (differentiated)
case 5: return Math.random() < CRACKLE_DENSITY ? white * 3 : 0;  // crackle
case 6: if (--this.metalCtr <= 0) { this.metalHold = white; ... } // metal (S&H)`;
    case ParamId.OscModType:
      return `// engine.js — one sine modulator, applied as FM (phase) or Ring (amplitude)
modOut = Math.sin(TWO_PI * this.modPhase);
if (this.modType === 1) carrierPhase += modOut * this.modAmount * FM_INDEX;  // FM
if (this.modType === 2) osc *= 1 - this.modAmount + this.modAmount * modOut; // ring`;
    case ParamId.OscModRatio:
      return `// engine.js — the modulator runs at the note's pitch × ratio
this.modPhase += (freq * this.modRatio) / sr;`;
    case ParamId.OscModAmount:
      return `// engine.js — depth of the push, in FM and in ring mode
carrierPhase += modOut * this.modAmount * FM_INDEX;            // FM: bends the phase
osc *= 1 - this.modAmount + this.modAmount * modOut;           // ring: gates the level`;
    case ParamId.Osc2Mix:
      return `// engine.js — the 2nd oscillator is simply added at its mix level
const o2 = this.osc(this.osc2Phase - Math.floor(this.osc2Phase), this.waveform, pw, dt2);
osc += o2 * this.osc2Mix;`;
    case ParamId.Osc2Detune:
      return `// engine.js — semitones become a frequency ratio (2^(st/12))
this.osc2Ratio = Math.pow(2, s[P.Osc2Detune] / 12);
this.osc2Phase += (freq * this.osc2Ratio) / sr;`;
    case ParamId.Sync:
      return `// engine.js — when osc 1 wraps its cycle, osc 2 is snapped back to 0
if (this.oscPhase >= 1) { this.oscPhase -= Math.floor(this.oscPhase); masterWrapped = true; }
if (this.sync && masterWrapped) this.osc2Phase = 0; // hard sync to oscillator 1`;
    case ParamId.Fold:
      return `// engine.js — overdrive the wave into a sine so it folds back on itself
if (this.fold > 0) osc = Math.sin(osc * (1 + this.fold * FOLD_GAIN) * 1.5707963);`;
    case ParamId.ClickLevel:
      return `// engine.js — a few-ms burst injected AFTER the filter, so it stays sharp
filtered += c * this.clickEnv * this.clickLevel * CLICK_GAIN;
this.clickEnv *= this.clickCoef; // exponential, gone in milliseconds`;
    case ParamId.ClickType:
      return `// engine.js — the burst's source, per flavour
case 1: c = this.rng(); break;                          // snap: white burst
case 2: case 3: c = Math.sin(TWO_PI * this.clickPhase); // knock/blip: sine thud/ping
case 4: ... this.clickHold = this.rng(); ...            // clank: S&H metal grit
default: c = (w - this.clickPrev) * 0.7;                // tick: violet spike`;

    // --- Amp envelope ---
    case ParamId.AmpAttack:
      return `// engine.js — ADSR.next(), attack segment
this.t += this.attackInc; // attackInc = 1 / (attack × sampleRate)
this.value = Math.pow(this.t, this.aExp);`;
    case ParamId.AmpDecay:
      return `// engine.js — ADSR.next(), decay segment
this.t += this.decayInc; // decayInc = 1 / (decay × sampleRate)
this.value = this.sustain + (1 - this.sustain) * Math.pow(1 - this.t, this.dExp);`;
    case ParamId.AmpSustain:
      return `// engine.js — decay lands on the sustain level, then holds there
this.value = this.sustain + (1 - this.sustain) * Math.pow(1 - this.t, this.dExp);
case 3: break; // sustain: hold until the gate ends`;
    case ParamId.AmpRelease:
      return `// engine.js — ADSR.next(), release segment (from wherever the level was)
this.t += this.releaseInc; // releaseInc = 1 / (release × sampleRate)
this.value = this.releaseStart * Math.pow(1 - this.t, this.dExp);`;
    case ParamId.AmpAttackShape:
      return `// engine.js — the shape becomes the attack's power curve
function shapeExp(shape) {
  return Math.pow(4, s * 2 - 1); // 0..1 → exponent 0.25..4 (0.5 → 1 = linear)
}
this.value = Math.pow(this.t, this.aExp);`;
    case ParamId.AmpDecayShape:
      return `// engine.js — the same 0.25..4 exponent bends decay AND release
this.dExp = shapeExp(dShape); // 0 = gated hold, 0.5 = linear, 1 = percussive
this.value = this.sustain + (1 - this.sustain) * Math.pow(1 - this.t, this.dExp);`;
    case ParamId.ToneDecay:
      return `// engine.js — the oscillator layer gets its own exponential decay
this.toneEnvCoef = toneDec > 0.004 ? Math.exp(-1 / (toneDec * this.sr)) : 0;
if (this.toneEnvCoef > 0) { toneAmp *= this.toneEnv; this.toneEnv *= this.toneEnvCoef; }`;
    case ParamId.NoiseDecay:
      return `// engine.js — same trick for the noise layer, on its own clock
this.noiseEnvCoef = noiseDec > 0.004 ? Math.exp(-1 / (noiseDec * this.sr)) : 0;
if (this.noiseEnvCoef > 0) { noiseAmp *= this.noiseEnv; this.noiseEnv *= this.noiseEnvCoef; }`;
    case ParamId.Gate:
      return `// engine.js — the note is held for gateSamples, then note-off fires the release
const gateSec = rd(s, P.Gate, 0); // per-sound; 0/absent → the sequencer's default gate
this.gateSamples = gateSec > 0 ? Math.max(1, (gateSec * this.sr) | 0) : Math.max(1, gate);
if (!this.noteOffSent && ++this.samplesPlayed >= this.gateSamples) this.adsr.noteOff();`;

    // --- Filter & resonators ---
    case ParamId.FilterType:
      return `// engine.js — one state-variable filter, tapped at a different output
if (type === 1) return v0 - k * v1 - v2; // high-pass
if (type === 2) return v1;               // band-pass
return v2;                               // low-pass (Vowel = 3 formant bandpasses)`;
    case ParamId.FilterCutoff:
      return `// engine.js — cutoff sets the SVF's frequency coefficient…
const g = Math.tan(Math.PI * cutoff / sr);
// …or, in Vowel mode, the morph position along A-E-I-O-U
const pos = (Math.log(c / 200) / Math.log(40)) * (VOWELS.length - 1);`;
    case ParamId.FilterReso:
      return `// engine.js — resonance is the inverse of the filter's damping
const k = 1 / clamp(this.filterReso * resoMul, 0.3, 20); // high reso → low k → ring`;
    case ParamId.CombMix:
      return `// engine.js — excite the tuned loop with the signal, blend its ringing back
const ringing = this.comb.process(filtered, sr / combFreq, this.combFb);
filtered = filtered * (1 - this.combMix) + ringing * this.combMix;`;
    case ParamId.CombTune:
      return `// engine.js — the loop's delay length IS its pitch
const combFreq = clamp(freq * this.combRatio, 20, nyquist);
const ringing = this.comb.process(filtered, sr / combFreq, this.combFb);`;
    case ParamId.CombDecay:
      return `// engine.js — decay maps to loop feedback; tanh keeps a hot string musical
this.combFb = 0.85 + clamp(s[P.CombDecay], 0, 1) * 0.14; // 0.85 pluck .. 0.99 string
this.buf[this.w] = Math.tanh(input + this.lp * feedback);`;
    case ParamId.ModalMix:
      return `// engine.js — up to 6 two-pole resonators ring at the material's mode ratios
const ring = this.modal.process(filtered);
filtered = filtered * (1 - this.modalMix) + ring * this.modalMix;`;
    case ParamId.ModalMaterial:
      return `// engine.js — each material is a measured table of mode ratios/gains/decays
{ r: [1, 1.59, 2.14, 2.30, 2.65, 2.92], ... } // circular membrane (drumhead)
{ r: [0.5, 1, 1.2, 1.5, 2.0, 2.67],     ... } // minor-third church bell
{ r: [1, 2.76, 5.40, 8.93],             ... } // free bar (marimba)`;
    case ParamId.ModalDecay:
      return `// engine.js — scales every mode's ring time (0.25x .. 4x), via the pole radius
const decayScale = Math.pow(4, (clamp(rd(s, P.ModalDecay, 0.5), 0, 1) - 0.5) * 2);
const r = Math.exp(-1 / (decay * sr));`;

    // --- LFO ---
    case ParamId.LfoTarget:
    case ParamId.Lfo2Target:
    case ParamId.Lfo3Target:
      return `// engine.js — each LFO's value v (-1..1) folds into its destination
case LFO_PITCH:  pitchMul  *= Math.pow(2, v * depth * 0.5); break;
case LFO_FILTER: cutoffMul *= Math.pow(2, v * depth * 2);   break;
case LFO_AMP:    ampMul    *= 1 - depth * (0.5 * (1 - v));  break;
case LFO_RESO:   resoMul   *= Math.pow(2, v * depth);       break;
case LFO_WAVE:   pwOff     += v * depth * 0.45;             break;`;
    case ParamId.Lfo1Shape:
    case ParamId.Lfo2Shape:
    case ParamId.Lfo3Shape:
      return `// engine.js — lfoWave(): one sample of the wobble's shape
if (shape === 1) return 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1; // tri
if (shape === 2) return 2 * phase - 1;                                            // saw
if (shape === 3) return phase < 0.5 ? 1 : -1;                                     // square
return Math.sin(TWO_PI * phase);                    // sine (S&H holds one rng() per cycle)`;
    case ParamId.LfoRate:
    case ParamId.Lfo2Rate:
    case ParamId.Lfo3Rate:
      return `// engine.js — Free: the phase advances Rate-in-Hz per second
this.lfoInc[L] = (beats > 0 ? Math.max(1, tempo || 120) / (60 * beats) : this.lfoRates[L]) / sr;
this.lfoPhase[L] += this.lfoInc[L]; // every sample`;
    case ParamId.Lfo1Sync:
    case ParamId.Lfo2Sync:
    case ParamId.Lfo3Sync:
      return `// engine.js — a division sizes the cycle from the LIVE tempo and
// phase-locks each hit to the transport's beat grid
const beats = LFO_SYNC_BEATS[this.lfoSyncs[L]] || 0; // e.g. "1/8" → 0.5 beats
this.lfoPhase[L] = beats > 0 && beatPos > 0 ? (beatPos / beats) % 1 : 0;`;
    case ParamId.LfoDepth:
    case ParamId.Lfo2Depth:
    case ParamId.Lfo3Depth:
      return `// engine.js — depth scales the wobble before it hits the target
if (depth <= 0) continue; // 0 = this LFO does nothing
case LFO_FILTER: cutoffMul *= Math.pow(2, v * depth * 2); break; // ±2 octaves at full`;

    // --- Drive & FX ---
    case ParamId.Drive:
      return `// engine.js — a tanh waveshaper; drive sets how hard the signal leans on it
const drive = clamp(this.drive + driveAdd, 0, 2);
if (drive > 0) filtered = Math.tanh(filtered * (1 + drive * 5));`;
    case ParamId.EchoTime:
      return `// engine.js — the free delay time, in samples into the echo buffer
const delaySec = beats > 0 ? (beats * 60) / Math.max(1, tempo || 120) : p[P.EchoTime];
const delay = (delaySec * this.sr) | 0;`;
    case ParamId.EchoFeedback:
      return `// engine.js — each repeat is written back in at ×fb (quieter every pass)
this.buf[this.w] = input + delayed * fb;`;
    case ParamId.EchoMix:
      return `// engine.js — dry/wet blend of the delay line's output
return input * (1 - mix) + delayed * mix;`;
    case ParamId.EchoSync:
      return `// engine.js — a division converts to seconds at the LIVE tempo
const ECHO_SYNC_BEATS = [0, 0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2];
const delaySec = beats > 0 ? (beats * 60) / Math.max(1, tempo || 120) : p[P.EchoTime];`;
    case ParamId.EchoPing:
      return `// engine.js — dry feeds the LEFT line, left feeds RIGHT, right feeds back
this.pingL[this.pingW] = dry + drt * fb; // repeats bounce L, R, L·fb, R·fb…
this.pingR[this.pingW] = dl;`;
    case ParamId.ReverbSize:
      return `// engine.js — freeverb: size becomes the 8 comb filters' feedback
this.roomSize = roomSize * 0.28 + 0.7;
out += this.combs[c].process(input, this.damp, this.roomSize);`;
    case ParamId.ReverbMix:
      return `// engine.js — wet/dry set together so the hit stays at level
this.reverb.setParameters(p[P.ReverbSize], 0.4, verbMix, 1 - verbMix);
buf[i] = out * this.wet + buf[i] * this.dry;`;
    case ParamId.Crush:
      return `// engine.js — quantise the signal to N bits' worth of levels
const step = 2 / (1 << this.crushBits); // e.g. 8-bit → 256 levels
mixed = Math.round(mixed / step) * step;`;
    case ParamId.Downsample:
      return `// engine.js — hold each value for N samples (sample-and-hold decimation)
if (--this.dsCtr <= 0) { this.dsHold = mixed; this.dsCtr = this.dsFactor; }
mixed = this.dsHold;`;

    // --- Per-hit Life ---
    case ParamId.AccentAmount:
      return `// engine.js — perHit(): non-accent hits get their velocity ducked
const accent = clamp(rd(s, P.AccentAmount, 0), 0, 1);
if (accent > 0 && !isAccent) vel *= 1 - ACCENT_DUCK * accent;`;
    case ParamId.Humanize:
      return `// engine.js — jitter the hit's level, and its COPY of pitch + cutoff
vel *= 1 + (Math.random() * 2 - 1) * HUMANIZE_LEVEL * human;
voiceSnap[P.Pitch] *= 1 + (Math.random() * 2 - 1) * HUMANIZE_PITCH * human;
voiceSnap[P.FilterCutoff] *= 1 + (Math.random() * 2 - 1) * HUMANIZE_CUTOFF * human;`;
    case ParamId.HitChance:
      return `// engine.js — a failed roll is a quiet ghost half the time, else silence
if (chance < 1 && Math.random() > chance) {
  if (Math.random() < GHOST_P) vel *= GHOST_LEVEL; // ghost note
  else return null;                                // dropped hit
}`;
    case ParamId.Ratchet:
      return `// engine.js — a winning roll re-strikes the envelope 2-4x inside the step
if (ratchet > 0 && Math.random() < ratchet) {
  count = r < 0.5 ? 2 : r < 0.8 ? 3 : 4;
  interval = Math.max(1, Math.round(this.samplesPerStep() / count));
}
this.vel *= RATCHET_VEL_DECAY; // each sub-hit slightly quieter`;
    case ParamId.ChokeGroup:
      return `// engine.js — a hit fast-fades every other sound in its group
if (Math.round(rd(os.snap, P.ChokeGroup, 0)) === group) this.channels[ci].chokeVoices();
choke() { this.adsr.release = CHOKE_RELEASE; this.adsr.noteOff(); } // ~20ms fade`;

    // --- Output ---
    case ParamId.Volume:
      return `// engine.js — the channel's last gain before the stereo master
const s = scratch[i] * vol;
masterL[offset + i] += s * gl;
masterR[offset + i] += s * gr;`;
    case ParamId.Pan:
      return `// engine.js — constant-power: cos/sin gains from the pan angle
const ang = (pan + 1) * 0.25 * Math.PI;
const gl = Math.cos(ang) * Math.SQRT2;
const gr = Math.sin(ang) * Math.SQRT2;`;

    default:
      return "";
  }
}

/** The glossary for one parameter section, in display order. The LFO section lists
    its five controls once (all three LFO blocks are identical) under an overview. */
export function paramHelpItems(drum: DrumType, g: ParamGroup): HelpItem[] {
  if (g === ParamGroup.Lfo) {
    const ids = [ParamId.LfoTarget, ParamId.Lfo1Shape, ParamId.LfoRate, ParamId.Lfo1Sync, ParamId.LfoDepth];
    return [
      {
        name: "LFO 1 · 2 · 3",
        desc: "Three independent low-frequency oscillators, each slowly wobbling one part of the sound. All three blocks have the same five controls; set Dest to None to switch one off.",
        code: `// engine.js — every sample, all three LFOs are read and routed
for (let L = 0; L < 3; L++) {
  const v = shape === 4 ? this.lfoSH[L] : lfoWave(shape, this.lfoPhase[L]); // -1..1
  this.lfoPhase[L] += this.lfoInc[L];
  switch (this.lfoTargets[L]) { /* fold v into pitch/filter/amp/… */ }
}`,
      },
      ...ids.map((id) => ({ name: getParamSpec(drum, id).name, desc: paramDesc(id), code: paramCode(id) })),
    ];
  }
  const out: HelpItem[] = [];
  for (let i = 0; i < NUM_PARAMS; i++) {
    const id = i as ParamId;
    if (getParamGroup(id) === g) {
      out.push({ name: getParamSpec(drum, id).name, desc: paramDesc(id), code: paramCode(id) });
    }
  }
  return out;
}

/** The Shuffle section's glossary, top to bottom as rendered. */
export const SHUFFLE_HELP: HelpItem[] = [
  {
    name: "🎲 Shuffle",
    desc: "Rolls a new random sound: every randomizable parameter is redrawn inside the active preset's ranges, steered by the settings below. Volume and Choke are never touched.",
    code: `// drumKit.ts — randomize(): one draw per param, inside its preset window
for (let i = 0; i < NUM_PARAMS; i++) {
  if (!s.randomizable) continue;
  ...
  v = lo + rand() * (hi - lo);
  this.set(id, v);
}`,
  },
  {
    name: "▶ Recap line",
    desc: "A one-line summary of the current sound — wave, pitch, noise colour, active effects, tail length. Tap ▶ to hear it again.",
    code: `// soundView.ts — the recap is the sound describing itself
txt.textContent = this.kit.get(this.drum).describe().join(" · ");
play.onclick = () => this.cb.onAudition(drum);`,
  },
  {
    name: "Back",
    desc: "Steps back one change — undoes the last Shuffle, preset pick, or Reset for this sound.",
    code: `// drumKit.ts — backAll(): pop the undo stack (one snapshot per change)
const s = stack.pop()!;
p.restore(s.values);
p.restoreRanges(s.lo, s.hi);`,
  },
  {
    name: "Reset",
    desc: "Returns every parameter to the active preset's values.",
    code: `// drumKit.ts — resetToPreset(): values back to the preset (ranges kept)
for (let i = 0; i < NUM_PARAMS; i++) {
  this.set(id, this.preset.values[i] ?? getParamSpec(this.drum, id).def);
}`,
  },
  {
    name: "Preset button",
    desc: "The coloured button names the active preset; tap it to pick a factory preset. A preset sets the sound AND the ranges Shuffle draws from, so it steers future rolls too.",
    code: `// drumKit.ts — applyPreset(): each param gets a value AND a [lo, hi] window
this.lo[id] = Math.min(r.max, Math.max(r.min, lo));
this.hi[id] = Math.min(r.max, Math.max(r.min, hi));
this.set(id, p.values[i] ?? getParamSpec(this.drum, id).def);`,
  },
  {
    name: "Randomness %",
    desc: "How far a roll may wander from the current sound: at 10% values only nudge nearby, at 100% they're drawn from anywhere in the preset's range (and type controls like Wave reroll more often).",
    code: `// drumKit.ts — the draw window lerps from the current value to the preset edges
const lo = cur + (this.lo[id] - cur) * randomness;
const hi = cur + (this.hi[id] - cur) * randomness;
// discrete "type" params reroll with probability = randomness
if (hi > lo && rand() < randomness) this.set(id, lo + Math.floor(rand() * (hi - lo + 1)));`,
  },
  {
    name: "Spread",
    desc: "How shuffled Pitch and Cutoff spread out: Linear is uniform in Hz (leans high), Logarithmic spreads evenly across octaves (how the ear hears), Bass/Mid/High aim the draw at that register.",
    code: `// drumKit.ts — sampleFreq(): the curve shapes p, then maps back log-wise
if (curve === FreqCurve.Linear) return lo + rand() * (hi - lo);
if (curve === FreqCurve.Log) p = rand();
else p = mu + GAUSS_SIGMA * randNormal(); // Bass/Mid/High: bell around mu
return lo * Math.pow(hi / lo, p);`,
  },
  {
    name: "Max len",
    desc: "Caps how long a shuffled sound may ring. If a roll comes out longer, its FX tails (echo, then reverb) are trimmed first, then the body, until it fits. Off = no cap.",
    code: `// drumKit.ts — clampLength(): tails get whatever the amp body leaves over
const body = A + D + this.get(ParamId.AmpSustain) * R;
const tailBudget = Math.max(0, maxLen - body);
// echo delay/feedback shrink to fit, then reverb, then the body itself`,
  },
  {
    name: "Snap",
    desc: "Tunes the shuffled pitch after the roll: Semitone snaps to the nearest semitone, Key to the nearest note of the track's key and scale. Off leaves it free in Hz.",
    code: `// drumKit.ts — applyPitchSnap(): Hz → MIDI, round, walk to an allowed note
const midi = 69 + 12 * Math.log2(f / 440);
let target = Math.round(midi); // Semitone
const allowed = new Set(intervals(scale).map((iv) => (root + iv) % 12)); // Key`,
  },
  {
    name: "Seed",
    desc: "Type a seed to repeat a roll exactly — the same seed and preset give the same sound (exact at 100% randomness). Leave it empty for a fresh roll; the seed just used shows greyed so you can keep a good one.",
    code: `// drumKit.ts — seededRng(): hash the seed text, run a deterministic generator
let h = 1779033703 ^ seed.length;
h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); // xmur3 → mulberry32
// the shuffle's rand() reads from this, so the same seed repeats the roll`,
  },
];

/** The JSON section's glossary. */
export const JSON_HELP: HelpItem[] = [
  {
    name: "Sound JSON",
    desc: "The whole sound as text: every parameter's current value, keyed by name. It updates live as you edit.",
    code: `// soundView.ts — soundJson(): every param, rounded, keyed by its enum name
for (let i = 0; i < NUM_PARAMS; i++) {
  obj[ParamId[i]] = Math.round(p.get(i as ParamId) * 1e4) / 1e4;
}
return JSON.stringify(obj, null, 2);`,
  },
  {
    name: "Copy",
    desc: "Copies the JSON to the clipboard — paste it somewhere to keep a sound, share it, or compare two rolls.",
    code: `// soundView.ts
navigator.clipboard?.writeText(this.soundJson());`,
  },
];

/** The little round "?" for a section head. Tapping it opens the glossary panel
    (anchored to the button's row, which must be position:relative); tapping again,
    or anywhere outside, closes it. */
export function helpButton(section: string, items: HelpItem[]): HTMLButtonElement {
  const btn = mkBtn("?", "help-btn");
  btn.setAttribute("aria-label", `Explain the ${section} controls`);
  btn.setAttribute("aria-expanded", "false");

  let panel: HTMLElement | null = null;
  let onOutside: ((ev: PointerEvent) => void) | null = null;

  const close = () => {
    panel?.remove();
    panel = null;
    if (onOutside) {
      document.removeEventListener("pointerdown", onOutside, true);
      onOutside = null;
    }
    btn.classList.remove("on");
    btn.setAttribute("aria-expanded", "false");
  };

  btn.onclick = () => {
    if (panel) { close(); return; }
    panel = buildHelpPanel(section, items);
    btn.parentElement?.append(panel);
    btn.classList.add("on");
    btn.setAttribute("aria-expanded", "true");
    onOutside = (ev: PointerEvent) => {
      if (panel && !panel.contains(ev.target as Node) && ev.target !== btn) close();
    };
    // Next tick, so the opening tap itself doesn't instantly close it.
    setTimeout(() => { if (onOutside) document.addEventListener("pointerdown", onOutside, true); }, 0);
  };

  return btn;
}

// The glossary panel: a title, a hint, then one expandable row per control
// (<details> gives the accordion for free, keyboard included). Each open row shows
// the plain-words description, then the real engine lines behind it.
function buildHelpPanel(section: string, items: HelpItem[]): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "help-panel";

  const title = document.createElement("div");
  title.className = "help-title";
  title.textContent = section;
  const hint = document.createElement("div");
  hint.className = "help-hint";
  hint.textContent = "Tap a control to see what it does.";
  panel.append(title, hint);

  for (const it of items) {
    const row = document.createElement("details");
    row.className = "help-item";
    const sum = document.createElement("summary");
    sum.textContent = it.name;
    const desc = document.createElement("div");
    desc.className = "help-desc";
    desc.textContent = it.desc;
    row.append(sum, desc);
    if (it.code) {
      const code = document.createElement("pre");
      code.className = "help-code";
      code.textContent = it.code;
      row.append(code);
    }
    panel.append(row);
  }
  return panel;
}
