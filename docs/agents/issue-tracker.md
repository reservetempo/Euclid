# Issue tracker: local Markdown

Issues and PRDs for this repo live as **Markdown files in `docs/issues/`**, committed
alongside the code. There is no external tracker and no `gh` dependency — the tracker is
just files, so it works offline, reviews in the same diff as the change it describes, and
travels with a clone.

The directory is created lazily: the first `create` makes `docs/issues/`.

## Layout

One file per issue, named `<number>-<slug>.md` with a zero-padded 4-digit number:

```
docs/issues/
  0001-lfo-trace-shows-active-when-routed-to-none.md
  0002-selectable-contour-shapes.md
```

Each file is YAML frontmatter + a Markdown body:

```markdown
---
id: 2
title: Add selectable contour shapes to pitch and layer envelopes
state: open          # open | closed
labels: [ready-for-agent]
created: 2026-07-24  # ISO date, always absolute
closed:              # ISO date, set when state flips to closed
---

The pitch sweep is locked to a single hard-coded exponential, so it can only be flat or
one monotonic drop.

## Comments

### 2026-07-25

Confirmed the Tone and Noise layer decays have the same limitation.
```

Rules that keep the format machine-readable:

- **`id` is permanent.** It matches the filename's number and never changes, even if the
  title (and therefore the slug) is edited. Renaming the file to match a new slug is fine.
- **Numbers are never reused**, including by closed or deleted issues.
- **`labels` is a flat YAML list** of the strings in `triage-labels.md`.
- **Dates are absolute ISO dates**, never "yesterday" or "last week".
- **Comments are appended**, newest last, each under an `### <ISO date>` heading. Never
  rewrite an existing comment — add a new one.
- **Cross-references use `#<id>`** (e.g. `Blocked by: #4`), matching how the commit log
  already refers to work.

## Conventions

- **Create an issue**: pick the next number — one above the highest existing `id`
  (`ls docs/issues/`; on an empty/missing directory, start at `0001`) — then write
  `docs/issues/<number>-<slug>.md` with the frontmatter above, `state: open` and today's
  date. Slug = the title, lowercased, non-alphanumerics collapsed to `-`.
- **Read an issue**: read `docs/issues/<number>-*.md` — the body and its comments are the
  whole record, so there is nothing else to fetch.
- **List issues**: glob `docs/issues/*.md` and read each file's frontmatter. Filter on the
  `state` and `labels` fields. Sort by `id` unless a skill asks otherwise.
- **Comment on an issue**: append an `### <today>` block under `## Comments` (adding the
  `## Comments` heading if the file doesn't have one yet).
- **Apply / remove labels**: edit the `labels:` list in the frontmatter.
- **Close**: set `state: closed`, set `closed:` to today's date, and append a closing
  comment saying why.
- **Reopen**: set `state: open` and clear `closed:`.

Issue files are ordinary repo content — commit them with the work they describe, so an
issue and its fix land in the same history.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(`/triage` reads this flag.)_

The tracker is local files, so a PR can't be one of its tickets. If a PR should be tracked,
open an issue for it and link the PR URL from the issue body.

## When a skill says "publish to the issue tracker"

Create a file in `docs/issues/` as described under **Create an issue**.

## When a skill says "fetch the relevant ticket"

Read `docs/issues/<number>-*.md`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is one issue; its **children** are ordinary issues that
point back at it.

- **Map**: an issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog
  body, plus a `## Tickets` task list of its children in the order they should be taken:
  `- [ ] #7 Measure the worklet's per-sample cost`.
- **Child ticket**: an ordinary issue with `Part of: #<map>` as the first body line and a
  `wayfinder:<type>` label (`research` / `prototype` / `grilling` / `task`). Add it to the
  map's task list when created; tick the box when it closes.
- **Blocking**: a `Blocked by: #<id>, #<id>` line directly under `Part of:`. A ticket is
  unblocked when every listed blocker has `state: closed`.
- **Claim**: add an `assignee: <name>` key to the child's frontmatter. This is the
  session's first write, so it also marks the ticket as taken.
- **Frontier query**: read the map's task list in order; keep children that are `open`,
  have no `assignee`, and whose every `Blocked by` id is closed. First one wins.
- **Resolve**: append the answer as a comment, close the issue, tick its box in the map's
  task list, then add a pointer to it (`#<id>`) under the map's Decisions-so-far.
