// reverse.ts — the sound's graph flipped on its middle axis, as a snapshot.
//
// A transition can arrive at its target sound BACK TO FRONT: the hit swelling into itself
// instead of falling away from itself. The engine cannot help with that — Voice.renderAdding
// is a forward-only per-sample recurrence (IIR filters, noise state, channel FX shared
// between voices) and nothing anywhere holds a finished hit's samples, so there is no tape
// to run backwards. What CAN be mirrored is the sound's own description: the time functions
// the graph draws. reverseSnapshot returns a new snapshot whose envelopes read end for end,
// which the morph then lerps toward across the transition's window — so the hits turn round
// gradually, following the transition's blend curve, with no DSP change at all.
//
// WHAT MIRRORS EXACTLY
//   AmpAttack <-> AmpDecay, AmpAttackShape <-> AmpDecayShape. The engine's attack is
//   t^aExp and its decay s + (1-s)·(1-t)^dExp (ADSR.next in engine.js), so reversing one
//   segment in time IS the other segment — and both shape knobs go through the same
//   shapeExp(s) = 4^(2s-1) map, so swapping the two values swaps the two exponents.
//   Exact while Sustain is 0; with a sustained note the held middle has no mirror and this
//   becomes an approximation (a good one — the attack and the fall still trade places).
//   The 32 PitchDraw* slots reverse in order, which is a true mirror of a hand-drawn pitch
//   contour, since it is stretched over the sound's own span either way. Only when the
//   contour is actually in use (PitchEnvShape = Drawn): the slots are inert for the other
//   eight shapes, and reversing dead data would show up as phantom "params changed".
//
// WHAT IS DELIBERATELY LEFT ALONE (the omissions are the interesting half)
//   AmpSustain / AmpRelease — release runs AFTER note-off, so in a mirror it would have to
//     lead the hit, and the engine has no pre-note segment. Note the knock-on: the decay
//     shape drives the release curve too, so swapping the shapes bends the release with it.
//   ToneDecay / NoiseDecay and their shape/curve/cycles — armShapedEnv always runs
//     1 - shapeT(u), i.e. falling from note-on; a 0->1 swell is not expressible. A sound
//     shaped mostly by its layer decays therefore reverses only weakly.
//   PitchEnvAmount/Decay/Shape/Curve/Cycles when the shape is NOT Drawn — same reason: the
//     sweep settles from its extreme toward the base pitch and the fixed contour family
//     cannot start flat and rush away at the end. It IS expressible by baking the mirrored
//     trajectory into a Drawn contour, but that needs the tempo (the span comes from the
//     graph's own width) and would silently rewrite 33 slots. The obvious follow-up, not
//     this version.
//   ClickLevel / ClickType — the transient is welded to note-onset.
//   Echo* / Reverb* — a tail trails a sound; pre-echo does not exist.
//   Filter, drive, crush, mod FX, comb, modal, LFOs, Volume, Pan, Gate, the life params —
//     steady or free-running from note-on, so mirroring them is the identity.

import { ParamId, PITCH_DRAW_BASE, PITCH_DRAW_SLOTS } from "./params";
import { PITCH_SHAPE_DRAWN } from "./paramSpec";

/** The time-mirror of `snap`, as a NEW array — the caller's snapshot is never touched (the
    compile path derives this fresh on every recompile from the live, editable target). */
export function reverseSnapshot(snap: number[]): number[] {
  const out = snap.slice();
  // A short snapshot (an old save, before padSnapshot fills it) is left as it is rather
  // than grown here: a hole in the array would lerp as NaN in the engine.
  const swap = (a: ParamId, b: ParamId): void => {
    if (a >= out.length || b >= out.length) return;
    const t = out[a];
    out[a] = out[b];
    out[b] = t;
  };
  swap(ParamId.AmpAttack, ParamId.AmpDecay);
  swap(ParamId.AmpAttackShape, ParamId.AmpDecayShape);

  // The drawn pitch contour, back to front — only while it is the contour being played.
  if (Math.round(snap[ParamId.PitchEnvShape] ?? 0) === PITCH_SHAPE_DRAWN
      && out.length >= PITCH_DRAW_BASE + PITCH_DRAW_SLOTS) {
    for (let i = 0; i < PITCH_DRAW_SLOTS; i++) {
      const src = PITCH_DRAW_BASE + (PITCH_DRAW_SLOTS - 1 - i);
      out[PITCH_DRAW_BASE + i] = snap[src] ?? 0;
    }
  }
  return out;
}
