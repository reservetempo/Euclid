# Collapse the drum kit into the sound draft, and break the save format doing it

Euclid's sound editing was built on a `DrumKit`: a map of `DrumType` → `DrumParameters`
plus a parallel map of per-drum undo stacks. That shape made sense when a drum had a
character — per-drum parameter ranges, a preset per slot. Both went (see "Remove the preset
system", 31ce300), and what was left keyed nothing: `getParamSpec(_drum, id)` ignored its
first argument, every editing surface opened `new DrumKit([REF_DRUM])` and immediately
called `.get(REF_DRUM)`, and `App.kit` — a kit over all eight `DRUMS` — existed only so
`serialize` kept writing a `drums` blob that no surface ever read back.

That is now one module, `src/model/sound.ts`, exporting `SoundDraft`: one snapshot, one
undo stack, the shuffle settings, a `rev` counter. `DrumType`, `DrumDef`, `DRUMS`,
`DrumKit`, `DrumParameters`, `REF_DRUM`, `getParamSpec` and `defaultSnapshot` are gone
(2026-07-30).

## The draft writes through

A `SoundDraft` is constructed **over** the array the model already holds — `loop.snapshot`,
or a transition's — and mutates it in place. Before, the kit held a copy and every edit
ended in `loop.snapshot = p.capture()`; the two could only ever be as consistent as the
call sites remembered to be.

Two consequences worth knowing:

- **The array's identity never changes.** `App.normalizeLoop` renders a hit offline to
  measure its loudness and used to guard the result with `loop.snapshot !== token` — under
  write-through that comparison is always false, and a stale gain would be stored silently.
  It compares `draft.rev` instead, which is bumped by every `set`.
- **A draft must never be copied.** `cloneLoop` lists a transition's fields explicitly
  rather than spreading it, because a spread would hand the copy a draft still writing
  through to the *original's* snapshot — editing the copy would edit both. The same listing
  keeps drafts out of the save file.

A draft lives on its loop and dies with it, which retired two identity-keyed side maps
(`voiceEditors`, `transitionKits`) and the five places that had to remember to evict them.

## The save format went to v15, and refuses v14

Three fields lost their last reader and left the format: `drums`, `soundName` (that kit's
name, never displayed), and `Loop.pitch` — always the base `Pitch` range, a constant, which
rode into `EngineSound.lo`/`hi` and, since the melody section went, was stored in the
engine's sound table and never read. The engine still receives `lo`/`hi`; `EngineHost`
fills them from `baseRange(Pitch)` at the wire, so `engine.js` is untouched and the pitch
range half of the seam ADR-0001 parked is still there for a sung phrase to use.

**No parameter index moved**, so a v14 file was still readable and the reader could have
accepted it for one release. It refuses it instead: a clean break, chosen knowingly, with
the cost understood — every autosave and every `.json` saved before this commit opens blank
with only its tempo restored. The alternative was carrying a second accepted version and
the "which fields might be absent" branch that comes with it, through a format that has
never promised compatibility across generations.

If a future change is in the same position — a field removal, nothing re-indexed — the
policy is still a bump, and accepting the previous version for a release is a legitimate
choice this ADR does not foreclose. What is not legitimate is silently changing what the
current version number means.
