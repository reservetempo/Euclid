// Maps the 5 rows of a melody grid to notes of a chosen key (root + scale) and,
// for a given drum, to the frequency it should play. Port of MelodyScale.h.
//
// The frequency mapping is duplicated in public/worklet/engine.js (which owns
// the clock and triggers notes); this TS copy drives the UI (row note labels).
// Keep the interval tables in sync between the two.

import { DrumType } from "./drums";
import { getParamSpec } from "./paramSpec";
import { ParamId } from "./params";

export const NUM_NOTES = 5; // rows per grid

export enum ScaleType {
  Major = 0,
  Minor,
  MajorPentatonic,
  MinorPentatonic,
  NumScales,
}

const INTERVALS: number[][] = [
  [0, 2, 4, 5, 7, 9, 11], // Major
  [0, 2, 3, 5, 7, 8, 10], // Natural minor
  [0, 2, 4, 7, 9],        // Major pentatonic
  [0, 3, 5, 7, 10],       // Minor pentatonic
];

const ROOT_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SCALE_NAMES = ["Major", "Minor", "Maj Pent", "Min Pent"];

const ROOT_MIDI = 60; // C4 anchor for root semitone 0

const clampInt = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export function intervals(scaleType: number): number[] {
  return INTERVALS[clampInt(scaleType, 0, ScaleType.NumScales - 1)];
}

export function scaleName(scaleType: number): string {
  return SCALE_NAMES[clampInt(scaleType, 0, ScaleType.NumScales - 1)];
}

export function rootName(rootSemitone: number): string {
  return ROOT_NAMES[((rootSemitone % 12) + 12) % 12];
}

export const ALL_ROOTS = ROOT_NAMES;
export const ALL_SCALES = SCALE_NAMES;

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Semitones above the root for a grid row (row 0 = top = highest). */
export function semitoneForRow(row: number, scaleType: number): number {
  const iv = intervals(scaleType);
  const len = iv.length;
  const degIdx = NUM_NOTES - 1 - row; // 0 = bottom
  return 12 * Math.floor(degIdx / len) + iv[degIdx % len];
}

/** Note name for a row's label, e.g. "E". */
export function noteNameForRow(row: number, rootSemitone: number, scaleType: number): string {
  return rootName(rootSemitone + semitoneForRow(row, scaleType));
}

/** Frequency a drum should play for a row in the given key (matches the worklet). */
export function frequencyFor(
  drum: DrumType, row: number, rootSemitone: number, scaleType: number
): number {
  const sp = getParamSpec(drum, ParamId.Pitch);
  const lo = sp.min;
  const hi = sp.max;

  const midi = ROOT_MIDI + rootSemitone + semitoneForRow(row, scaleType);
  const refMidi = ROOT_MIDI + rootSemitone + semitoneForRow(Math.floor(NUM_NOTES / 2), scaleType);
  const drumCentre = Math.sqrt(lo * hi);
  const octaveShift = Math.round(Math.log2(drumCentre / midiToHz(refMidi)));

  const freq = midiToHz(midi) * Math.pow(2, octaveShift);
  return Math.max(lo, Math.min(hi, freq));
}
