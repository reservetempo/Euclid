// MELODY MODEL (nodal / midinous-inspired). The last coloured row of the track hosts a
// MELODY instead of loops: a tree of "contexts", each a chosen scale + a set of weighted
// notes. A note carries its own length and a pre-note rest, and can spawn a BRANCH — a
// sequential sub-phrase in its own scale/weights that plays after the note, then returns.
//
// Generation (a seeded, re-rollable walk that emits a linear note stream to fill the
// track's bar length) and compilation into an engine lane live alongside this model in
// later steps. For now this file owns the data shape + small helpers the editor uses.
//
// One instrument, re-pitched: the whole melody plays through a single shuffled sound;
// each emitted note only sets its pitch (computed in TS via melodyScale.degreeHz).

import { ScaleType } from "./melodyScale";

/** The last coloured row (voice 6) is the melody lane. */
export const MELODY_COLOR_INDEX = 5;

/** One weighted note in a context: which scale degree, how likely it is to be picked,
    how long it sounds, and how long the melody rests BEFORE it. Steps are 16th notes. */
export interface MelodyNote {
  degree: number;      // scale-degree index (0 = root; may climb past one octave)
  weight: number;      // pick odds within its context — a dice face, 1..6
  lengthSteps: number; // sounding length, in 16th-note steps
  restSteps: number;   // silent steps before the note (a pause); 0 = none
  branch?: MelodyNode; // a sequential sub-phrase off this note (added later in the UI)
}

/** One musical context: a scale (its own root + base octave) and the weighted notes drawn
    from it. The root MelodyNode is the whole melody's entry point. */
export interface MelodyNode {
  scale: number;         // ScaleType
  root: number;          // 0..11 semitone (C = 0)
  octave: number;        // octave shift from the C4 anchor (−2..+2)
  notes: MelodyNote[];
  seed: number;          // generation seed (re-roll mints a new one)
  seedHistory: number[]; // previous seeds, for a Back button
}

/** A 32-bit seed. */
export function melodySeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

/** A fresh, empty melody: C Major, no notes yet. */
export function emptyMelody(): MelodyNode {
  return { scale: ScaleType.Major, root: 0, octave: 0, notes: [], seed: melodySeed(), seedHistory: [] };
}

/** A default note for a context: the root degree, mid weight, a quarter note, no rest. */
export function defaultNote(): MelodyNote {
  return { degree: 0, weight: 3, lengthSteps: 4, restSteps: 0 };
}
