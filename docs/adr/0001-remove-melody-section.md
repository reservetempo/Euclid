# Remove the melody section, keep the sing-to-notes model

Euclid shipped a nodal melody sequencer on the sixth coloured row: a tree of scale
contexts with weighted notes, a seeded walk that emitted a phrase, a graph calculator that
drew notes as `y = f(x)`, and a Sing tab that pitch-tracked the microphone into notes. It
was off-concept for a drum machine and it accounted for roughly a quarter of `app.ts`, so
it was deleted (2026-07-29). Row 5 became an ordinary loop voice, which keeps the
six-way correspondence between logo letters, rings, and voices intact.

## Consequences

Two deliberate orphans exist because of this decision. **Neither is dead code to be swept
up** — both are the seam a future "record a sung phrase and play it back" feature starts
from, which is the one part of melody worth keeping.

- **`src/model/sing.ts` has no importers.** It holds the autocorrelation pitch detector,
  the note segmenter, and `quantizeTake`. It is DOM-free and tree-shakes out of the bundle,
  so keeping it costs nothing but a rewrite it saves is expensive. Its `MelodyNote`
  dependency was replaced with a local `QuantizedNote`. The mic plumbing (getUserMedia +
  the rAF loop + the tuner UI) was *not* kept — it was UI, and it will be rewritten against
  whatever surface a take eventually lands on.
- **`VoiceNode.pitchHz` is never set.** The engine still honours it: `pitchedSnap()` in
  `public/worklet/engine.js` re-tunes a sound's snapshot when a node carries a pitch. That
  is precisely what playing back a sung phrase needs, and `engine.js` is hand-written DSP
  that no tooling edits, so the seam was left alone rather than deleted and re-derived.

Three things went with the melody UI that were not melody features, because the melody
list panel turned out to be the only place they were mounted (the voice colour panel had
dropped its sub-tabs earlier). This was chosen knowingly, in favour of keeping the change a
pure deletion:

- the **row-sweep editor** — `RowSweep` still compiles, saves, and plays, but nothing can
  author one any more;
- the **compact per-loop shuffle menu** (`ui/voiceShuffleMenu.ts`, deleted) and the
  swipe-to-report gesture — loops are edited through the Sound Graph instead, and the
  reports log is still reachable from the menu;
- the **intro/outro fade editor** — its rep-based branch for ordinary loops was already
  unreachable before this change; per-loop transitions (the Transitions tab) are unaffected.

The save format stayed at **version 14**. Nothing about the snapshot layout moved, so an
existing file still loads its loops, kit, and tempo; only its `melodies` array is ignored.
