// Post-shuffle loudness normalization: render ONE hit of a sound offline, measure
// how loud it actually comes out, and derive a makeup gain that lands every
// generated sound at a consistent perceived level. This is the closed loop behind
// the open-loop shuffle guards in drumKit.ts — those keep the TIMBRE sane; this
// fixes the LEVEL, whatever the parameter stack did to it.
//
// Loudness = the loudest 50ms RMS window of the mono mix, taken together with a
// first-difference companion (≈ +6dB/oct tilt) so shrill high-frequency content
// measures LOUDER than its plain RMS — screechy results get pulled down harder,
// while bassy thumps are judged by their body.

// Calibrated against the measured spread of real shuffles (~0.07–0.9 max-window
// RMS, a ~22dB swing): the target sits at the observed median so typical sounds
// keep their level and only the outliers move.
export const LOUDNESS_TARGET = 0.4; // target max-window RMS at Volume = 1
export const GAIN_MIN = 0.3;        // trim cap (~-10dB) for the screamers
export const GAIN_MAX = 4;          // boost cap (~+12dB) for the whispers
const WINDOW_SEC = 0.05;             // RMS window length
const HF_WEIGHT = 2.5;               // weight of the first-difference (treble) RMS
const SILENCE = 1e-3;                // below this the render is broken, not quiet

/** The loudest HF-weighted RMS window of the buffer's mono mix. */
export function measureLoudness(buf: AudioBuffer): number {
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const n = L.length;
  const win = Math.max(1, Math.round(buf.sampleRate * WINDOW_SEC));
  let best = 0;
  for (let start = 0; start + win <= n; start += win >> 1) { // 50% hop
    let sum = 0;
    let sumHF = 0;
    let prev = 0.5 * (L[start] + R[start]);
    for (let i = start; i < start + win; i++) {
      const m = 0.5 * (L[i] + R[i]);
      const d = m - prev;
      prev = m;
      sum += m * m;
      sumHF += d * d;
    }
    const loud = Math.max(Math.sqrt(sum / win), HF_WEIGHT * Math.sqrt(sumHF / win));
    if (loud > best) best = loud;
  }
  return best;
}

/** Makeup gain for a measured loudness (at Volume = 1): pull the sound toward the
    target, clamped so the correction stays a trim. An essentially-silent render
    returns 1 — something else is wrong; boosting the noise floor helps nobody. */
export function makeupGain(measured: number): number {
  if (!(measured > SILENCE)) return 1;
  return Math.min(GAIN_MAX, Math.max(GAIN_MIN, LOUDNESS_TARGET / measured));
}
