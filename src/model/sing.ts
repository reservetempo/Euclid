// SING-TO-NOTES: live microphone pitch tracking. Analyser frames run through a bounded
// autocorrelation pitch detector; a SingTracker segments the per-frame pitch stream into
// discrete sung notes (median midi + start/end times); and quantizeTake snaps a finished
// take onto a scale and the track tempo — in the exact order it was sung.
//
// PARKED, ON PURPOSE. Nothing imports this file. It was the Sing tab of the melody
// section, which was removed (see docs/adr/0001-remove-melody-section.md); the pitch
// detector and the segmenter are the expensive, DOM-free half and are kept verbatim for
// a future feature that plays a sung phrase back. Do NOT delete it as dead code — its
// absence of callers is the documented state, not an oversight. The mic plumbing
// (getUserMedia + the rAF loop) was NOT kept: it was UI, and it will be rewritten
// against whatever surface the take eventually lands on.

import { degreesPerOctave, semitoneForDegree, ALL_ROOTS, ROOT_MIDI } from "./melodyScale";

// The singing range the detector listens for (low bass to high soprano).
const MIN_HZ = 70;
const MAX_HZ = 1000;

/** Detected fundamental of one time-domain frame, or null when silent/unvoiced.
    Normalized autocorrelation over the vocal lag range only (cheap enough for a rAF
    loop), taking the earliest peak within 90% of the global one (guards against
    octave-down errors), refined by parabolic interpolation. */
export function detectPitchHz(buf: Float32Array, sampleRate: number): number | null {
  const n = buf.length;
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += buf[i] * buf[i];
  if (Math.sqrt(e0 / n) < 0.01) return null; // silence gate

  const minLag = Math.floor(sampleRate / MAX_HZ);
  const maxLag = Math.min(n - 2, Math.ceil(sampleRate / MIN_HZ));
  if (maxLag <= minLag + 1) return null;

  const c = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0, m = n - lag; i < m; i++) s += buf[i] * buf[i + lag];
    c[lag] = s / (n - lag); // normalize so long lags aren't tapered away
  }
  let peak = 0;
  for (let lag = minLag; lag <= maxLag; lag++) if (c[lag] > peak) peak = c[lag];
  if (peak < 0.5 * (e0 / n)) return null; // no clear periodicity → unvoiced (breath, noise)

  let best = -1;
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    if (c[lag] >= c[lag - 1] && c[lag] >= c[lag + 1] && c[lag] >= 0.9 * peak) { best = lag; break; }
  }
  if (best < 0) return null;
  const a = c[best - 1], b = c[best], d = c[best + 1];
  const den = a - 2 * b + d;
  const lag = best + (den ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - d)) / den)) : 0);
  const hz = sampleRate / lag;
  return hz >= MIN_HZ && hz <= MAX_HZ ? hz : null;
}

/** One sung note: `midi` is the segment's median pitch, kept fractional — mapping onto
    a scale degree happens later, against the whole take. */
export interface SungNote {
  midi: number;
  startMs: number;
  endMs: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** Segments a per-frame pitch stream into discrete sung notes: a note opens when a
    pitch appears, splits when the pitch moves ≥ ~0.7 semitone and STAYS there (legato
    note changes; brief vibrato/scoops are skipped), and closes after a short silence.
    Blips under ~90ms are dropped. Feed `push` every frame; `finish` returns the take. */
export class SingTracker {
  readonly done: SungNote[] = [];
  liveMidi: number | null = null; // current frame's pitch, for the tuner readout
  private seg: { startMs: number; lastMs: number; midis: number[] } | null = null;
  private drift: { sinceMs: number; midi: number } | null = null;
  private silenceSinceMs = -1;

  push(hz: number | null, tMs: number): void {
    if (hz === null) {
      this.liveMidi = null;
      this.drift = null;
      if (this.seg) {
        if (this.silenceSinceMs < 0) this.silenceSinceMs = tMs;
        else if (tMs - this.silenceSinceMs > 140) this.close();
      }
      return;
    }
    const midi = 69 + 12 * Math.log2(hz / 440);
    this.liveMidi = midi;
    this.silenceSinceMs = -1;
    if (!this.seg) {
      this.seg = { startMs: tMs, lastMs: tMs, midis: [midi] };
      return;
    }
    if (Math.abs(midi - median(this.seg.midis)) > 0.7) {
      // Off the note. Track where the pitch has settled; once it holds ~55ms it's a
      // new note (split there) — until then it's treated as a passing wobble.
      if (!this.drift || Math.abs(midi - this.drift.midi) > 0.7) this.drift = { sinceMs: tMs, midi };
      if (tMs - this.drift.sinceMs >= 55) {
        const cut = this.drift.sinceMs;
        this.close(cut);
        this.seg = { startMs: cut, lastMs: tMs, midis: [midi] };
        this.drift = null;
      }
      return;
    }
    this.drift = null;
    this.seg.midis.push(midi);
    this.seg.lastMs = tMs;
  }

  /** Stop tracking: close any open note and return the take (in sung order). */
  finish(): SungNote[] {
    this.close();
    return this.done;
  }

  private close(endMs?: number): void {
    const s = this.seg;
    this.seg = null;
    this.silenceSinceMs = -1;
    if (!s) return;
    const end = endMs ?? s.lastMs;
    if (end - s.startMs < 90 || s.midis.length < 3) return; // a blip, not a note
    this.done.push({ midi: median(s.midis), startMs: s.startMs, endMs: end });
  }
}

/** "E4"-style label for a (possibly fractional) midi pitch. */
export function midiName(midi: number): string {
  const m = Math.round(midi);
  return `${ALL_ROOTS[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/** One note of a quantized take: a scale degree with a sounding length and a pre-rest,
    both in 16th-note steps. Its own type rather than a sequencer type — nothing consumes
    a take yet, so a future feature starts from this shape rather than inheriting the
    dead melody model's. */
export interface QuantizedNote {
  degree: number;      // scale-degree index (0 = the context's root)
  lengthSteps: number; // sounding length, in 16th-note steps
  restSteps: number;   // silent steps before the note; 0 = none
}

/** Quantize a finished take onto a scale context: each sung note snaps to the nearest
    degree of `scale`/`root`/`octave` (the whole take first auto-shifts by octaves to
    best fit a two-octave degree span) and its length/pre-rest quantize to 16th steps at
    `bpm`. Returns the notes in the sung order. */
export function quantizeTake(
  sung: SungNote[], bpm: number, scale: number, root: number, octave: number,
): QuantizedNote[] {
  if (sung.length === 0) return [];
  const maxDeg = degreesPerOctave(scale) * 2; // match the note grid's span
  const base = ROOT_MIDI + root + 12 * octave; // midi of degree 0
  const desired = sung.map((s) => s.midi - base);

  // Auto octave fit: shift the whole take by whole octaves so it lands in [0, 24]
  // semitones above the root (ties prefer no shift) — sing wherever is comfortable.
  let bestK = 0, bestCost = Infinity;
  for (let k = -36; k <= 36; k += 12) {
    let cost = Math.abs(k) * 0.01;
    for (const d of desired) {
      const v = d + k;
      cost += Math.max(0, -v) + Math.max(0, v - 24);
    }
    if (cost < bestCost) { bestCost = cost; bestK = k; }
  }

  const stepMs = 60000 / Math.max(1, bpm) / 4;
  const out: QuantizedNote[] = [];
  let prevEnd = -1;
  for (let i = 0; i < sung.length; i++) {
    const target = desired[i] + bestK;
    let deg = 0, err = Infinity;
    for (let d = 0; d <= maxDeg; d++) {
      const e = Math.abs(semitoneForDegree(d, scale) - target);
      if (e < err - 1e-6) { err = e; deg = d; }
    }
    const len = Math.max(1, Math.min(32, Math.round((sung[i].endMs - sung[i].startMs) / stepMs)));
    // The first note starts the phrase (lead-in breath isn't a rest).
    const rest = prevEnd < 0 ? 0 : Math.max(0, Math.min(32, Math.round((sung[i].startMs - prevEnd) / stepMs)));
    prevEnd = sung[i].endMs;
    out.push({ degree: deg, lengthSteps: len, restSteps: rest });
  }
  return out;
}
