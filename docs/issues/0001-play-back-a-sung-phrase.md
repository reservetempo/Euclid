---
id: 1
title: Play back a sung phrase
state: open
labels: [needs-triage]
created: 2026-07-29
closed:
---

Singing a phrase into the app and having it play back is the one part of the deleted melody
section worth keeping (see `docs/adr/0001-remove-melody-section.md`). The model half is
already written and parked; the feature is the surface around it.

What exists today:

- `src/model/sing.ts` — pitch detector, note segmenter, and `quantizeTake()` which snaps a
  finished take onto a scale + tempo as `QuantizedNote`s, in sung order. Nothing imports it.
- `VoiceNode.pitchHz` + `pitchedSnap()` in `public/worklet/engine.js` — give a node an
  absolute pitch and the engine re-tunes that sound's snapshot to it. Nothing sets it.

What's missing, and what needs deciding:

- **Where a take lives.** It isn't a loop (loops are a rhythm + a placement rule, one
  sound at one pitch). Does a take become a new kind of thing on a voice row, or its own
  surface?
- **Mic plumbing.** getUserMedia + an analyser tap + an rAF loop + a live tuner read-out.
  Deleted with the old Sing tab on purpose; it was ~80 lines of standard UI code and it
  should be written against whatever the answer to the previous question is.
- **A key to snap against.** `track.root` / `track.scale` exist and feed the shuffle's
  "Key" pitch-snap, but no UI has ever set them, so a key means C Major everywhere. A take
  needs a real key picker, which would fix the Key snap mode at the same time.
- **Placement.** A phrase has its own length in bars; how it repeats across the track is
  the same question loops answer with a placement rule.
