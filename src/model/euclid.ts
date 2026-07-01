// Euclidean rhythm generation. Spreads `hits` triggers as evenly as possible across
// `steps` positions (a Bresenham spread with the downbeat ON step 0), then rotates so
// the pattern starts at `rotation`. Used by the per-grid Euclidean sequencer mode
// (see MelodyGrid.voices).

export const EUCLID_VOICES = 5;     // circles / voice slots per Euclidean grid
export const MAX_STEPS = 64;        // upper bound on a voice's step count

// New voices start blank — every value is 0, so a freshly assigned circle is silent
// until the user dials in hits/steps/start. (steps 0 means the engine skips the voice.)
export interface VoiceDefault { hits: number; steps: number; rotation: number; }
export const VOICE_DEFAULT: VoiceDefault = { hits: 0, steps: 0, rotation: 0 };

export function clampSteps(n: number): number {
  return Math.max(1, Math.min(MAX_STEPS, Math.round(n) || 1));
}

/** A boolean hit/rest array of length `steps` with `hits` evenly spread, rotated so the
    pattern begins at `rotation` steps in. */
export function euclidPattern(hits: number, steps: number, rotation: number): boolean[] {
  const n = clampSteps(steps);
  const k = Math.max(0, Math.min(n, Math.round(hits)));
  // Even Bresenham spread with the downbeat on step 0: step i is a hit when (i*k) mod n
  // falls in the first `k` of the cycle. Step 0 is always a hit when k>0, so the rhythm's
  // start sits at 12 o'clock in the circle view (`start`/rotation rotates from there).
  const out = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) out[i] = (i * k) % n < k;
  const rot = ((Math.round(rotation) % n) + n) % n;
  if (rot === 0) return out;
  const rotated = new Array<boolean>(n);
  for (let i = 0; i < n; i++) rotated[i] = out[(i + rot) % n];
  return rotated;
}
