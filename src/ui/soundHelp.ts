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
// out). Written to teach, not just label: what the control is, what you'll HEAR as
// you move it, how it plays with its neighbours, and where to start. LFO 2/3 share
// LFO 1's text — the three blocks are identical.
function paramDesc(id: ParamId): string {
  switch (id) {
    // --- Tone ---
    case ParamId.Pitch:
      return "The oscillator's base frequency — how high or low the tone of the hit sits, from a 30 Hz sub-rumble up to a 2 kHz ping. This is the pitch you hear once any start-of-hit sweep has settled. It sets the kick's fundamental, the tom's tuning, the bass note. On a melody row each note re-tunes it on the fly, so there treat it as the home pitch the melody plays around. Tuned add-ons (the comb string, modal bank, FM modulator) all track this, so moving Pitch moves the whole sound together.";
    case ParamId.PitchEnvAmount:
      return "A pitch sweep at the very start of each hit, on top of the base Pitch. Positive amounts start ABOVE the pitch and drop down onto it — the classic kick/tom 'punch' and the snap in a snare. Negative amounts start BELOW and rise up into it, for reverse-swell and zap/laser risers. The number is how far it starts off (in octaves-ish), so small values are a subtle tightening and large values are a dramatic whoop. 0 = no sweep, a steady pitch. Pair it with Pitch Dec (how long) and Pitch Shape (how it travels).";
    case ParamId.PitchEnvDecay:
      return "How long the pitch sweep takes to travel to the base pitch, in seconds (up to 2s). Short (a few ms) is a tight click of punch you feel more than hear — the tom/kick attack. Longer makes the sweep an audible whoop, siren or riser that glides over the note. It only matters when Pitch Env is non-zero; it's the 'how fast' to Pitch Env's 'how far'. For the oscillating Pitch Shapes this is also the window the whole wobble fits inside.";
    case ParamId.PitchEnvShape:
      return "The SHAPE of the pitch sweep, not just its speed. Exp is the classic exponential drop/rise — fast at first, easing in (what most drum machines do). Line is a straight, even ramp; pair it with Pitch Curve to bend the slope back toward exponential. S-curve eases at both ends; Parabola bows in the middle. Sine/Cos/Triangle/Wobble instead make the pitch rise AND fall across the sweep — a warble or vibrato baked into the hit's start (use Pitch Cycles to set how many wiggles).";
    case ParamId.PitchEnvCurve:
      return "How much the chosen Pitch Shape bends, from 0 (the plain shape) upward. On Line it tips a straight ramp toward exponential, so the sweep starts steeper and eases in. On the wave shapes it warps or deepens the curve. It does nothing on its own — it's a modifier for whatever Pitch Shape is selected, so set the Shape first, then use Curve to taste.";
    case ParamId.PitchEnvCycles:
      return "For the oscillating pitch shapes (Sine/Cos/Triangle/Wobble) ONLY: how many rise-and-fall wiggles fit inside the sweep window (Pitch Dec). 1 is a single up-down; higher values pack in a faster warble. Ignored by the straight/curved shapes (Exp/Line/S-curve/Parabola), where there's nothing to repeat.";
    case ParamId.Waveform:
      return "The oscillator's raw waveform — the basic 'colour' of the tone before anything else touches it. Sine is pure and round with no harmonics (deep kicks, soft sub bass). Tri adds a little glassy edge. Square is hollow and buzzy (woody, clarinet-ish, chiptune). Saw is the brightest and richest, full of harmonics — the go-to for cutting bass and leads. Brighter waves give the filter and drive more to work with.";
    case ParamId.ToneLevel:
      return "Level of the oscillator — the tonal, PITCHED body of the hit (the part that has a note). Turn it up for melodic and bass sounds; balance it against Noise, which is the un-pitched hiss layer. A kick is mostly Tone; a hat is mostly Noise; a snare is a blend of both. At 0 the pitched layer is silent and you're left with just the noise layer (if any).";
    case ParamId.NoiseLevel:
      return "Level of the noise layer — the un-pitched hiss/sizzle/crackle part of the hit, where snares, hats, claps and cymbals live. Its character is set by Noise Col, and it can have its own decay via Noise Dec so the sizzle outlasts (or undercuts) the tone. Balance it against Tone: all noise = a hat or wash, all tone = a clean pitched hit, a mix = a snare. 0 turns the noise layer off.";
    case ParamId.NoiseType:
      return "The noise's colour — its spectral tilt, which changes how bright or dark the hiss reads. White is flat, full-spectrum hiss. Pink is warmer (less top). Brown is a dark, low rumble. Blue and Violet get progressively brighter and thinner, into airy sizzle. Crackle is sparse random pops (vinyl, fire). Metal is gritty sample-and-hold clang (industrial, hi-hat grit). Only audible when Noise has a level.";
    case ParamId.OscModType:
      return "Cross-modulates the main oscillator with a second hidden operator, for tones you can't get from a single wave. FM (frequency modulation) bends the carrier's pitch thousands of times a second, minting bells, clangs, electric pianos and growls. Ring (ring modulation) multiplies the two together for metallic, inharmonic, robotic tones. Off disables it. The character comes from Mod Ratio (which overtones) and Mod Amt (how strong); FM can be pushed further with FM FB.";
    case ParamId.OscModRatio:
      return "The modulator's frequency as a multiple of the pitch — this is what decides WHICH overtones FM/Ring adds. Whole-number ratios (1x, 2x, 3x) stay musical and harmonic (fuller tones, organ/EP shades). In-between values (1.5x, 2.7x…) are inharmonic and go clangy, bell-like and metallic. Only matters when Osc Mod is FM or Ring. Try small whole numbers for musical, odd fractions for percussion and bells.";
    case ParamId.OscModAmount:
      return "How hard the modulator pushes the carrier — the FM index / ring-mod depth. At 0 the modulation is off and you hear the plain oscillator. As you raise it, sidebands pile on: FM goes from a subtle sheen to a bright, gnarly, noisy growl; Ring goes from a light tremble to a full metallic clang. High values with an odd Mod Ratio quickly get aggressive and inharmonic.";
    case ParamId.Osc2Mix:
      return "Level of a SECOND oscillator layered under the first (0 = off). On its own it just thickens; the magic is with Osc2 Detune, which tunes it apart. Use a tiny detune for a fatter, beating unison; -12 semitones for a sub octave that adds weight; +7 for a fifth (that 808-cowbell clang). It shares the main Waveform. Turn it up to fatten leads and basses.";
    case ParamId.Osc2Detune:
      return "How far the second oscillator is tuned from the first, in semitones (-12 to +12). Tiny offsets (±0.1–0.3) make the two drift slowly against each other for a thick, chorused beating. -12 drops an octave (a built-in sub). +7 is a fifth, -5 a fourth — instant power-chord or cowbell intervals. It only does anything when Osc2 has a level. With Sync on, detune instead reshapes the timbre rather than adding a separate pitch.";
    case ParamId.Sync:
      return "Hard-syncs the second oscillator to the first: every time oscillator 1 restarts its cycle it snaps oscillator 2 back to the start too. On its own that's subtle, but combined with Osc2 Detune it produces the classic ripping, vowel-y 'sync lead' timbre — and sweeping the detune (or an LFO on it) gives that aggressive tearing sound. Needs Osc2 to have a level to be heard.";
    case ParamId.Fold:
      return "Wavefolder: instead of clipping the peaks flat like distortion, it folds the waveform back on itself, adding bright, glassy, metallic harmonics that shift as the level changes. Subtle amounts thicken and add shimmer; high amounts snarl and go bell-like or harsh. It reacts to how loud the signal is, so it's liveliest on sustained tones and works well swept by an envelope or LFO. 0 = off.";
    case ParamId.ClickLevel:
      return "Level of a tiny transient click — just a few milliseconds — layered right on the attack for extra snap, point and definition (the 'beater' of a kick, the tick of a hat). It sits on top of the main sound and cuts through a busy mix even when the body is soft. 0 = off. Pick its character with Click Type.";
    case ParamId.ClickType:
      return "The click's flavour: Tick is a sharp bright spike (a violet-noise transient), Snap a short white-noise burst, Knock a low sine thud (beatery, woody), Blip a high sine ping, Clank a sample-and-hold metal grit. Only audible when Click has a level. Match it to the sound — Knock for kicks, Tick/Snap for hats and snares, Blip/Clank for blips and percussion.";

    // --- Amp envelope ---
    case ParamId.AmpAttack:
      return "How long the hit takes to fade up to full level, in seconds (0 to 0.1s). At 0 it's an instant, punchy drum snap — what you want for almost all percussion. Raise it for a soft fade-in or swell, easing pads and reverse-style hits in gently. Even a few milliseconds rounds off a harsh transient. Its curve is set by Att Shape.";
    case ParamId.AmpDecay:
      return "After the attack peak, how long the level takes to fall to the Sustain level, in seconds — for percussive sounds (Sustain 0) this is the main 'length of the hit'. Short is a tight blip or closed hat; medium a snare or tom; long an open hat or a ringing tail. It's the single most important length control for drums. Its curve is set by Dec Shape.";
    case ParamId.AmpSustain:
      return "The level the sound HOLDS at, for as long as the note is gated on, after the decay finishes. At 0 you get a pure percussive hit that dies away during the Decay and never holds — the normal drum behaviour. Above 0 the sound sustains like a held synth note or a drone (pair with Gate for how long it's held). Think drums = 0, pads/bass notes/leads = higher.";
    case ParamId.AmpRelease:
      return "The fade-out time once the note is released (the gate ends), in seconds. Short cuts the sound off cleanly; long lets it ring on after the key/step lets go, for tails and echoes. It only really shows when Sustain is above 0 (otherwise the sound has usually already decayed away). Its curve follows Dec Shape.";
    case ParamId.AmpAttackShape:
      return "The CURVE of the attack, from 0 to 1. 0 is plucky — it jumps up fast then eases into full (immediate, aggressive). 0.5 is a straight line. 1 is a slow swell that stays quiet then rushes up at the end (soft, delayed, pad-like). It reshapes the same Attack time, changing feel without changing length. Only audible when Attack is above 0.";
    case ParamId.AmpDecayShape:
      return "The CURVE of the decay AND release, from 0 to 1. 0 holds near full then drops off a cliff, like a gate (electronic, blocky). 0.5 is a straight line. 1 falls fast at first then trails off — the natural exponential shape of real percussion. This one strongly changes the character of a drum tail; 1 is the safe 'natural' default, low values give that gated, synthetic feel.";
    case ParamId.ToneDecay:
      return "A SEPARATE decay for just the oscillator (tone) layer, in seconds, independent of the main amp envelope. Use it so the pitched part can die quicker (a short thump under a long sizzle) or ring longer (a tone tail under a snappy noise) than the noise layer. At 0 the tone simply follows the main envelope. When it's above 0 you can also shape it with Tone Shape/Curve/Cycles.";
    case ParamId.ToneEnvShape:
      return "The contour of the tone layer's own decay — only active when Tone Dec is above 0. Exp is the classic exponential fall. Line is a straight slope. S-curve/Parabola bend differently, and Sine/Cos/Triangle/Wobble make the tone swell and duck as it fades, for tremolo-like movement built into the note. Tone Curve and Tone Cycles fine-tune the chosen shape.";
    case ParamId.ToneEnvCurve:
      return "How much the tone-decay Shape bends, from 0 (the plain shape). It steepens a Line toward exponential, or warps/deepens the oscillating shapes. A modifier only — it needs Tone Shape set to something and Tone Dec above 0 to do anything.";
    case ParamId.ToneEnvCycles:
      return "For the oscillating tone-decay shapes (Sine/Cos/Triangle/Wobble): how many swells fit inside the tone decay. 1 is a single swell; higher packs in a faster tremble. Ignored by the straight/curved shapes, and only relevant when Tone Dec is above 0.";
    case ParamId.NoiseDecay:
      return "A SEPARATE decay for just the noise layer, in seconds, independent of the main envelope — e.g. a short tonal thump followed by a longer sizzle tail, or a snappy noise burst over a ringing tone. At 0 the noise simply follows the main envelope. When above 0 you can shape it with Noise Shape/Curve/Cycles.";
    case ParamId.NoiseEnvShape:
      return "The contour of the noise layer's own decay — only active when Noise Dec is above 0. Same family as the tone's: Exp fall, Line slope, S-curve/Parabola, or Sine/Cos/Triangle/Wobble for sizzle that swells and ducks as it fades (rhythmic, gated-noise textures). Noise Curve and Noise Cycles fine-tune it.";
    case ParamId.NoiseEnvCurve:
      return "How much the noise-decay Shape bends, from 0 (the plain shape) — steepens a Line, or warps/deepens the wave shapes. A modifier for Noise Shape; needs Noise Dec above 0 to matter.";
    case ParamId.NoiseEnvCycles:
      return "For the oscillating noise-decay shapes (Sine/Cos/Triangle/Wobble): how many swells fit inside the noise decay. Higher = a faster stutter in the sizzle. Ignored by the straight/curved shapes, and only when Noise Dec is above 0.";
    case ParamId.Gate:
      return "How long each hit is held 'on' before it releases, in seconds — the note-length control. With Sustain at 0 the hit already dies away during its Decay, so Gate barely matters. With any Sustain the sound holds at that level for the whole Gate, then Release fades it out. Short gate = choked, staccato stabs; long (up to 30s) = a drone that rings across bars — and keeps gliding under any transition running over it. Not touched by Shuffle (it's a length choice, not part of the timbre).";

    // --- Filter & resonators ---
    case ParamId.FilterType:
      return "The filter's mode — how it carves the sound's brightness. LP (low-pass) keeps lows and cuts highs, for a darker, rounder tone (the workhorse). HP (high-pass) cuts lows for a thin, tinny sound (hats, removing rumble). BP (band-pass) keeps only a narrow band around the cutoff, for telephone/radio and focused percussion. Vowel is a formant filter that morphs through A–E–I–O–U as the Cutoff moves — an instant talking wah, especially with an LFO on Filter.";
    case ParamId.FilterCutoff:
      return "Where the filter acts, in Hz (80 Hz to 18 kHz). For LP/HP/BP it's the corner frequency — lower makes LP darker and HP thinner; for Vowel it's the position along the A→U vowel sweep. It's drawn on the same log scale as Pitch. This is the single biggest 'brightness' control, and the natural target for an LFO (wah/wobble) or a per-hit sweep.";
    case ParamId.FilterReso:
      return "Resonance (Q) — a peak of emphasis right AT the cutoff frequency, from 0.5 (smooth, gentle) up to 8 (whistling, ringing, on the edge of self-oscillation). Low values shape broadly; high values make the filter sing and add a sharp vocal or squelchy character, and make a cutoff sweep really zing. High Reso can get piercing near the ear's sensitive range, so use it with intent.";
    case ParamId.CombMix:
      return "Blends in a plucked-string resonator (a Karplus–Strong comb): it excites a short tuned delay loop so hits ring like a plucked or struck string, adding a pitched 'ping' or twang on top. 0 = off (dry). Its pitch is set by Comb Tune and its ring length by Comb Decay. Great for adding a tonal, stringy body to clicks and noise bursts.";
    case ParamId.CombTune:
      return "The string resonator's pitch, as a ratio of the hit's Pitch — 1x rings in tune with the note, 2x an octave up, 0.5x an octave down. Whole and simple ratios stay musical; odd in-between ratios go metallic and bell-like. Only matters when Comb has a mix. Because it tracks Pitch, the ring stays in key as the note changes.";
    case ParamId.CombDecay:
      return "The string's feedback — how long the plucked resonator rings. Low is a short, dead, muted pluck; high is a long, sustaining, singing string. It's the 'how alive' control for the comb, and it needs Comb to have a mix to be heard. High values with a bright tuning can get whistly, so the shuffle guards them.";
    case ParamId.ModalMix:
      return "Blends in a bank of tuned resonators — physical-modelling bells, bars and drumheads that ring at the hit's pitch with a realistic set of overtones. 0 = off. Pick the overtone set with Material and the ring length with Modal Dec. It turns a plain click or noise burst into a struck metallic/wooden object — cowbells, glocks, tabla, gongs.";
    case ParamId.ModalMaterial:
      return "What the modal bank is 'made of' — the set of overtones (mode ratios and decays) it rings with. Membrane is a drumhead (toms, tabla). Bell is inharmonic and metallic. Bar is tuned and glockenspiel/marimba-like. Bowl is rounded and singing. Plate is a dense, inharmonic metallic wash. Only audible when Modal has a mix; it defines the physical character of the resonator.";
    case ParamId.ModalDecay:
      return "Scales how long every mode in the modal bank rings, from 0 (a tight, damped thud) to 1 (a long, bell-like sustain). It stretches or shortens all the overtones together. Needs Modal to have a mix. Short for percussive hits, long for ringing bells and drones.";

    // --- LFO (2/3 mirror 1) ---
    case ParamId.LfoTarget:
    case ParamId.Lfo2Target:
    case ParamId.Lfo3Target:
      return "An LFO is a slow, repeating wobble; this picks WHAT it wobbles (there are three independent LFOs). Some destinations swing symmetrically around the current value — Pitch (vibrato and sirens), Filter (cutoff wah and wobble), Amp (tremolo), Ring (through-zero AM), Wave (the square's pulse width), WTPos (sweeps a wavetable's scan). Others DRIVE their effect upward from wherever it sits, so they bite even when that effect is at zero — Drive (pumps saturation), Reso (into squelchy resonance), Crush (pumps bit-crush grit), and Noise, which INJECTS noise so the crest hands the sound over to hiss (fully at full depth) even if the noise layer is silent — a rhythmic noise burst. None switches this LFO off. Set the speed with Rate (or Sync) and the amount with Amt.";
    case ParamId.Lfo1Shape:
    case ParamId.Lfo2Shape:
    case ParamId.Lfo3Shape:
      return "The wobble's motion — the wave the LFO traces over and over. Sine is smooth and rounded (gentle vibrato/tremolo). Tri is an even up-and-down. Saw is a rising ramp that snaps back (a rhythmic rise, or a fall if depth is negative-feeling). Square is an on/off trill that jumps between two values. S&H (sample-and-hold) jumps to a new random value each cycle, for stepped, random, glitchy movement.";
    case ParamId.LfoRate:
    case ParamId.Lfo2Rate:
    case ParamId.Lfo3Rate:
      return "The wobble speed in Hz (0.1 to 40) — slow values are a gentle drift, fast values a buzzing vibrato or growl. This knob is used only while this LFO's Sync is set to Free; choosing a beat division under Sync overrides it and locks the speed to the tempo instead.";
    case ParamId.Lfo1Sync:
    case ParamId.Lfo2Sync:
    case ParamId.Lfo3Sync:
      return "Locks one LFO cycle to a beat division at the song tempo (e.g. 1/8 = two wobbles per beat), and phase-locks it to the grid at each hit so the movement stays in time — the beat-synced dubstep wobble. Dotted divisions give a swung feel. Free instead ignores the tempo and uses the Rate knob in Hz. Use Sync for rhythmic modulation, Free for free-running texture.";
    case ParamId.LfoDepth:
    case ParamId.Lfo2Depth:
    case ParamId.Lfo3Depth:
      return "How deep this LFO's wobble reaches — its amount. At 0 the LFO does nothing (effectively off, whatever the destination). As you raise it the movement grows, until at full it throws the target across its whole range (full vibrato, full wah, full tremolo). This is the main on/off and intensity control for each LFO.";

    // --- Drive & FX ---
    case ParamId.Drive:
      return "Saturation on the whole voice — a soft tanh overdrive after the filter. A little warms, thickens and glues the sound, adding harmonics and perceived loudness; a lot distorts, crunches and squares things off. It's gentler and rounder than the Crush/Downsample lo-fi effects. 0 = clean. Great for giving kicks weight and leads bite.";
    case ParamId.EchoTime:
      return "The gap between echo repeats, in seconds — short for slapback and metallic flutter, long for spacious, spread-out repeats. Used only while Echo Sync is Free; choosing a division under Echo Sync overrides this and locks the gap to the tempo. Needs Echo Mix above 0 to be heard.";
    case ParamId.EchoFeedback:
      return "How much of each echo is fed back into the delay, setting how many repeats you get: low gives one or two slaps, high gives a long, trailing cascade that can nearly run away. It shapes the length of the echo tail. Needs Echo Mix above 0. High feedback plus a long Echo Time makes big ambient washes.";
    case ParamId.EchoMix:
      return "The echo's volume against the dry hit — the wet/dry balance and the master on/off for the delay. 0 = echo off. Low adds a subtle sense of space and depth; high makes the repeats as loud as the source, for dub and rhythmic effects. Shape the repeats with Echo Time/Sync, Feedback and Ping-Pong.";
    case ParamId.EchoSync:
      return "Locks the echo's gap to a beat division at the song tempo (1/8, dotted values, etc.) so the repeats land musically on the grid. Dotted divisions give that classic trailing dub delay. Free instead uses the Echo Time knob in seconds, free of the tempo. Needs Echo Mix above 0.";
    case ParamId.EchoPing:
      return "Ping-pong: successive echoes bounce between the left and right speakers instead of repeating in place, for a wide, stereo, bouncing delay. Off keeps the repeats centred where the dry sound sits. Only audible when Echo has a mix; best appreciated on headphones or a stereo system.";
    case ParamId.ReverbSize:
      return "The size of the reverb space, from a small tight room to a long cavernous wash. Small adds subtle ambience and depth; large gives long, blurred tails that fill the space between hits. It sets how long the reverb rings; Verb Mix sets how much of it you hear. Needs Verb Mix above 0.";
    case ParamId.ReverbMix:
      return "The reverb's volume against the dry hit — the wet/dry balance and on/off for the reverb. 0 = reverb off. A touch adds air and places the sound in a space; a lot washes it out into an ambient tail. Pair with Verb Size for the room's character.";
    case ParamId.Crush:
      return "Bitcrusher — reduces the bit depth, quantising the signal into fewer levels for gritty, fizzy, lo-fi digital crunch. 12-bit is a subtle vintage-sampler grit; each step down (10, 8, 6…) is harsher, until 3-bit is fully destroyed and noisy. Off = clean. A staple for lo-fi, industrial and retro-console textures; stack it with Downsample for full lo-fi.";
    case ParamId.Downsample:
      return "Sample-rate reduction — replays the sound at a coarser rate (from 2x down to 16x lower) by holding each value for several samples, adding the aliased, ringing grit of a cheap old sampler. Off = full quality. Higher factors dull and dirty the top end and add metallic artefacts. Pairs naturally with Crush for a complete lo-fi treatment.";

    // --- Per-hit Life ---
    case ParamId.AccentAmount:
      return "Accents the FIRST hit of each rhythm cycle by ducking all the OTHER hits underneath it — so the downbeat pulses harder without you having to program velocities. 0 = every hit equal (flat, machine-like); higher = a stronger emphasis on the one, giving the pattern a groove and pulse. It changes the balance between hits, not the overall level.";
    case ParamId.Humanize:
      return "Adds a small random drift to each hit's level, pitch and filter cutoff, so a repeating pattern feels played by a person rather than stamped out by a machine. 0 = dead-identical hits; a little loosens things up nicely; a lot gets wild and unpredictable. It only varies per hit — it doesn't change the underlying sound, just nudges each strike.";
    case ParamId.HitChance:
      return "The probability that each scheduled hit actually plays, from 0.25 to 1. At 1 every hit sounds. Below 1, some hits randomly drop out — and a dropped hit may sneak through as a quiet GHOST note instead of pure silence, for busy, evolving, humanised patterns. Lower it for sparse, generative feels; keep it at 1 for a locked, dependable groove.";
    case ParamId.Ratchet:
      return "The chance that a hit becomes a fast 2–4x retrigger burst — a mini roll, flam or stutter packed into the one step. 0 = never; higher makes bursts more frequent, for rolls, fills and glitchy energy. Each sub-hit is slightly quieter than the last. A little adds life to hats and snares; a lot turns a steady pattern into a stuttering machine.";
    case ParamId.ChokeGroup:
      return "Puts this sound in a choke group (A–D) — sounds in the SAME group cut each other off, so when one fires the others stop ringing. The classic use is a closed hat choking an open hat so they never overlap, exactly like a real hi-hat. Off = never choked. It's a relationship between sounds, so Shuffle leaves it alone.";

    // --- Output ---
    case ParamId.Volume:
      return "This voice's overall loudness in the final mix — the fader for the whole sound. Use it to balance this voice against the others. Shuffle never touches it, so re-rolling the sound won't throw your mix levels off.";
    case ParamId.Pan:
      return "Where the voice sits in the stereo field, from hard left to hard right, with centre in the middle. It uses constant-power panning, so a sound isn't louder in the middle than at the sides. Spread your voices across the field for width; keep bass and kicks near centre so they stay solid. Very low sounds get pulled toward centre automatically.";

    // --- Fatter oscillators / wavetable (Tone) ---
    case ParamId.Unison:
      return "Stacks several slightly detuned copies of the main oscillator (3, 5 or 7 voices) for a much thicker, wider sound — the supersaw behind big trance/EDM leads and pads. Off = the single classic oscillator. The more voices, the bigger and more chorused, but also the more CPU and the softer the transient. Set how far the copies spread with Spread.";
    case ParamId.UnisonDetune:
      return "How far the stacked unison copies spread apart in pitch. A touch fattens and adds a gentle shimmer; a lot swirls into a wide, chorused, seasick detune (full supersaw). It does nothing unless Unison is on (more than the single voice). More spread = wider and lusher, but too much can sound out of tune, so dial to taste.";
    case ParamId.FmFeedback:
      return "Feeds the FM operator back into itself, morphing its modulating sine toward a saw and then toward noise — so the FM tone goes from clean and bell-like to gritty, bright and aggressive. It only bites when Osc Mod is set to FM (it does nothing for Ring or Off). A powerful way to dirty up and add edge to FM sounds without changing the ratio.";
    case ParamId.WaveTable:
      return "Swaps the analog Sine/Tri/Square/Saw oscillator for a scannable digital WAVETABLE — a bank of morphing frames — in the Formant, Harmonic, Vocal or Digital families, each with its own evolving character. Off = the normal oscillator. Once a table is chosen, Scan (WavePosition) moves through its frames, and an LFO on 'WTPos' animates it (the Serum-style motion).";
    case ParamId.WavePosition:
      return "Scans through the chosen wavetable's frames, crossfading between them to morph the timbre — from one tone into a completely different one across the sweep. It only does anything when a Table is selected (it's ignored by the analog oscillator). Assign an LFO to 'WTPos', or sweep it per-hit, to get that continuously-evolving digital motion.";

    // --- Modulation FX ---
    case ParamId.ModFxType:
      return "A modulated stereo effect placed after the echo and reverb: Chorus thickens and widens with a lush, detuned shimmer; Flanger adds a swirling, jet-plane comb sweep; Phaser adds sweeping notches for a softer, watery swish. Off = bypassed. It's the finishing 'movement and width' effect; shape it with Rate, Depth, FB and Mix.";
    case ParamId.ModFxRate:
      return "How fast the modulation effect sweeps back and forth, in Hz — slow for a gentle, evolving drift and width, fast for a vibrato-like shimmer or a watery churn. Works together with Depth (how far it sweeps). Only audible when Mod FX is on with some Mix.";
    case ParamId.ModFxDepth:
      return "How far the modulation sweep travels — subtle widening and movement at low values, dramatic, seasick, obvious motion at high ones. Pairs with Rate (how fast). Only matters when Mod FX is on with some Mix.";
    case ParamId.ModFxFeedback:
      return "Resonance for the Flanger and Phaser — feeds the effect back into itself for a sharper, more intense, metallic ringing sweep. Chorus ignores it. Higher makes flanger/phaser sweeps more pronounced and whooshy. Only matters when Mod FX is Flanger or Phaser with some Mix.";
    case ParamId.ModFxMix:
      return "Dry/wet blend for the modulation effect — the on/off and intensity for Mod FX. 0 = off (fully dry). Higher folds more of the swept, widened, stereo signal into the voice, up to a fully processed sound. Use a little for width, a lot for obvious effect.";

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
this.pitchEnv *= this.pitchEnvCoef; // every sample (Exp shape)`;
    case ParamId.PitchEnvShape:
    case ParamId.PitchEnvCurve:
    case ParamId.PitchEnvCycles:
      return `// engine.js — non-Exp shapes ride the blend-shape family over the D window
if (this.pitchEnvShape === null) this.pitchEnv *= this.pitchEnvCoef;   // Exp
else this.pitchEnv = 1 - shapeT(Math.min(1, this.pitchEnvT / this.pitchEnvDurSamples),
                                { shape, curve, cycles }); // Line / S-curve / Sine / …`;
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
    case ParamId.ToneEnvShape:
    case ParamId.ToneEnvCurve:
    case ParamId.ToneEnvCycles:
      return `// engine.js — a non-Exp Shape swaps the tone layer's decay for a blend shape
if (this.toneEnvShape === null) this.toneEnv *= this.toneEnvCoef;      // Exp
else this.toneEnv = 1 - shapeT(Math.min(1, this.toneEnvT / this.toneEnvDurSamples),
                               { shape, curve, cycles });              // Line / Sine / …`;
    case ParamId.NoiseDecay:
      return `// engine.js — same trick for the noise layer, on its own clock
this.noiseEnvCoef = noiseDec > 0.004 ? Math.exp(-1 / (noiseDec * this.sr)) : 0;
if (this.noiseEnvCoef > 0) { noiseAmp *= this.noiseEnv; this.noiseEnv *= this.noiseEnvCoef; }`;
    case ParamId.NoiseEnvShape:
    case ParamId.NoiseEnvCurve:
    case ParamId.NoiseEnvCycles:
      return `// engine.js — the noise layer's decay can take the same blend shapes
if (this.noiseEnvShape === null) this.noiseEnv *= this.noiseEnvCoef;   // Exp
else this.noiseEnv = 1 - shapeT(Math.min(1, this.noiseEnvT / this.noiseEnvDurSamples),
                                { shape, curve, cycles });             // Line / Sine / …`;
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
      return `// engine.js — each LFO's value v (-1..1) folds into its destination.
// The "amount" dests use a unipolar u = ½+½v so they drive up from off.
case LFO_PITCH:  pitchMul  *= Math.pow(2, v * depth * 0.5);     break; // vibrato
case LFO_FILTER: cutoffMul *= Math.pow(2, v * depth * 2);       break; // wah
case LFO_AMP:    ampMul    *= 1 - depth * (0.5 * (1 - v));      break; // tremolo
case LFO_RING:   ringMul   *= 1 + v * depth;                    break; // through-zero AM
case LFO_WAVE:   pwOff     += v * depth * 0.45;                 break; // pulse width
case LFO_DRIVE:  driveAdd  += u * depth * 2;                    break; // pump saturation
case LFO_RESO:   resoMul   *= Math.pow(2, u * depth * 2.5);     break; // into resonance
case LFO_CRUSH:  crushShift += u * depth * 8;                   break; // pump crush
case LFO_NOISE:  noiseInj  += u * depth;  // → noiseAmp blends up to full, tone ducks`;
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

    // --- Fatter oscillators / wavetable ---
    case ParamId.Unison:
      return `// engine.js — sum detuned copies of the primary osc, normalise by 1/√count
for (let u = 0; u < this.unisonCount; u++) {
  let ph = this.uPhase[u] + fmOff; ph -= Math.floor(ph);
  sum += this.osc(ph, this.waveform, pw, dt * this.uDetune[u]);
}
osc = sum * this.unisonNorm;`;
    case ParamId.UnisonDetune:
      return `// engine.js — symmetric cent spread around 1.0, per unison voice
const c = (u / (this.unisonCount - 1)) * 2 - 1;      // -1..1
this.uDetune[u] = Math.pow(2, (c * spreadCents) / 1200);`;
    case ParamId.FmFeedback:
      return `// engine.js — the FM operator bends its own phase with its last output
this.fbMod = Math.sin(TWO_PI * this.modPhase + this.fmFeedback * this.fbMod);
modOut = this.fbMod; // sine -> saw -> noise as feedback rises`;
    case ParamId.WaveTable:
      return `// engine.js — wtFamily>0 reads a mip-mapped morph table instead of this.osc
osc = this.wtFamily > 0
  ? wtSample(this.wtFamily - 1, wtScan, ph, dt)
  : this.osc(ph, this.waveform, pw, dt);`;
    case ParamId.WavePosition:
      return `// engine.js — scan crossfades the two frames nearest the position
const wtScan = this.wtPos + wtPosOff; // wtPosOff from an LFO on "WTPos"
const fp = clamp(pos, 0, 1) * (WT_FRAMES - 1);        // frame crossfade`;

    // --- Modulation FX ---
    case ParamId.ModFxType:
      return `// engine.js — a stereo modulated delay / allpass cascade after the reverb
if (modOn) {
  this.modfx.setup(modType, rate, depth, feedback);
  this.modfx.render(scratch, n, this.wetL, this.wetR); // mono in, stereo out
}`;
    case ParamId.ModFxRate:
      return `// engine.js — quadrature LFO phases give L/R width at this rate
const lfoL = Math.sin(TWO_PI * this.phase);
const lfoR = Math.sin(TWO_PI * (this.phase + 0.25));
this.phase += this.rate / this.sr;`;
    case ParamId.ModFxDepth:
      return `// engine.js — depth scales the delay sweep (chorus/flanger)
const dL = this.baseD + this.modD * (0.5 + 0.5 * lfoL);
const wetL = this.readInterp(dL); // modD = depth * range`;
    case ParamId.ModFxFeedback:
      return `// engine.js — flanger/phaser resonance feeds the wet back in
this.buf[this.w] = x + (wetL + wetR) * 0.5 * this.fbAmt; // flanger
// phaser: let s = x + fbPrev * this.fbAmt; (before the allpass cascade)`;
    case ParamId.ModFxMix:
      return `// engine.js — dry scaled by (1-mix), stereo wet added on top
masterL[offset + i] += s * gl * dryG + this.wetL[i] * vol * modMix;
masterR[offset + i] += s * gr * dryG + this.wetR[i] * vol * modMix;`;

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
    desc: "Rolls a new random sound: every randomizable parameter is redrawn across its full range, steered by the settings below. Volume and Choke are never touched.",
    code: `// drumKit.ts — randomize(): one draw per param, across its full base range
for (let i = 0; i < NUM_PARAMS; i++) {
  if (!s.randomizable) continue;
  const r = baseRange(id);
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
    desc: "Steps back one change — undoes the last Shuffle or Reset for this sound.",
    code: `// drumKit.ts — backAll(): pop the undo stack (one snapshot per change)
const s = stack.pop()!;
this.get(drum).restore(s.values);`,
  },
  {
    name: "Reset",
    desc: "Returns the sound to the default starting sound (continuous params centred in their range, types/level at their defaults).",
    code: `// drumKit.ts — resetToDefault(): centre continuous params, keep type/level defaults
const keepDef = isDiscrete(s) || id === ParamId.Volume || id === ParamId.HitChance || id === ParamId.Gate;
this.set(id, keepDef ? s.def : (s.min + s.max) / 2);`,
  },
  {
    name: "Randomness %",
    desc: "How far a roll may wander from the current sound: at 10% values only nudge nearby, at 100% they're drawn from anywhere in the full range (and type controls like Wave reroll more often).",
    code: `// drumKit.ts — the draw window lerps from the current value to the full-range edges
const lo = cur + (r.min - cur) * randomness;
const hi = cur + (r.max - cur) * randomness;
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
    desc: "Type a seed to repeat a roll exactly — the same seed gives the same sound (exact at 100% randomness). Leave it empty for a fresh roll; the seed just used shows greyed so you can keep a good one.",
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

/** The little round "?" for a section head. Tapping it opens the glossary as a
    full-screen modal (a dimmed backdrop with a centred, scrollable card and an ✕);
    tapping the backdrop, the ✕, Escape, or the button again closes it. */
export function helpButton(section: string, items: HelpItem[]): HTMLButtonElement {
  const btn = mkBtn("?", "help-btn");
  btn.setAttribute("aria-label", `Explain the ${section} controls`);
  btn.setAttribute("aria-expanded", "false");

  let overlay: HTMLElement | null = null;
  let onKey: ((ev: KeyboardEvent) => void) | null = null;

  const close = () => {
    overlay?.remove();
    overlay = null;
    if (onKey) { document.removeEventListener("keydown", onKey, true); onKey = null; }
    btn.classList.remove("on");
    btn.setAttribute("aria-expanded", "false");
  };

  btn.onclick = () => {
    if (overlay) { close(); return; }
    overlay = document.createElement("div");
    overlay.className = "help-overlay";
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay.append(buildHelpPanel(section, items, close));
    document.body.append(overlay);
    btn.classList.add("on");
    btn.setAttribute("aria-expanded", "true");
    onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") close(); };
    document.addEventListener("keydown", onKey, true);
  };

  return btn;
}

// The glossary panel: a sticky header (title + ✕), a hint, then one expandable row
// per control (<details> gives the accordion for free, keyboard included). Each open
// row shows the plain-words description, then the real engine lines behind it.
function buildHelpPanel(section: string, items: HelpItem[], onClose: () => void): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "help-panel";

  const head = document.createElement("div");
  head.className = "help-head";
  const title = document.createElement("div");
  title.className = "help-title";
  title.textContent = section;
  const x = document.createElement("button");
  x.className = "help-close";
  x.textContent = "×";
  x.setAttribute("aria-label", "Close help");
  x.onclick = onClose;
  head.append(title, x);
  const hint = document.createElement("div");
  hint.className = "help-hint";
  hint.textContent = "Tap a heading to fold it away.";
  panel.append(head, hint);

  for (const it of items) {
    // Everything OPEN by default — the panel reads as one page, nothing minimised
    // (a heading still folds its block away if wanted).
    const row = document.createElement("details");
    row.className = "help-item";
    row.open = true;
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
