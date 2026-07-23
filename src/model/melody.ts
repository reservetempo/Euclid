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

import { ScaleType, degreeHz, degreesPerOctave } from "./melodyScale";
import { VoiceNode, emptyNode, STEPS_PER_BAR } from "./lines";
import { voicePattern } from "./euclid";
import { rng01, randomSeed as melodySeed } from "./rng";
import type { Loop } from "./track";

export { melodySeed }; // re-export: project.ts mints seeds for melodies saved without one

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

/** A fresh, empty melody: C Major, no notes yet. */
export function emptyMelody(): MelodyNode {
  return { scale: ScaleType.Major, root: 0, octave: 0, notes: [], seed: melodySeed(), seedHistory: [] };
}

/** A default note for a context: the root degree, mid weight, a quarter note, and a rest
    before it of the same length. */
export function defaultNote(): MelodyNote {
  return { degree: 0, weight: 3, lengthSteps: 4, restSteps: 4 };
}

/** Fill a context with `count` freshly RANDOM notes drawn from its scale: all distinct
    degrees (from ~two octaves), each a random dice weight (1..6), with lengths mostly
    uniform (one base, a minority a step longer/shorter) and rests mostly none with the
    occasional short pause — "random but mostly the same" so it grooves. A direct design
    action (Math.random); the seeded WALK still governs playback order (see generateMelody).
    Branches are dropped, since the degrees change. */
export function randomizeNotes(node: MelodyNode, count: number): void {
  const span = Math.max(1, degreesPerOctave(node.scale) * 2);
  const k = Math.max(1, Math.min(Math.round(count), span));
  // Distinct degrees: shuffle [0, span) and take k.
  const pool = Array.from({ length: span }, (_, i) => i);
  for (let i = span - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const base = 2 + ((Math.random() * 3) | 0); // 2..4 sixteenth-steps (eighth..quarter-ish)
  node.notes = pool.slice(0, k).map((degree): MelodyNote => {
    let len = base;
    if (Math.random() < 0.3) len += Math.random() < 0.5 ? -1 : 1; // slight variation
    const rest = Math.random() < 0.25 ? 1 + ((Math.random() * 2) | 0) : 0; // occasional short pause
    return { degree, weight: 1 + ((Math.random() * 6) | 0), lengthSteps: Math.max(1, len), restSteps: rest };
  });
}

/** A fresh branch context off a parent note: inherits the parent's scale/root/octave (a
    natural starting point) and seeds one default note. */
export function newBranch(parent: MelodyNode): MelodyNode {
  return {
    scale: parent.scale, root: parent.root, octave: parent.octave,
    notes: [defaultNote()], seed: melodySeed(), seedHistory: [],
  };
}

/** Longest run chainNotes lays down (kept under the walk's recursion guard). */
export const MAX_CHAIN = 48;

/** Lay an ordered run of notes into `node` as a sequential CHAIN: the first note becomes
    the context's only note and each later note nests in a single-note branch under the
    one before, so playback follows the run exactly in order (a strict chain loops
    verbatim — see generateMelody). Used by the Sing tab's "keep my order" apply. Any
    branches on the incoming notes are dropped. Returns the laid run's total length in
    16th steps (rests + notes), for sizing the phrase around one pass. */
export function chainNotes(node: MelodyNode, notes: MelodyNote[]): number {
  const run = notes.slice(0, MAX_CHAIN).map((n): MelodyNote => ({
    degree: n.degree, weight: n.weight, lengthSteps: n.lengthSteps, restSteps: n.restSteps,
  }));
  node.notes = run.length ? [run[0]] : [];
  for (let i = 1; i < run.length; i++) {
    run[i - 1].branch = {
      scale: node.scale, root: node.root, octave: node.octave,
      notes: [run[i]], seed: melodySeed(), seedHistory: [],
    };
  }
  return run.reduce((s, n) => s + Math.max(0, Math.round(n.restSteps)) + Math.max(1, Math.round(n.lengthSteps)), 0);
}

/** Total notes in a melody tree (root + every branch), for summaries. */
export function countNotes(node: MelodyNode): number {
  let n = node.notes.length;
  for (const note of node.notes) if (note.branch) n += countNotes(note.branch);
  return n;
}

// --- generation ---------------------------------------------------------------
// A seeded walk over the melody's weighted notes emits a linear note stream long enough
// to fill the track. Deterministic per seed, so "Generate again" = mint a new seed. A
// note's rest+length advances the timeline; a branch (sequential sub-phrase) is played
// out in full after its parent note, then the walk returns to the parent context.
// EXCEPTION: a strict chain (every context one note — a recorded take kept "in my
// order") skips the walk and plays verbatim, looping whole passes (see emitChain).

/** One emitted note on the flattened timeline: its absolute pitch degree (in ITS context's
    scale/root/octave) plus its length and the rest before it, all in 16th steps. */
export interface EmittedNote {
  hz: number;        // absolute pitch (computed against the emitting context)
  lengthSteps: number;
  restSteps: number;
}

/** Pick a note index from `notes` with odds ∝ weight, using the shared rng. */
function pickNote(notes: MelodyNote[], rng: () => number): number {
  let total = 0;
  for (const n of notes) total += Math.max(1, n.weight);
  let roll = rng() * total;
  for (let i = 0; i < notes.length - 1; i++) { roll -= Math.max(1, notes[i].weight); if (roll < 0) return i; }
  return notes.length - 1;
}

// Walk one context, appending EmittedNotes until `budget.left` steps run out. A note may
// descend into its branch (played in full) before the walk continues in this context.
function walk(node: MelodyNode, rng: () => number, out: EmittedNote[], budget: { left: number }, depth: number): void {
  if (node.notes.length === 0 || budget.left <= 0 || depth > MAX_CHAIN + 16) return;
  // Cap how many notes one context contributes before yielding, so a branch can't hog
  // the whole track and the parent context still gets played. A single-note context is
  // a chain link (see chainNotes): it plays its note ONCE per visit, never stuttered.
  let placed = 0;
  const cap = node.notes.length === 1 ? 1 : 4 + node.notes.length * 4;
  while (budget.left > 0 && placed < cap) {
    const note = node.notes[pickNote(node.notes, rng)];
    const rest = Math.max(0, Math.round(note.restSteps));
    const len = Math.max(1, Math.round(note.lengthSteps));
    if (rest + len > budget.left) {
      // Final note: rest first, then fill whatever's left with the note.
      const r = Math.min(rest, budget.left);
      budget.left -= r;
      if (budget.left > 0) {
        out.push({ hz: degreeHz(note.degree, node.root, node.scale, node.octave), lengthSteps: budget.left, restSteps: r });
        budget.left = 0;
      } else {
        out.push({ hz: degreeHz(note.degree, node.root, node.scale, node.octave), lengthSteps: 0, restSteps: r });
      }
      return;
    }
    out.push({ hz: degreeHz(note.degree, node.root, node.scale, node.octave), lengthSteps: len, restSteps: rest });
    budget.left -= rest + len;
    placed++;
    if (note.branch) walk(note.branch, rng, out, budget, depth + 1); // sequential sub-phrase
  }
}

/** The melody read as a strict CHAIN — every context exactly one note, linked branch to
    branch (what the Sing tab's "in my order" apply lays down). Returns the ordered
    (context, note) pairs, or null when any context is a weighted pool (those keep the
    seeded walk). */
function chainPairs(melody: MelodyNode): { ctx: MelodyNode; note: MelodyNote }[] | null {
  const pairs: { ctx: MelodyNode; note: MelodyNote }[] = [];
  let ctx: MelodyNode | undefined = melody;
  while (ctx) {
    if (ctx.notes.length !== 1) return null;
    const note: MelodyNote = ctx.notes[0];
    pairs.push({ ctx, note });
    ctx = note.branch;
  }
  return pairs;
}

/** True when the melody from this context down is a strict chain — playback is verbatim
    (in order, looping), so seeded re-ordering doesn't apply. For the UI. */
export function isChain(node: MelodyNode): boolean {
  return chainPairs(node) !== null;
}

/** Emit a strict chain VERBATIM: the run plays front to back, loops again while another
    full pass fits, and leaves the remainder silent — never a mid-run cut, so a recorded
    take loops cleanly with nothing added. (A budget smaller than one pass still
    truncates the pass, matching the walk's fill behaviour.) */
function emitChain(pairs: { ctx: MelodyNode; note: MelodyNote }[], limitSteps: number): EmittedNote[] {
  const out: EmittedNote[] = [];
  let left = limitSteps;
  let passSteps = 0;
  for (const { note } of pairs) {
    passSteps += Math.max(0, Math.round(note.restSteps)) + Math.max(1, Math.round(note.lengthSteps));
  }
  do {
    for (const { ctx, note } of pairs) {
      const hz = degreeHz(note.degree, ctx.root, ctx.scale, ctx.octave);
      const rest = Math.max(0, Math.round(note.restSteps));
      const len = Math.max(1, Math.round(note.lengthSteps));
      if (rest + len > left) {
        // Doesn't fit whole: rest first, then fill whatever's left with the note.
        const r = Math.min(rest, left);
        left -= r;
        out.push({ hz, lengthSteps: left, restSteps: r });
        return out;
      }
      out.push({ hz, lengthSteps: len, restSteps: rest });
      left -= rest + len;
    }
  } while (left >= passSteps);
  return out;
}

/** Generate the melody's note stream for a track `barLimit` long (returns [] if empty). */
export function generateMelody(melody: MelodyNode, barLimit: number): EmittedNote[] {
  const limitSteps = Math.max(1, Math.round(barLimit)) * STEPS_PER_BAR;
  if (melody.notes.length === 0) return [];
  // A strict chain (e.g. a recorded take applied "in my order") plays verbatim — in
  // order, looping, nothing added — no seeded walk at all.
  const chain = chainPairs(melody);
  if (chain) return emitChain(chain, limitSteps);
  const rng = rng01(melody.seed);
  const out: EmittedNote[] = [];
  const budget = { left: limitSteps };
  // Loop the walk until the track is full (a shallow melody just repeats to fill).
  let guard = 0;
  while (budget.left > 0 && guard++ < 2000) walk(melody, rng, out, budget, 0);
  return out;
}

/** Re-time a generated phrase onto the instrument's Euclidean RHYTHM (its
    hits/steps/rotation/split — the same circles a voice loop has). The pattern cycles
    across the phrase; each pattern onset takes the NEXT note of the stream (in order,
    wrapping if the rhythm wants more notes than the walk emitted) and holds it until the
    following onset — the notes' own lengths/rests are ignored, so the Euclid groove IS
    the phrase's timing. Off (`inst.rhythm` unset, or a degenerate pattern) = the phrase
    unchanged. Returns [] when the pattern never fires. */
export function regatePhrase(phrase: EmittedNote[], inst: Loop, phraseSteps: number): EmittedNote[] {
  if (!inst.rhythm || inst.steps < 1 || inst.hits < 1 || phrase.length === 0) return phrase;
  const pat = voicePattern(inst.hits, inst.steps, inst.rotation, inst.split);
  const onsets: number[] = [];
  for (let i = 0; i < Math.max(1, Math.round(phraseSteps)); i++) if (pat[i % inst.steps]) onsets.push(i);
  if (!onsets.length) return [];
  const out: EmittedNote[] = [];
  for (let k = 0; k < onsets.length; k++) {
    const start = onsets[k];
    const end = k + 1 < onsets.length ? onsets[k + 1] : Math.round(phraseSteps);
    out.push({ hz: phrase[k % phrase.length].hz, lengthSteps: end - start, restSteps: k === 0 ? start : 0 });
  }
  return out;
}

/** A single-hit sounding node for one melody note: the instrument's sound, one hit at the
    node start, its window `lengthSteps` long, tuned to `hz`. Exported so the track can lay
    a generated phrase (see melodyLanes) into a lane. */
export function melodyNoteNode(inst: Loop, lengthSteps: number, hz: number): VoiceNode {
  const n = emptyNode();
  n.soundId = inst.soundId;
  n.snapshot = inst.snapshot.slice();
  n.color = inst.color;
  n.name = inst.name;
  n.pitch = [inst.pitch[0], inst.pitch[1]];
  n.gain = inst.gain;
  n.preset = inst.preset;
  n.steps = Math.max(1, Math.round(lengthSteps));
  n.hits = 1;      // one hit, at step 0 (the note attack); the sound rings its own tail
  n.rotation = 0;
  n.reps = 1;
  n.pitchHz = hz;
  return n;
}
