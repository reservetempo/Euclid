// Euclidean rhythm generation. Spreads `hits` triggers as evenly as possible across
// `steps` positions (a Bresenham spread with the downbeat ON step 0), then rotates so
// the pattern starts at `rotation`. Used by every node of the voice lines
// (see lines.ts VoiceNode).

export const EUCLID_VOICES = 6;     // voice lines / rings (one per logo letter)
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
  return rotatePattern(out, rotation);
}

/** Rotate a boolean pattern so it begins `rotation` steps in (wraps, both directions). */
function rotatePattern(pattern: boolean[], rotation: number): boolean[] {
  const n = pattern.length;
  const rot = ((Math.round(rotation) % n) + n) % n;
  if (rot === 0) return pattern;
  const out = new Array<boolean>(n);
  for (let i = 0; i < n; i++) out[i] = pattern[(i + rot) % n];
  return out;
}

/** The even ("neutral") primary gap for `hits` over `steps`: the repeated smaller gap of
    the even Euclidean spread, and the default value shown by the per-voice Split control. */
export function evenGap(hits: number, steps: number): number {
  const n = clampSteps(steps);
  const k = Math.max(0, Math.min(n, Math.round(hits)));
  return k < 1 ? 0 : Math.floor(n / k);
}

/** Largest primary gap that still leaves the final (remainder) gap >= 1 step. */
export function maxSplitGap(hits: number, steps: number): number {
  const n = clampSteps(steps);
  const k = Math.max(0, Math.min(n, Math.round(hits)));
  return k < 2 ? n : Math.floor((n - 1) / (k - 1));
}

/** A boolean pattern using an explicit primary gap: the first `hits-1` gaps are `gap`
    steps each and the final gap takes the remainder, then rotate by `rotation`. Lets a
    voice try uneven splits (3 hits / 16 steps as 6-6-4 or 7-7-2 instead of 5-5-6). */
export function splitPattern(hits: number, steps: number, gap: number, rotation: number): boolean[] {
  const n = clampSteps(steps);
  const k = Math.max(0, Math.min(n, Math.round(hits)));
  const out = new Array<boolean>(n).fill(false);
  if (k <= 0) return out;
  if (k === 1) { out[0] = true; return rotatePattern(out, rotation); }
  const g = Math.max(1, Math.min(maxSplitGap(k, n), Math.round(gap)));
  let pos = 0;
  for (let h = 0; h < k; h++) { out[pos] = true; pos += g; } // final wrap = remainder gap
  return rotatePattern(out, rotation);
}

/** The pattern for a voice: the even Euclidean spread by default, or a custom split when
    the voice carries a `split` primary-gap override. Used by the engine + circle view. */
export function voicePattern(hits: number, steps: number, rotation: number, split?: number): boolean[] {
  return split === undefined
    ? euclidPattern(hits, steps, rotation)
    : splitPattern(hits, steps, split, rotation);
}
