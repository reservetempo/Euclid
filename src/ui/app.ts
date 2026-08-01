// App shell: owns the engine + the procedural TRACK + UI state, and switches between
// the full-screen views. Placement is procedural (see src/model/track.ts): the track is
// six COLOURS, each an ordered list of LOOPS carrying a placement rule. `recompile()`
// turns the track into engine LANES (node chains, see src/model/lines.ts) which the
// engine, WAV export and rings all run on.
//
//   Track view (landing) — the six colours + the whole-track bar limit; the rings above
//     visualise what's sounding. Tap a colour to open its panel.
//   Colour view — full-screen list of that colour's loops; add a loop, reorder solo
//     priority, tap a loop to open its placement popup.
//   Placement popup — the loop's rule (Repeat every / For n bars / overlap-solo), its
//     rhythm circles, and the shuffle menu for its sound.
//   Mixer — one strip per colour (mute/solo/faders act on the whole colour).
//   Sound view — the deep per-parameter editor for one loop's sound.

import { EngineHost, EngineSound, Playhead } from "../audio/engineHost";
import { measureLoudness, makeupGain } from "../audio/loudness";
import { encodeWavFromBuffer } from "../audio/wav";
import {
  ParamId, RealParamId, NUM_PARAMS, PITCH_DRAW_BASE, PITCH_DRAW_SLOTS,
  getParamGroup, getParamGroupName,
} from "../model/params";
import {
  baseSpec, isDiscrete, formatValue, valueToNorm, normToValue, ParamSpec, PITCH_SHAPE_DRAWN,
} from "../model/paramSpec";
import {
  SOUND_TRACES, TraceSpec, TraceCtx, ParamGet, traceAxisSeconds, snapshotAxisSeconds,
  traceDomain, traceParts, hzToNorm, normToHz,
} from "../model/soundTraces";
import { openDrawOverlay } from "./drawOverlay";
import { openPathOverlay } from "./pathOverlay";
import { SoundDraft, estimateLength, randomSeed } from "../model/sound";
import { serialize, deserialize, ProjectJSON } from "../model/project";
import { reportCount, exportReports, clearReports } from "../model/soundReports";
import {
  LineArrangement, STEPS_PER_BAR, NUM_LINES, VOICE_COLORS, PUSH_UNIT, MAX_PUSH, PUSH_STEPS_PER_BAR,
  BLEND_SHAPES, blendShapeSpec, blendShape, blendShapeY, SweepWindow,
} from "../model/lines";
import { fitBlendShape, DRAWN_POINTS } from "../model/curveFit";
import {
  Track, Loop, LoopTransition, emptyLoop, cloneLoop, loopToNode,
  randomSeed as newSeed, ruleLengths, defaultLoopTransition,
  placementsFor,
} from "../model/track";
import { reverseSnapshot } from "../model/reverse";
import { generateName, reshuffleNames } from "../model/name";
import { clampSteps, MAX_STEPS, evenGap, maxSplitGap, voicePattern } from "../model/euclid";
import { helpButton, HelpItem } from "./soundHelp";
import {
  MAXLEN_OPTIONS, CURVE_OPTIONS, curveOptionIndex, maxLenOptionIndex,
} from "./controls";

// Storage key kept from the app's working title so existing saves keep loading.
const PROJECT_KEY = "msq010.project";

// Default "Max len" (the shuffle's audible-length cap) per voice row, in SECONDS. Every
// row defaults to 0 = off (no trimming) — a shuffled sound keeps its full length unless
// the user picks a Max len in the sound-graph toolbar.
const ROW_MAXLEN_SEC = [0, 0, 0, 0, 0, 0];

// The track overview draws each colour as a column of this many blocks, ALWAYS — a block
// covers barLimit/OVERVIEW_BLOCKS bars, so the whole track fits one screenful at any
// length (and at the 256-bar default a block is exactly 16 bars).
const OVERVIEW_BLOCKS = 16;

// The lightest a loop's shade goes in the overview / picker ramp: loop 1 is the base
// colour, each later loop a step lighter, capped so the last one stays legible.
const LOOP_SHADE_CAP = 0.9;
const LOOP_SHADE_STEP = 0.16;

type View = "track" | "grid" | "mixer";

// The loop editor's two pages. The sound page carries the whole loop (rhythm above the
// graph, the action buttons below it); Transitions is the one page that takes the sheet
// for itself.
type PlacementTab = "sound" | "transition";

// The editable numeric fields of a loop's rhythm (its scrubbable number circles).
type RhythmField = "hits" | "steps" | "rotation" | "split" | "push";

// How the sound is READ. The graph draws each active setting as a function of time; the
// sheet lists every setting as a number; the deck opens ONE section at a time with every
// setting shown in full (a choice list as a list, a number as a bar). Same draft, same
// edits — a preference, not a mode, so it is App state rather than anything the model or
// the save format knows about.
type SoundLayout = "graph" | "sheet" | "deck";

/** Where the parameter sheet starts a new titled block, what to call it, and the word
    its rows may drop. The registry's own groups (getParamGroup) are the fallback, but
    they are too coarse to read down a narrow column: "Tone" alone is 32 rows, and the
    three LFOs plus the FX chain repeat the same short names ("Rate", "Amt", "Mix",
    "FB") with nothing but a heading to tell them apart. Each entry names the FIRST
    parameter of a block, so blocks are contiguous enum ranges in registry order.

    `strip` is what makes four columns fit: under a heading that already says PITCH,
    "Pitch Cycles" only has to say "Cycles". Dropping a redundant prefix beats
    abbreviating ("P Cycles") because nothing has to be learned or guessed — and a row
    whose whole name IS the prefix ("Pitch", "Tone", "Noise") keeps it, since that row
    is the block's own level or value rather than one of its settings. */
interface SheetBlock { title: string; strip?: string }
const SHEET_BLOCK_TITLES: Partial<Record<ParamId, SheetBlock>> = {
  [ParamId.Pitch]: { title: "Pitch", strip: "Pitch" },
  [ParamId.Waveform]: { title: "Tone", strip: "Tone" },
  [ParamId.NoiseLevel]: { title: "Noise", strip: "Noise" },
  [ParamId.OscModType]: { title: "Osc Mod", strip: "Mod" },
  [ParamId.Osc2Mix]: { title: "Osc 2" },
  [ParamId.Fold]: { title: "Shape" },
  [ParamId.WaveTable]: { title: "Wavetable" },
  [ParamId.ClickLevel]: { title: "Click", strip: "Click" },
  // Resonators is two unrelated instruments sharing a heading. Split, and each one's
  // rows lose its name AND its heading lights independently of the other.
  [ParamId.CombMix]: { title: "Comb", strip: "Comb" },
  [ParamId.ModalMix]: { title: "Modal", strip: "Modal" },
  [ParamId.Lfo1Target]: { title: "LFO 1" },
  [ParamId.Lfo2Target]: { title: "LFO 2" },
  [ParamId.Lfo3Target]: { title: "LFO 3" },
  [ParamId.ModFxType]: { title: "Mod FX" },
  [ParamId.EchoTime]: { title: "Echo", strip: "Echo" },
  [ParamId.ReverbSize]: { title: "Reverb", strip: "Verb" },
};

/** The handful of names a four-column phone layout cannot fit even after `strip` has
    taken the block's word off the front. Only the stragglers are listed: an abbreviation
    has to be learned, so it earns its place one row at a time rather than as a policy.
    The full name still shows on the numpad when the row is tapped. */
const SHEET_SHORT_NAMES: Record<string, string> = {
  Release: "Rel", "Att Shape": "Att Sh", "Dec Shape": "Dec Sh",
  Material: "Mat", Downsmpl: "Down", "Ping-Pong": "Ping",
  Humanize: "Human", "Hit Chance": "Chance", Ratchet: "Ratch", Volume: "Vol",
  "Mod FX": "Type", // the row under the MOD FX heading is its type
};

/** Drop a block's own word from a row name ("Echo Time" under ECHO reads "Time"). Never
    leaves a row nameless — a row whose whole name IS the word keeps it. */
function dropBlockWord(name: string, strip?: string): string {
  return strip && name !== strip && name.startsWith(strip + " ")
    ? name.slice(strip.length + 1)
    : name;
}

/** The sheet's row name: the block's word dropped, then whatever is still too long for a
    column abbreviated. The deck only takes the first half — it gives a setting a whole
    row of its own, so nothing there has to be shortened. */
function sheetRowName(name: string, strip?: string): string {
  const short = dropBlockWord(name, strip);
  return SHEET_SHORT_NAMES[short] ?? short;
}

/** The sheet's own value formatting: the registry's, but never more precision than the
    column can hold. formatValue picks its decimals from the param's RANGE, which gives
    an LFO at 27.11 Hz two decimals it does not need and cannot fit; here the decimals
    come from the value itself, so nothing is quoted wider than "-2.68 st". */
function sheetValue(s: ParamSpec, v: number): string {
  if (isDiscrete(s)) return formatValue(s, v);
  const mag = Math.abs(v);
  const dec = mag >= 100 ? 0 : mag >= 10 ? 1 : 2;
  return s.unit ? `${v.toFixed(dec)} ${s.unit}` : v.toFixed(dec);
}

/** Which trace decides whether a stretch of the sheet is doing anything, resolved once
    per parameter. The ranges are contiguous because ParamId is ordered by feature, and
    the PREDICATE is the graph's own (soundTraces): both layouts then agree on what
    "active" means, and only one place in the codebase knows that a comb at zero mix is
    off. A parameter with no entry is always part of the sound — the amp envelope, the
    filter, the pitch it plays at.

    Per-Hit Life is deliberately not mapped: its trace is active when accents OR ghosts
    OR ratchets are, which says nothing about any one of its rows. */
const SHEET_TRACE_OF: (TraceSpec | undefined)[] = (() => {
  const byId = new Map(SOUND_TRACES.map((t) => [t.id, t]));
  const map = new Array<TraceSpec | undefined>(NUM_PARAMS).fill(undefined);
  const set = (from: ParamId, to: ParamId, id: string) => {
    const t = byId.get(id);
    for (let i = from; i <= to; i++) map[i] = t;
  };
  set(ParamId.Pitch, ParamId.PitchEnvCycles, "pitch");
  set(ParamId.Waveform, ParamId.ToneEnvCycles, "tone");
  set(ParamId.NoiseLevel, ParamId.NoiseEnvCycles, "noise");
  set(ParamId.OscModType, ParamId.OscModAmount, "fm");
  set(ParamId.Osc2Mix, ParamId.Sync, "osc2");
  set(ParamId.Fold, ParamId.Fold, "fold");
  set(ParamId.Unison, ParamId.UnisonDetune, "unison");
  set(ParamId.FmFeedback, ParamId.FmFeedback, "fm"); // the FM operator's own feedback
  set(ParamId.WaveTable, ParamId.WavePosition, "wavetable");
  set(ParamId.ClickLevel, ParamId.ClickType, "click");
  set(ParamId.CombMix, ParamId.CombDecay, "comb");
  set(ParamId.ModalMix, ParamId.ModalDecay, "modal");
  set(ParamId.Lfo1Target, ParamId.Lfo1Sync, "lfo1");
  set(ParamId.Lfo2Target, ParamId.Lfo2Sync, "lfo2");
  set(ParamId.Lfo3Target, ParamId.Lfo3Sync, "lfo3");
  set(ParamId.Drive, ParamId.Drive, "drive");
  set(ParamId.Crush, ParamId.Downsample, "bitcrush");
  set(ParamId.ModFxType, ParamId.ModFxMix, "modfx");
  set(ParamId.EchoTime, ParamId.EchoPing, "echo");
  set(ParamId.ReverbSize, ParamId.ReverbMix, "reverb");
  set(ParamId.Volume, ParamId.Pan, "out");
  return map;
})();

/** The value at which a per-hit setting is doing NOTHING. Per-Hit Life is the one block
    with no trace to ask (its trace lights when accents OR ghosts OR ratchets do, which says
    nothing about any one row), so its rows have never had an activity test — yet each of
    them has an obvious idle value, and four of the five sit at it in an ordinary sound.
    Note Hit Chance's is its MAXIMUM: 1 means no hit is ever dropped.

    Deliberately not keyed on "is this a drone": these settings are not inert BECAUSE a note
    is held. Ratchet on a drone re-strikes and restarts the whole gate, and Hit Chance can
    drop the note entirely — dimming those on a held note would say "not sounding" about the
    most destructive controls on the screen. At their idle value it is simply true. */
const INERT_AT: Partial<Record<ParamId, number>> = {
  [ParamId.AccentAmount]: 0,
  [ParamId.Humanize]: 0,
  [ParamId.HitChance]: 1,
  [ParamId.Ratchet]: 0,
  [ParamId.ChokeGroup]: 0, // "Off"
};

/** Is this setting doing anything right now? A parameter with no trace of its own is
    normally part of the sound whatever its value (the amp envelope, the filter, the pitch
    it plays at); otherwise the graph's own predicate decides. Both flat layouts ask through
    here, so "on" means one thing across the whole app. */
function sectionRowActive(id: ParamId, get: ParamGet): boolean {
  const inert = INERT_AT[id];
  if (inert !== undefined) return get(id) !== inert;
  const trace = SHEET_TRACE_OF[id];
  return !trace || trace.active(get);
}

// How much one scrub tick moves a parameter on the sheet. The registry's own step is the
// EDIT granularity, which for a wide range is far too fine to drag across (Pitch steps in
// single hertz over 8 kHz — a screen-height drag would not clear the bass). So a range
// that would take more than SHEET_SCRUB_TICKS ticks to cross scrubs in coarser multiples
// of that step; the numpad is how you land on an exact value either way.
const SHEET_SCRUB_TICKS = 200;
function sheetStep(s: ParamSpec): number {
  if (isDiscrete(s)) return 1;
  const span = s.max - s.min;
  const step = s.step > 0 ? s.step : span / SHEET_SCRUB_TICKS;
  if (span / step <= SHEET_SCRUB_TICKS) return step;
  return Math.max(step, Math.round(span / SHEET_SCRUB_TICKS / step) * step);
}

/** The engine cut into readable sections, once, at module load. This is the SHEET's own
    splitting rule — start a section wherever {@link SHEET_BLOCK_TITLES} names one, and
    otherwise wherever the registry's grouping changes, so every parameter lands under a
    heading either way — lifted out because the deck needs the same cut for a different
    purpose: what the sheet stacks as titled blocks down four columns, the deck spreads
    across the bottom as one button each. One split, so the two layouts can never disagree
    about what "the Echo section" is.

    The 32 PitchDraw slots are the one omission, in both layouts: they are samples of a
    drawn curve rather than settings, and are authored in the path overlay. */
interface SheetSection { title: string; strip?: string; ids: RealParamId[] }
const SHEET_SECTIONS: SheetSection[] = (() => {
  const out: SheetSection[] = [];
  let group = -1;
  for (let i = 0; i < NUM_PARAMS; i++) {
    const id = i as ParamId;
    if (id >= ParamId.PitchDraw1) break;
    const named = SHEET_BLOCK_TITLES[id];
    const g = getParamGroup(id);
    if (named || g !== group || !out.length) {
      group = g;
      out.push({ title: named?.title ?? getParamGroupName(g), strip: named?.strip, ids: [] });
    }
    out[out.length - 1].ids.push(id as RealParamId);
  }
  return out;
})();

/** What a sound-graph panel edits: the kit + shuffle settings, and where edits land.
    Two hosts exist — a loop's OWN sound, and a transition's TRANSFORMED sound. */
interface SoundGraphHost {
  draft: SoundDraft;
  color: string;
  title: string;
  write: () => void;                   // push the kit into the model, live (per scrub tick)
  commitAudition: () => void;          // hear it, on scrub release / numpad commit
  replace: () => void | Promise<void>; // after 🎲 / ↩ / ↺ — may re-level; must rerender
  resetTitle: string;
  reset: () => void;                   // what ↺ restores (preset vs "no change")
  extraCorner?: HTMLElement[];         // host-specific corner buttons (the ⧉ copy)
  // The loop whose per-hit accent/ghost PLACEMENT the Life trace edits (see lifeRow). Set
  // for a loop's own sound only: a transition's transformed sound has no placement of its
  // own — it rides the loop's.
  lifeLoop?: Loop;
}

// The curve visualization evaluates the transition's blend FUNCTION via blendShape in
// lines.ts (shape/curve/dir/cycles) — the same evaluator the speed warp uses, mirroring
// shapeT in engine.js, so the graph shows exactly what the engine will play.

export class App {
  private engine = new EngineHost();
  private arr = new LineArrangement();       // COMPILED lanes (engine source of truth)
  private track = new Track();               // the authoring model
  private saveTimer = 0;

  private view: View = "track";
  private lastViewKey = "";             // view identity at the previous render (scroll-preserve guard)
  private openColor = 0;               // which voice the grid view is showing
  // Which loop of that voice the grid view is editing. An INDEX, not the loop itself:
  // loops are removed and reordered under it, so it's clamped on every render.
  private gridLoopIdx = 0;
  private editLoop: Loop | null = null; // loop whose placement popup is open
  private placementTab: PlacementTab = "sound"; // which sub-page of the loop popup
  // Bar-square grid: how many rows the user has added PAST the track's own end (the ± in
  // the grid's tool row). Extra rather than absolute, so changing what a square is worth
  // re-fits the grid to the track instead of holding it at a stale row count — at square =
  // 8 a 256-bar track is 4 rows, not 8.
  private placeGridExtraRows = 0;
  // The open Loop-tab pattern grid's step cells + step count, so the transport can light
  // the currently-sounding step while playing (cleared when the popup closes).
  private patternPlayCells: HTMLElement[] | null = null;
  private patternPlaySteps = 0;
  // Bar-square grids (loop placement / transition bars / the play range): how many bars
  // one square is worth (1 / 2 / 4 / 8), and the armed Start→End pick (start 0 = awaiting
  // the start square). The play range picks out a SECTION of the whole track rather than
  // individual bars, so it starts at 8 (64 bars a row — a 256-bar track in four rows).
  private gridSpan: Record<"place" | "trans" | "range", number> = { place: 2, trans: 2, range: 8 };
  private gridPick: { key: "place" | "trans" | "range"; start: number } | null = null;
  // The popup's view identity at the last rebuild — an unchanged key means an in-place
  // rebuild (a value scrub, a toggle), whose scroll position is preserved.
  private popupViewKey = "";
  // The SOUND GRAPH (the popup's Sound tab): the trace whose equation is open (null =
  // the coloured trace buttons) and which button page shows (0 = active settings;
  // later pages = the inactive ones).
  private graphTrace: string | null = null;
  // How the sound panel is read (graph / sheet / deck) — sticky across loops for the
  // session, as is the deck's open section (index into SHEET_SECTIONS): coming back to the
  // deck should land where you left it, the way the graph keeps its page.
  private soundLayout: SoundLayout = "graph";
  private deckSection = 0;
  private graphPage = 0;
  // Transition editor state: the open transition and its tabs. The editing state for a
  // transition's transformed sound is the draft on the transition itself (see
  // model/sound.ts), so there is no side map here any more.
  private editTransition: LoopTransition | null = null;
  private transTab: "bars" | "graph" | "effects" | "speed" = "graph";
  // Debounced looping preview of the transition being edited (offline render): hear the
  // whole TRANSITION over a loop of a chosen length, or just the transformed RESULT.
  private previewTimer = 0;
  private previewToken = 0;
  private transPreviewMode: "transition" | "result" = "transition";
  private transPreviewBars = 4;
  private playing = false;
  private tempo = 120;
  // Play-range loop region (1-indexed bars, inclusive); 0/0 = loop the whole track. A
  // transient playback aid (see applySection) — not saved with the project.
  private playFromBar = 0;
  private playToBar = 0;
  private nextSoundId = 0;             // monotonic id for loop sounds

  private mixerReturn: View = "track"; // where the mixer's Back returns to

  private root: HTMLElement;
  private viewRoot!: HTMLElement;
  private loopTimeEl: HTMLElement | null = null;
  private trackPlayheadEl: HTMLElement | null = null; // overview playback line
  // Measured vertical geometry of one column's overview blocks, relative to .track-cols —
  // what the playback line is positioned against and what a tap on a column reads. See
  // trackBlockBoxes(). Cleared on every track render; also re-measured when the container
  // height changes (there is no resize listener, and none is needed for this).
  private trackGeom: { h: number; boxes: { top: number; height: number }[] } | null = null;
  // Channel -> flash LED (mixer) and sound id -> loop-row button (colour panel).
  private mixerLeds: Map<number, HTMLElement> | null = null;
  private voiceBtns: Map<number, HTMLElement> | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.engine.onPlayhead = (p) => this.handlePlayhead(p);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.engine.resume();
    });
    // No start gate: boot straight into the app. The browser won't let audio run
    // until a user gesture, so the engine starts lazily on the FIRST interaction
    // anywhere (and the shuffle / graph-tap audition paths await it — see withAudio).
    this.loadFromStorage();
    // Compile before the first render: the track overview draws the COMPILED lanes, so
    // without this the app boots showing six empty columns until the first edit happens
    // to recompile. (The engine calls are safe pre-gesture — EngineHost holds the state
    // and re-pushes it when the context actually starts.)
    this.pushAll();
    this.render();
    const unlock = () => { void this.ensureAudioStarted(); };
    document.addEventListener("pointerdown", unlock, { once: true, capture: true });
  }

  // --- lazy audio unlock ------------------------------------------------
  // The AudioContext can only be created from a user gesture. We boot without one, so
  // the engine starts on the first tap; every call after the first shares one promise.
  private audioStarted = false;
  private audioStarting: Promise<void> | null = null;

  private ensureAudioStarted(): Promise<void> {
    if (this.audioStarted) return Promise.resolve();
    if (!this.audioStarting) {
      this.audioStarting = (async () => {
        await this.engine.start();
        this.pushAll(); // the worklet was empty until now — send it the whole project
        this.audioStarted = true;
      })();
    }
    return this.audioStarting;
  }

  /** Run `fn` once audio is live — immediately if it already is, else start it on this
      gesture first (so the very first shuffle / graph tap actually makes sound). */
  private withAudio(fn: () => void): void {
    if (this.audioStarted) { fn(); return; }
    void this.ensureAudioStarted().then(fn);
  }

  // --- audibility (per colour) ------------------------------------------
  private anySolo(): boolean {
    return this.track.colors.some((c) => c.solo);
  }
  /** A colour is heard unless it's muted or another colour has stolen solo. */
  private colorAudible(c: number): boolean {
    const ct = this.track.colors[c];
    if (!ct) return false;
    return !ct.mute && (!this.anySolo() || !!ct.solo);
  }

  // --- playhead ----------------------------------------------------------
  private handlePlayhead(p: Playhead): void {
    if (!p.lines) {
      this.trackPlayheadEl?.classList.remove("live");
      this.lightPatternStep(-1);
      return;
    }
    // Overview: slide the horizontal playback line down the columns. The columns show the
    // WHOLE track at once (16 blocks, no wrapping), so this is one straight sweep.
    if (this.trackPlayheadEl) {
      const loopLen = this.arr.loopSteps();
      if (loopLen > 0) {
        const bar = (p.pos % loopLen) / STEPS_PER_BAR;
        const barLimit = Math.max(1, this.track.barLimit);
        this.trackPlayheadEl.style.setProperty("--ph", String(Math.min(1, bar / barLimit)));
        // Prefer the MEASURED position: the line rides the blocks, not the box around them
        // (see trackBlockBoxes) — a fraction of the container reads early by the column's
        // border and padding and drifts by the gaps between blocks.
        const px = this.trackBarOffset(bar);
        if (px === null) this.trackPlayheadEl.style.removeProperty("--phpx");
        else this.trackPlayheadEl.style.setProperty("--phpx", `${px.toFixed(2)}px`);
        this.trackPlayheadEl.classList.add("live");
      }
    }
    // Light the open Loop-tab pattern grid's currently-sounding step (nothing when the
    // edited loop isn't sounding this instant).
    if (this.patternPlayCells && this.editLoop && this.editLoop.soundId >= 0) {
      const ec = this.colorOf(this.editLoop);
      let liveStep = -1;
      for (let li = 0; li < this.arr.lines.length; li++) {
        const lane = this.arr.lines[li];
        if ((lane.color ?? -1) !== ec) continue;
        const st = p.lines[li];
        if (st && st.node >= 0 && st.step >= 0 && lane.nodes[st.node]?.soundId === this.editLoop.soundId) {
          liveStep = st.step % this.patternPlaySteps;
          break;
        }
      }
      this.lightPatternStep(liveStep);
    }
    if (this.mixerLeds) {
      for (const ch of p.fired) {
        const led = this.mixerLeds.get(ch);
        if (!led) continue;
        led.classList.remove("flash");
        void led.offsetWidth;
        led.classList.add("flash");
      }
    }
    if (this.voiceBtns) {
      for (const ch of p.fired) {
        const btn = this.voiceBtns.get(ch);
        if (!btn) continue;
        btn.classList.remove("hit-flash");
        void btn.offsetWidth;
        btn.classList.add("hit-flash");
      }
    }
  }

  // --- engine sync ------------------------------------------------------
  private pushAll(): void {
    this.pushSounds();
    this.recompile();
    this.engine.setTempo(this.tempo);
  }

  /** The engine sound table: one entry per loop that carries a sound, keyed by its stable
      id. A muted / soloed-out colour zeroes Volume; a loop's measured loudness makeup
      rides on Volume (the snapshot keeps the mixer's value — see normalizeLoop). */
  private buildSounds(): EngineSound[] {
    const sounds: EngineSound[] = [];
    const seen = new Set<number>();
    this.track.colors.forEach((c, ci) => {
      const audible = this.colorAudible(ci);
      for (const l of c.loops) {
        if (l.soundId < 0 || seen.has(l.soundId)) continue;
        seen.add(l.soundId);
        const snap = l.snapshot.slice();
        if (!audible) snap[ParamId.Volume] = 0;
        else if (l.gain && l.gain !== 1) snap[ParamId.Volume] = (snap[ParamId.Volume] ?? 0.85) * l.gain;
        sounds.push({
          id: l.soundId, snap,
          tail: estimateLength(snap, this.tempo),
          span: snapshotAxisSeconds(snap, this.tempo),
        });
      }
    });
    return sounds;
  }

  private pushSounds(): void {
    this.engine.setSounds(this.buildSounds());
  }

  /** Rebuild the engine lanes from the track and resend them. While playing the engine
      stages this and applies it at the next bar boundary; pass `restart` to jump the
      transport back to the top immediately. */
  private recompile(restart = false): void {
    this.arr.setLanes(this.track.toLanes(), this.track.barLimit);
    this.arr.root = this.track.root;
    this.arr.scale = this.track.scale;
    this.engine.setLines(this.arr.linesMessage(), restart);
    this.updateLoopTime();
    this.persist();
  }

  private updateLoopTime(): void {
    if (!this.loopTimeEl) return;
    const steps = this.arr.loopSteps();
    const sec = this.stepsToSeconds(steps);
    this.loopTimeEl.textContent = steps > 0 ? `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s` : "—";
  }

  // --- persistence ------------------------------------------------------
  private persist(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        const json = serialize(this.track, this.tempo);
        localStorage.setItem(PROJECT_KEY, JSON.stringify(json));
      } catch { /* ignore quota errors */ }
    }, 300);
  }

  private loadFromStorage(): boolean {
    try {
      const raw = localStorage.getItem(PROJECT_KEY);
      if (!raw) return false;
      const json = JSON.parse(raw) as ProjectJSON;
      this.tempo = deserialize(json, this.track);
      this.resetIds();
      return true;
    } catch {
      return false;
    }
  }

  private saveToFile(): void {
    const json = serialize(this.track, this.tempo);
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "msq010-project.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  private promptExportWav(): void {
    const answer = prompt("Export the loop as a WAV — how many times should it repeat?", "1");
    if (answer === null) return;
    const loops = Math.max(1, Math.floor(Number(answer)) || 1);
    this.exportWav(loops).catch((e) => {
      console.error(e);
      alert("Sorry — the export failed.");
    });
  }

  private async exportWav(loops: number): Promise<void> {
    const loopLen = this.arr.loopSteps();
    if (loopLen <= 0) { alert("Nothing to export yet — give some colours a loop first."); return; }
    const sounds = this.buildSounds();
    // Cap at 70s so a drone-length Gate near the end still rings out in the export.
    const maxTail = sounds.reduce((m, s) => Math.max(m, s.tail || 0), 0);
    const tailSec = Math.min(70, Math.max(1.5, maxTail + 0.5));
    const buffer = await this.engine.renderToBuffer({
      lines: this.arr.linesMessage(),
      sounds,
      tempo: this.tempo,
      maxSteps: Math.max(1, Math.round(loops)) * loopLen,
      tailSec,
    });
    const url = URL.createObjectURL(encodeWavFromBuffer(buffer));
    const a = document.createElement("a");
    a.href = url;
    a.download = "euclid-song.wav";
    a.click();
    URL.revokeObjectURL(url);
  }

  private loadFromFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(String(reader.result)) as ProjectJSON;
        this.tempo = deserialize(json, this.track);
        this.resetIds();
        this.afterProjectChange();
      } catch {
        alert("Could not load that file.");
      }
    };
    reader.readAsText(file);
  }

  private newProject(): void {
    this.track = new Track();
    this.tempo = 120;
    this.editTransition = null;
    this.nextSoundId = 0;
    this.editLoop = null;
    this.openColor = 0;
    this.playFromBar = 0;
    this.playToBar = 0;
    this.view = "track";
    // A fresh project re-shuffles the name pools, so its loops draw from a new order.
    reshuffleNames();
    this.afterProjectChange();
  }

  /** After load/new: bump the id counter past every loaded loop id so new sounds never
      collide. Editing state needs no clearing — a draft lives on its loop, and a load
      builds new loops. */
  private resetIds(): void {
    this.editTransition = null;
    let maxId = -1;
    for (const c of this.track.colors) {
      for (const l of c.loops) if (l.soundId > maxId) maxId = l.soundId;
    }
    this.nextSoundId = maxId + 1;
    this.editLoop = null;
  }

  private afterProjectChange(): void {
    this.stopPreview();
    if (this.playing) { this.playing = false; this.engine.stop(); }
    this.pushAll();
    this.render();
  }

  // --- main render ------------------------------------------------------
  private render(): void {
    // Preserve the scroll position across an in-view re-render: render() rebuilds the
    // whole view (a fresh .viewroot scroller), which would otherwise snap back to the
    // top on every edit. Only restore when the view is unchanged — a genuine navigation
    // should start at the top.
    const savedScroll = this.viewRoot?.scrollTop ?? 0;
    const viewKey = this.view;
    const sameView = this.lastViewKey === viewKey;
    this.lastViewKey = viewKey;
    this.root.innerHTML = "";
    this.loopTimeEl = null;
    this.trackPlayheadEl = null;
    this.mixerLeds = null;
    this.voiceBtns = null;

    const bar = document.createElement("header");
    bar.className = "topbar";
    // The Play-range and Mixer buttons used to float over the rings visualizer; with the
    // rings gone they live in the top bar, on the track view only (the colour and mixer
    // views place their own).
    bar.append(this.topLeftControl(), this.transport());
    if (this.view === "track") bar.append(this.playRangeOpenBtn(), this.mixerOpenBtn("track"));
    bar.append(this.menu());
    this.root.append(bar);

    this.viewRoot = document.createElement("main");
    // .view-enter plays the entrance stagger — only on a genuine navigation, so
    // in-place re-renders (scrubs, toggles) don't replay it.
    this.viewRoot.className = "viewroot" + (sameView ? "" : " view-enter");
    this.root.append(this.viewRoot);

    if (this.view === "grid") this.renderGridPanel();
    else if (this.view === "mixer") this.renderMixer();
    else this.renderTrackPanel();

    this.updateLoopTime();

    // An open placement popup floats above everything (appended to root, so it survives
    // the panel re-render below it). It rides over BOTH the track view and the grid view —
    // a loop opens straight off its column — but never over the mixer.
    if (this.view !== "mixer" && this.editLoop) this.openPlacement(this.editLoop);
    if (sameView) this.viewRoot.scrollTop = savedScroll;
  }

  private menu(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "menu";
    const btn = document.createElement("button");
    btn.className = "menu-btn";
    btn.textContent = "≡";
    const panel = document.createElement("div");
    panel.className = "menu-panel hidden";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "application/json,.json";
    fileInput.style.display = "none";
    fileInput.onchange = () => {
      const f = fileInput.files?.[0];
      if (f) this.loadFromFile(f);
      fileInput.value = "";
    };

    const mk = (text: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.onclick = () => { panel.classList.add("hidden"); fn(); };
      return b;
    };
    const expHigh = mk("", () => exportReports("high"));
    const expLow = mk("", () => exportReports("low"));
    const clearLogs = mk("Clear sound logs", () => {
      if (confirm("Clear both sound feedback logs?")) clearReports();
    });
    const refreshLogs = () => {
      const h = reportCount("high");
      const l = reportCount("low");
      expHigh.textContent = `Export “too high” log (${h})`;
      expHigh.disabled = h === 0;
      expLow.textContent = `Export “too low” log (${l})`;
      expLow.disabled = l === 0;
      clearLogs.disabled = h === 0 && l === 0;
    };
    refreshLogs();
    panel.append(
      mk("New project", () => { if (confirm("Clear everything and start fresh?")) this.newProject(); }),
      mk("Save to file", () => this.saveToFile()),
      mk("Load from file", () => fileInput.click()),
      mk("Export WAV", () => this.promptExportWav()),
      expHigh, expLow, clearLogs,
    );
    btn.onclick = () => { refreshLogs(); panel.classList.toggle("hidden"); };
    wrap.append(btn, panel, fileInput);
    return wrap;
  }

  private transport(): HTMLElement {
    const t = document.createElement("div");
    t.className = "transport";
    const play = document.createElement("button");
    play.className = "play-btn";
    const syncPlay = () => {
      play.textContent = this.playing ? "■" : "▶";
      play.classList.toggle("playing", this.playing);
      play.style.setProperty("--beat", `${(60 / this.tempo).toFixed(4)}s`);
    };
    syncPlay();
    play.onclick = async () => {
      this.stopPreview(); // the transition preview never plays under the real transport
      if (!this.playing) {
        try {
          const rebuilt = await this.engine.ensureRunning();
          if (rebuilt) this.pushAll();
        } catch { /* best effort */ }
        this.playing = true;
        this.engine.play();
        this.applySection();
      } else {
        this.playing = false;
        this.engine.stop();
      }
      syncPlay();
    };

    const tempo = document.createElement("button");
    tempo.className = "tempo-btn";
    tempo.textContent = `${Math.round(this.tempo)} BPM`;
    tempo.title = "Tempo";
    tempo.onclick = () => this.openNumpad({
      title: "Tempo (BPM)", value: Math.round(this.tempo),
      onSubmit: (n) => {
        this.tempo = Math.max(30, Math.min(300, Math.round(n) || 120));
        this.engine.setTempo(this.tempo);
        this.persist();
        this.render();
      },
    });

    t.append(play, tempo);
    return t;
  }

  /** Push the play-range loop region to the engine (1-indexed bars, inclusive). An unset /
      invalid range clears it (loops the whole track). Called on play and on range edits. */
  private applySection(): void {
    const barLimit = Math.max(1, this.track.barLimit);
    const from = this.playFromBar, to = this.playToBar;
    if (from >= 1 && to >= from && from <= barLimit) {
      const f = Math.min(from, barLimit), t = Math.min(to, barLimit);
      this.engine.setSection((f - 1) * STEPS_PER_BAR, (t - f + 1) * STEPS_PER_BAR);
    } else {
      this.engine.setSection(0, 0);
    }
  }

  private chainIcon(): SVGSVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    for (const cx of [5, 12, 19]) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", String(cx));
      c.setAttribute("cy", "12");
      c.setAttribute("r", "2.5");
      c.setAttribute("fill", "currentColor");
      svg.append(c);
    }
    return svg;
  }

  private topLeftControl(): HTMLElement {
    if (this.view === "track") {
      // Track length (scrub or tap to edit), with the loop's total seconds beside it in
      // small type — replaces the old seconds-only pill and the body "Track length" row.
      const wrap = document.createElement("div");
      wrap.className = "loop-meta";
      const bars = document.createElement("input");
      bars.type = "text";
      bars.readOnly = true;
      bars.inputMode = "none";
      bars.size = 8; // fit "512 bars" without an input's default 20-char width
      bars.className = "loop-meta-bars";
      bars.title = "Track length";
      bars.value = `${this.track.barLimit} bars`;
      this.attachScrub(bars, {
        label: "Track length (bars)",
        read: () => this.track.barLimit,
        write: (n) => { this.track.barLimit = Math.max(1, Math.min(512, Math.round(n))); this.recompile(); },
        show: () => `${this.track.barLimit} bars`,
      });
      this.loopTimeEl = document.createElement("span");
      this.loopTimeEl.className = "loop-meta-secs";
      wrap.append(bars, this.loopTimeEl);
      return wrap;
    }
    const b = document.createElement("button");
    b.className = "loop-view-btn";
    b.title = "Track";
    b.setAttribute("aria-label", "Track");
    b.append(this.chainIcon());
    b.onclick = () => { this.view = "track"; this.editLoop = null; this.render(); };
    return b;
  }

  /** A |—| bracket icon for the play-range button (a span with two end caps). */
  private rangeIcon(): SVGSVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    const mk = (x1: number, y1: number, x2: number, y2: number) => {
      const l = document.createElementNS(NS, "line");
      l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1));
      l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2));
      l.setAttribute("stroke", "currentColor");
      l.setAttribute("stroke-width", "2");
      l.setAttribute("stroke-linecap", "round");
      svg.append(l);
    };
    mk(6, 6, 6, 18);
    mk(18, 6, 18, 18);
    mk(6, 12, 18, 12);
    return svg;
  }

  /** The small button at the rings' top-left that opens the play-range popup; lit when a
      range is active. */
  private playRangeOpenBtn(): HTMLElement {
    const on = this.playFromBar >= 1 && this.playToBar >= this.playFromBar;
    const b = document.createElement("button");
    b.className = "playrange-open-btn" + (on ? " on" : "");
    b.title = "Play range";
    b.setAttribute("aria-label", "Play range");
    b.append(this.rangeIcon());
    b.onclick = () => this.openPlayRangePopup();
    return b;
  }

  /** Pop up the play-range editor over the rings — the same bar-SQUARE grid the voice
      loops place on (1/2/4-bar squares, Start·End pick), looping just the picked bars.
      Kept out of the main column so the track view stays compact. */
  private openPlayRangePopup(): void {
    document.querySelector(".playrange-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "playrange-overlay";
    // Closing re-renders so the rings' play-range button reflects the new on/off state.
    overlay.onclick = (e) => { if (e.target === overlay) { this.gridPick = null; this.render(); } };
    const card = document.createElement("div");
    card.className = "playrange-card";
    card.append(this.playRangeGrid());
    overlay.append(card);
    this.root.append(overlay);
  }

  /** The play-range as a bar grid: the picked squares are the section that loops (a
      contiguous from→to range — painting gaps spans across them). Applied to the engine
      live; not saved with the project. */
  private playRangeGrid(): HTMLElement {
    const isOn = () => this.playFromBar >= 1 && this.playToBar >= this.playFromBar;
    const wrap = document.createElement("div");
    wrap.className = "track-barlimit play-range" + (isOn() ? " on" : "");

    const head = document.createElement("div");
    head.className = "play-range-head";
    const lbl = document.createElement("span");
    lbl.className = "play-range-lbl";
    lbl.textContent = "Play range";
    const readout = document.createElement("span");
    readout.className = "play-range-readout";
    readout.textContent = isOn()
      ? `bars ${this.playFromBar}–${this.playToBar}`
      : "whole track — pick a section to loop";
    head.append(lbl, readout);
    wrap.append(head);

    const barLimit = Math.max(1, this.track.barLimit);
    wrap.append(this.barGrid({
      key: "range",
      color: "var(--accent)",
      read: () => {
        if (!isOn()) return [];
        const to = Math.min(this.playToBar, barLimit);
        return Array.from({ length: Math.max(0, to - this.playFromBar + 1) }, (_, i) => this.playFromBar + i);
      },
      write: (bars) => {
        // The range is contiguous from→to: painting with gaps spans across them.
        if (!bars.length) { this.playFromBar = 0; this.playToBar = 0; }
        else { this.playFromBar = bars[0]; this.playToBar = bars[bars.length - 1]; }
        this.applySection(); // follow along live while playing
      },
      commit: () => this.openPlayRangePopup(),
      occupied: new Set(),
      grow: false,
    }));
    return wrap;
  }

  private mixerOpenBtn(from: View): HTMLElement {
    const mix = document.createElement("button");
    mix.className = "mixer-open-btn";
    mix.textContent = "🎚";
    mix.title = "Mixer";
    mix.setAttribute("aria-label", "Mixer");
    mix.onclick = () => { this.mixerReturn = from; this.view = "mixer"; this.render(); };
    return mix;
  }

  /** A segmented sub-tab nav (the loop popup's Sound/Loop/Transition look), tinted to the
      row colour. */
  // --- track view (colours + bar limit) --------------------------------
  /** A draggable bar strip — the play-range gesture, shared with transition placement:
      one faint cell per bar, ticked every 4, with a highlight band. Dragging sweeps a
      from–to bar range; `write` fires live (only when the range actually changes) so the
      engine can follow mid-drag. `read` returning null hides the band. */
  private renderTrackPanel(): void {
    const v = this.viewRoot;
    // Whole-track overview: one VERTICAL COLUMN per colour, the whole timeline at once and
    // in one screenful whatever the track length. Each column is OVERVIEW_BLOCKS blocks
    // tall; a block covers barLimit/OVERVIEW_BLOCKS bars (exactly 16 at the 256-bar
    // default) and paints those bars as slices, so its fill shows both how many bars sound
    // and where they sit. No numbers anywhere — the column is a shape, not a table.
    // Tapping a painted part of a column opens THAT loop's sound page directly (the shade
    // you touch is the loop you get); under each column sit its loop chips and the ▦
    // button onto the voice's all-loops grid.
    this.voiceBtns = new Map();
    const barLimit = Math.max(1, this.track.barLimit);
    this.trackGeom = null; // the blocks are about to be rebuilt — re-measure on first use

    const overview = document.createElement("div");
    overview.className = "track-overview";

    // Two rows that line up column for column: the paint, then the per-voice footers. They
    // are SEPARATE rows because the playhead is positioned against the first one — inside a
    // single stacked wrapper the footers would stretch it past the end of the track, and
    // `--ph` = 1 would land the line somewhere under the buttons.
    const cols = document.createElement("div");
    cols.className = "track-cols";
    this.trackPlayheadEl = document.createElement("div");
    this.trackPlayheadEl.className = "track-playhead";
    cols.append(this.trackPlayheadEl);
    const foots = document.createElement("div");
    foots.className = "track-foots";
    overview.append(cols, foots);

    for (let c = 0; c < NUM_LINES; c++) {
      const ct = this.track.colors[c];
      const foot = document.createElement("div");
      foot.className = "track-foot";
      foot.style.setProperty("--vc", VOICE_COLORS[c]);

      const col = document.createElement("button");
      col.className = "track-color-col";
      col.style.setProperty("--vc", VOICE_COLORS[c]);
      col.title = `Voice ${c + 1}`;

      const bars = this.colorBarNumbers(c);
      for (let i = 0; i < OVERVIEW_BLOCKS; i++) {
        // Split by rounded boundaries rather than a fixed block size, so the blocks always
        // tile the track exactly even when barLimit isn't a multiple of OVERVIEW_BLOCKS.
        const { from, to } = this.blockRange(i, barLimit);
        col.append(this.overviewBlock(bars.slice(from, Math.max(from + 1, to)), c));
      }

      // Where the tap landed, in bars, read off the same per-bar numbers the blocks are
      // shaded from — so the loop that opens is always the one under the finger. Measured
      // against the BLOCKS (as the playhead is), not the padded column around them. Bare
      // field falls through to the grid, which is where you'd go to place something there.
      col.onclick = (e) => {
        const n = bars[this.trackBarAtY(cols, e.clientY)] ?? 0; // 1-based loop number, 0 = silence
        const loop = n > 0 ? ct.loops[n - 1] : null;
        if (loop) this.openPlacement(loop, "sound");
        else this.openGrid(c);
      };
      cols.append(col);

      // The voice's own button first — it's the one you reach for blind, so it gets the
      // width and the height — then its loops as chips underneath it.
      const gridBtn = document.createElement("button");
      gridBtn.className = "track-grid-btn";
      gridBtn.textContent = "▦";
      gridBtn.title = `All of voice ${c + 1}'s loops`;
      gridBtn.onclick = () => this.openGrid(c);
      foot.append(gridBtn);

      // The loop chips: the same shade ramp as the blocks, so a chip reads as the paint it
      // stands for. They're the reliable way in when a loop's placement is too thin to hit.
      const chips = document.createElement("div");
      chips.className = "track-chips";
      ct.loops.forEach((loop, i) => {
        const chip = document.createElement("button");
        chip.className = "track-chip";
        // The shade rides on a custom property, not on `style.background`: an inline
        // background would outrank .hit-flash and the chip would never light on a hit.
        chip.style.setProperty("--ls", this.loopShade(c, i + 1));
        chip.title = loop.label || loop.name || `Loop ${i + 1}`;
        chip.setAttribute("aria-label", chip.title);
        chip.onclick = () => this.openPlacement(loop, "sound");
        // The playhead flashes the chip rather than the whole column, so a hit shows which
        // loop played it.
        if (loop.soundId >= 0) this.voiceBtns!.set(loop.soundId, chip);
        chips.append(chip);
      });
      foot.append(chips);

      foots.append(foot);
    }
    v.append(overview);
  }

  /** Open a voice's all-loops grid, landing on its first loop. */
  private openGrid(c: number): void {
    this.openColor = c;
    this.gridLoopIdx = 0;
    this.view = "grid";
    this.editLoop = null;
    this.render();
  }

  /** The shade a colour's `num`-th loop (1-based) is drawn in, everywhere it's drawn: the
      overview blocks, the track chips, the grid's underlay and its loop picker. Loop 1 is
      the base colour, each later loop a step lighter. */
  private loopShade(c: number, num: number): string {
    return this.shade(VOICE_COLORS[c], Math.min(LOOP_SHADE_CAP, 0.5 + (num - 1) * LOOP_SHADE_STEP));
  }

  /** One block of a colour's column: `cells` (one entry per bar it covers, 0 = empty, >0 =
      the sounding loop's number) drawn as equal vertical slices. It's a single element with
      a hard-stop gradient rather than a span per bar — six columns of sixteen blocks is 96
      elements this way, against 1536 at one per bar on a 256-bar track. */
  private overviewBlock(cells: number[], c: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "track-block";
    if (!cells.some((n) => n > 0)) return el; // wholly empty: the plain field background
    const stops: string[] = [];
    for (let i = 0; i < cells.length; i++) {
      // Loop 1 = the base colour, each later loop a shade lighter (as the colour panel's
      // timeline cells), so a colour's loops still tell apart inside one block.
      const n = cells[i];
      const col = n > 0 ? this.loopShade(c, n) : "transparent";
      const a = ((i / cells.length) * 100).toFixed(4);
      const b = (((i + 1) / cells.length) * 100).toFixed(4);
      stops.push(`${col} ${a}% ${b}%`);
    }
    el.style.backgroundImage = `linear-gradient(to bottom, ${stops.join(", ")})`;
    return el;
  }

  /** The bar range block `i` covers, by ROUNDED boundaries so the blocks tile the track
      exactly even when barLimit isn't a multiple of OVERVIEW_BLOCKS. The one definition
      of where a block starts and ends — renderTrackPanel slices its cells by it, and the
      playhead/tap mapping reads bars back out of it. */
  private blockRange(i: number, barLimit: number): { from: number; to: number } {
    return {
      from: Math.round((i * barLimit) / OVERVIEW_BLOCKS),
      to: Math.round(((i + 1) * barLimit) / OVERVIEW_BLOCKS),
    };
  }

  /** Each overview block's top/height relative to `.track-cols` — the box the playhead is
      positioned in. Time is painted by the BLOCKS, which sit inside the column's border
      and padding and are separated by gaps that carry no time at all, so a fraction of the
      CONTAINER lands several pixels off the bars it claims to mark. Measured once per
      render (all six columns share the same vertical geometry), never per frame. */
  private trackBlockBoxes(): { top: number; height: number }[] | null {
    const cols = this.root.querySelector<HTMLElement>(".track-cols");
    if (!cols) { this.trackGeom = null; return null; }
    const h = cols.clientHeight;
    if (this.trackGeom && this.trackGeom.h === h) return this.trackGeom.boxes;
    const col = cols.querySelector<HTMLElement>(".track-color-col");
    const blocks = col ? [...col.querySelectorAll<HTMLElement>(".track-block")] : [];
    if (blocks.length !== OVERVIEW_BLOCKS) return null;
    const base = cols.getBoundingClientRect().top;
    const boxes = blocks.map((b) => {
      const r = b.getBoundingClientRect();
      return { top: r.top - base, height: r.height };
    });
    this.trackGeom = { h, boxes };
    return boxes;
  }

  /** Where bar position `bar` (fractional, 0-based) sits in pixels down `.track-cols`, or
      null when the overview isn't on screen to be measured. */
  private trackBarOffset(bar: number): number | null {
    const boxes = this.trackBlockBoxes();
    if (!boxes) return null;
    const barLimit = Math.max(1, this.track.barLimit);
    const b = Math.max(0, Math.min(barLimit, bar));
    let i = Math.min(OVERVIEW_BLOCKS - 1, Math.floor((b / barLimit) * OVERVIEW_BLOCKS));
    // Rounded boundaries can put `b` in the neighbouring block on odd bar limits.
    while (i > 0 && b < this.blockRange(i, barLimit).from) i--;
    while (i < OVERVIEW_BLOCKS - 1 && b >= this.blockRange(i, barLimit).to) i++;
    const { from, to } = this.blockRange(i, barLimit);
    const f = to > from ? Math.max(0, Math.min(1, (b - from) / (to - from))) : 0;
    return boxes[i].top + f * boxes[i].height;
  }

  /** The bar (0-based) under a tap at `clientY` on a column, read off the same block
      geometry the playhead uses — the inverse of trackBarOffset, so the loop that opens is
      the loop the line would be crossing. Falls back to the flat mapping when unmeasured. */
  private trackBarAtY(cols: HTMLElement, clientY: number): number {
    const barLimit = Math.max(1, this.track.barLimit);
    const boxes = this.trackBlockBoxes();
    const y = clientY - cols.getBoundingClientRect().top;
    if (!boxes) {
      const t = Math.min(0.999, Math.max(0, y / Math.max(1, cols.clientHeight)));
      return Math.floor(t * barLimit);
    }
    let i = 0;
    while (i < OVERVIEW_BLOCKS - 1 && y >= boxes[i].top + boxes[i].height) i++;
    const { from, to } = this.blockRange(i, barLimit);
    const f = Math.max(0, Math.min(0.999, (y - boxes[i].top) / Math.max(1, boxes[i].height)));
    return Math.min(barLimit - 1, from + Math.floor(f * Math.max(1, to - from)));
  }

  // --- grid view (one voice, all its loops) -----------------------------
  /** A voice's ALL-LOOPS GRID: the bar-square placement grid with every loop of the colour
      painted in its own shade, and a picker saying which one your drag edits. It replaced
      the old loop list — the list only existed to pick a loop and launch its pages, and
      both of those now happen out on the track column — so add / remove / reorder live in
      the picker's action row instead. */
  private renderGridPanel(): void {
    const v = this.viewRoot;
    const c = this.openColor;
    const loops = this.track.colors[c].loops;
    this.voiceBtns = new Map();
    // Loops come and go under the index (removed, reordered), so clamp it here rather than
    // trusting whatever set it.
    this.gridLoopIdx = Math.min(Math.max(0, this.gridLoopIdx), Math.max(0, loops.length - 1));
    const i = this.gridLoopIdx;
    const picked: Loop | undefined = loops[i];

    const head = document.createElement("div");
    head.className = "mixer-head";
    head.style.setProperty("--vc", VOICE_COLORS[c]);
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = "‹ Track";
    back.onclick = () => { this.view = "track"; this.editLoop = null; this.render(); };
    const title = document.createElement("h2");
    title.className = "mixer-title";
    title.textContent = `Voice ${c + 1}`;
    head.append(back, title);
    v.append(head);

    // The picker: one chip per loop in priority order, in the shade the grid paints it.
    const picker = document.createElement("div");
    picker.className = "loop-picker";
    picker.style.setProperty("--vc", VOICE_COLORS[c]);
    loops.forEach((loop, n) => {
      const chip = document.createElement("button");
      chip.className = "loop-picker-chip" + (n === i ? " on" : "");
      chip.style.setProperty("--ls", this.loopShade(c, n + 1));
      const swatch = document.createElement("span");
      swatch.className = "loop-picker-dot";
      const name = document.createElement("span");
      name.className = "loop-picker-name";
      name.textContent = loop.label || loop.name || `Loop ${n + 1}`;
      chip.append(swatch, name);
      chip.title = this.ruleSummary(loop);
      if (loop.soundId >= 0) this.voiceBtns!.set(loop.soundId, chip);
      chip.onclick = () => { this.gridLoopIdx = n; this.render(); };
      picker.append(chip);
    });
    const add = document.createElement("button");
    add.className = "loop-picker-chip loop-picker-add";
    add.textContent = "＋";
    add.title = "Add a loop to this voice";
    add.onclick = () => { this.gridLoopIdx = loops.length; this.addLoop(c); };
    picker.append(add);
    v.append(picker);

    if (!picked) {
      const empty = document.createElement("p");
      empty.className = "voice-sheet-sub";
      empty.textContent = "No loops on this voice yet — ＋ adds one.";
      v.append(empty);
      return;
    }

    // What the actions do to the PICKED loop. Reorder follows it, so the chip you're
    // editing stays the chip that's lit.
    const actions = document.createElement("div");
    actions.className = "loop-picker-actions";
    const mkAction = (text: string, titleText: string, disabled: boolean, fn: () => void) => {
      const b = document.createElement("button");
      b.className = "loop-action-btn";
      b.textContent = text;
      b.title = titleText;
      b.disabled = disabled;
      b.onclick = fn;
      return b;
    };
    actions.append(
      mkAction("▲", "Higher priority", i === 0, () => { this.gridLoopIdx = i - 1; this.moveLoop(c, i, -1); }),
      mkAction("▼", "Lower priority", i === loops.length - 1, () => { this.gridLoopIdx = i + 1; this.moveLoop(c, i, 1); }),
      mkAction("♪ Sound", "Open this loop's sound", false, () => this.openPlacement(picked, "sound")),
      mkAction("× Remove", "Remove this loop", false, () => this.removeLoop(c, i)),
    );
    v.append(actions);

    v.append(this.placementGrid(picked, () => this.render()));
  }

  /** Per-bar coverage of a colour's compiled lanes: one number[] per lane, `barLimit`
      wide. Each cell is 0 when empty, else the sounding loop's 1-based number (its place
      in the colour's priority list) — so the same-row loops can be told apart. */
  private colorLaneNumbers(c: number): number[][] {
    const bars = Math.max(1, this.track.barLimit);
    const numById = new Map<number, number>();
    this.track.colors[c].loops.forEach((l, i) => { if (l.soundId >= 0) numById.set(l.soundId, i + 1); });
    return this.arr.lines.filter((l) => l.color === c).map((lane) => {
      const cells = new Array(bars).fill(0);
      let bar = 0;
      for (const n of lane.nodes) {
        const span = (n.reps * (n.steps >= 1 ? n.steps : STEPS_PER_BAR)) / STEPS_PER_BAR;
        if (n.soundId >= 0) {
          const num = numById.get(n.soundId) ?? 0;
          for (let b = Math.floor(bar); b < Math.min(bars, Math.ceil(bar + span)); b++) cells[b] = num;
        }
        bar += span;
      }
      return cells;
    });
  }

  /** Per-bar coverage of a colour as ONE `barLimit`-wide array (0 = empty, >0 = the
      sounding loop's number). A colour compiles to exactly one lane — its loops resolve by
      priority rather than stacking (see track.ts resolveLane) — so this is the whole truth
      about the colour, which is what lets one narrow column stand for it. */
  private colorBarNumbers(c: number): number[] {
    const lanes = this.colorLaneNumbers(c);
    return lanes[0] ?? new Array(Math.max(1, this.track.barLimit)).fill(0);
  }

  /** A shade of `hex` at t∈[0,1]: 0 = darkest, 0.5 = the colour itself, 1 = lightest.
      Used to give each loop of a colour its own tint so they're distinct at a glance. */
  private shade(hex: string, t: number): string {
    const m = hex.replace("#", "");
    const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
    const f = (t - 0.5) * 2; // -1 (dark) .. +1 (light)
    const mix = (ch: number) => (f >= 0 ? Math.round(ch + (255 - ch) * f * 0.7) : Math.round(ch * (1 + f * 0.6)));
    const to2 = (x: number) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0");
    return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
  }

  /** A one-line description of a loop's placement rule. */
  private ruleSummary(loop: Loop): string {
    const r = loop.rule;
    let every: string;
    if (r.every.kind === "nth") {
      const base = r.every.n === 1 ? "every bar" : `every ${r.every.n} bars`;
      every = r.every.start && r.every.start > 1 ? `${base} from bar ${r.every.start}` : base;
    }
    else if (r.every.kind === "pow2") every = "at 1,2,4,8…";
    else if (r.every.kind === "at") every = r.every.bars.length ? `at bars ${r.every.bars.join(",")}` : "no bars set";
    else if (r.every.kind === "fill") every = "fill the blanks";
    else if (r.every.kind === "dice") every = `dice ${r.every.weight} of the pool`;
    else every = `${Math.round(r.every.weight * 100)}% chance`;
    const lens = ruleLengths(r);
    const forB = lens.length > 1 ? `${lens.join("/")} bars` : (r.forBars === 1 ? "1 bar" : `${r.forBars} bars`);
    return `${every} · for ${forB}${r.retrigger ? " · re-fade" : ""}`;
  }

  private addLoop(c: number): void {
    const loop = emptyLoop(c, -1);
    loop.label = generateName(); // a coined display name for this new voice
    this.track.colors[c].loops.push(loop);
    this.mintLoopSound(loop);
    this.render();
    this.openPlacement(loop, "sound");
  }

  private moveLoop(c: number, i: number, dir: -1 | 1): void {
    const loops = this.track.colors[c].loops;
    const j = i + dir;
    if (j < 0 || j >= loops.length) return;
    [loops[i], loops[j]] = [loops[j], loops[i]];
    this.recompile();
    this.render();
  }

  private removeLoop(c: number, i: number): void {
    const loops = this.track.colors[c].loops;
    const [removed] = loops.splice(i, 1);
    if (removed) {
      // The drafts go with the loop and its transitions — nothing to evict.
      for (const tr of removed.transitions ?? []) {
        if (this.editTransition === tr) { this.editTransition = null; this.stopPreview(); }
      }
    }
    if (this.editLoop === removed) this.editLoop = null;
    this.pushSounds();
    this.recompile();
    this.render();
  }

  // --- placement popup --------------------------------------------------
  private closePlacement(): void {
    this.stopPreview();
    document.querySelector(".placement-overlay")?.remove();
    this.editLoop = null;
    this.editTransition = null;
    this.gridPick = null;
    this.patternPlayCells = null;
    this.render();
  }

  /** The editor popup for `loop`. Its main page is the WHOLE loop, top to bottom: the
      rhythm circles, the sequencer pattern grid, the full sound graph, then the two buttons
      that lead off it (⇄ Transitions, ⧉ Copy). Placement isn't here — it lives out on the
      voice's all-loops grid, where a loop's bars can be seen against its neighbours' — and
      the per-hit accent/ghost placement lives on the graph's own Life trace, with the rest
      of the per-hit settings.
      ⇄ takes the sheet for itself and opens the transition's SOUND straight away (minting
      the first transition if the loop has none); the list of them is a button off that.
      Omitting `tab` means "rebuild where we are": that's how every in-place re-render goes
      through here without resetting the page you're on.
      Rebuilt in place on any change (it's appended to the root, so it survives a panel
      re-render below it — the track view or the grid view). */
  private openPlacement(loop: Loop, tab?: PlacementTab): void {
    // The sheet is rebuilt from scratch on every change, which would snap its scroll
    // back to the top — capture it before the old overlay goes, restore it below when
    // the rebuild is IN-PLACE (same tab/sub-page; a genuine navigation starts at top).
    const prevScroll = document.querySelector<HTMLElement>(".placement-overlay .voice-sheet")?.scrollTop ?? 0;
    document.querySelector(".placement-overlay")?.remove();
    // Stale cell refs from a previous render; patternGrid re-sets them if shown.
    this.patternPlayCells = null;
    // A genuine open: a different loop, or the same one re-entered through a tab.
    const opening = this.editLoop !== loop || tab !== undefined;
    if (opening) {
      // Land on the page asked for (the main sound page unless Transitions was named) and
      // reset every sub-state the popup carries.
      this.placementTab = tab ?? "sound";
      this.gridPick = null;
      this.editTransition = null;
      this.transTab = "graph";
      this.transPreviewMode = "transition";
      this.graphTrace = null;
      this.graphPage = 0;
    }
    this.editLoop = loop;
    // The popup's view identity: scroll only survives while it's unchanged.
    const viewKey = [
      this.placementTab,
      this.editTransition ? (loop.transitions ?? []).indexOf(this.editTransition) : -1,
      this.transTab,
      `g:${this.graphTrace ?? ""}:${this.graphPage}`,
    ].join(":");
    const sameView = !opening && this.popupViewKey === viewKey;
    this.popupViewKey = viewKey;
    const rerender = () => this.openPlacement(loop);

    const overlay = document.createElement("div");
    // .sheet-enter animates the card in — only on a fresh open, not in-place rebuilds.
    overlay.className = "placement-overlay voice-sheet-overlay" + (opening ? " sheet-enter" : "");
    // The sheet fills the page BELOW the top bar (the nav stays visible/usable), so the
    // editor gets the whole rest of the screen.
    const topbar = this.root.querySelector(".topbar");
    overlay.style.setProperty("--popup-top", `${Math.max(0, Math.round(topbar?.getBoundingClientRect().bottom ?? 0))}px`);
    overlay.onclick = (e) => { if (e.target === overlay) this.closePlacement(); };

    const sheet = document.createElement("div");
    sheet.className = "voice-sheet placement-sheet";
    sheet.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#808080");

    // While a transition's editor is open it takes the whole page, and the back button
    // folds into the header's breadcrumb (close › name › Transition N) rather than
    // spending a second row.
    const trs = loop.transitions ?? (loop.transitions = []);
    const openTr = this.placementTab === "transition" && this.editTransition && trs.includes(this.editTransition)
      ? this.editTransition
      : null;

    const head = document.createElement("div");
    head.className = "voice-sheet-head win-title";
    const loopName = loop.label || loop.name || "Loop";
    // The title bar's ✕ box, in the right corner of every page of the sheet — the same
    // little raised square the help panel and the numpad close with. It shuts the sheet
    // outright, wherever you are in it (a transition editor included), which the
    // breadcrumb's leftmost segment can't say as plainly.
    const closeBox = () => {
      const b = document.createElement("button");
      b.className = "sheet-close";
      b.textContent = "✕";
      b.title = "Close";
      b.setAttribute("aria-label", "Close");
      b.onclick = () => this.closePlacement();
      return b;
    };
    if (openTr) {
      // Breadcrumb: close › name (back to the transition list) › Transition N.
      const crumb = document.createElement("nav");
      crumb.className = "sheet-crumb";
      const seg = (text: string, onclick: () => void) => {
        const b = document.createElement("button");
        b.className = "crumb-seg";
        b.textContent = text;
        b.onclick = onclick;
        return b;
      };
      const sep = () => {
        const s = document.createElement("span");
        s.className = "crumb-sep";
        s.textContent = "›";
        return s;
      };
      const cur = document.createElement("span");
      cur.className = "crumb-current";
      cur.textContent = `Transition ${trs.indexOf(openTr) + 1}`;
      crumb.append(
        seg("‹ Close", () => this.closePlacement()), sep(),
        seg(loopName, () => { this.stopPreview(); this.editTransition = null; this.gridPick = null; rerender(); }), sep(),
        cur,
      );
      head.append(crumb);
      // Two ⧉ on the header's right edge, both landing the transformed sound as a new loop
      // placed after the transition: the plain one drops it on THIS row (the common case —
      // the row plays the sound, transitions, then carries on as the new one), the ⧉→ asks
      // which voice to drop it on instead. (On/Off lives in the transition list, so it's
      // not repeated here.)
      const copy = document.createElement("button");
      copy.className = "voice-name-dice crumb-copy";
      copy.textContent = "⧉";
      copy.title = "New loop from this transformed sound, placed after the transition";
      copy.onclick = () => this.copyTransformedSound(loop, openTr);
      const copyTo = document.createElement("button");
      copyTo.className = "voice-name-dice crumb-copy";
      copyTo.textContent = "⧉→";
      copyTo.title = "Copy this transformed sound to another voice";
      copyTo.onclick = () => this.openCopyMenu("Copy transformed sound to…",
        (c) => this.copyTransformedSound(loop, openTr, c), this.colorOf(loop));
      head.append(copy, copyTo, closeBox());
      sheet.append(head);
    } else {
      const back = document.createElement("button");
      back.className = "mixer-back";
      // Closes onto whichever view is underneath — the track columns or the voice's grid.
      back.textContent = "‹ Back";
      back.onclick = () => this.closePlacement();
      const title = document.createElement("h2");
      title.className = "voice-sheet-title";
      title.textContent = loopName;
      head.append(back, title);
      // Re-coin this voice's name (only for named loops).
      if (loop.label) {
        const dice = document.createElement("button");
        dice.className = "voice-name-dice";
        dice.textContent = "🎲";
        dice.title = "Coin a new name for this voice";
        dice.onclick = () => { loop.label = generateName(); this.persist(); rerender(); };
        head.append(dice);
      }
      head.append(closeBox());
      sheet.append(head);
      // The sound description under the coined name, for reference.
      if (loop.label && loop.name) {
        const sub = document.createElement("p");
        sub.className = "voice-sheet-sub";
        sub.textContent = loop.name;
        sheet.append(sub);
      }
    }

    // No tab nav here: the main page IS the loop, and everything else opens off it.
    if (this.placementTab === "transition") {
      if (openTr) sheet.append(this.transitionEditor(loop, openTr, rerender));
      else {
        this.editTransition = null;
        // Nothing sits behind the popup to come back through any more, so the list carries
        // its own way back to the sound page.
        sheet.append(this.subPanelHead("Transitions", () => { this.placementTab = "sound"; rerender(); }));
        sheet.append(this.transitionList(loop, rerender));
      }
    } else {
      // The whole loop on one page: what it plays (the rhythm circles and the sequencer
      // grid), then WHAT it sounds like (the graph), then where you go from here. Rhythm
      // reads above the sound because it's what the graph is drawn for.
      const rhythmRow = document.createElement("div");
      rhythmRow.className = "loop-rhythm";
      const detail = document.createElement("div");
      detail.className = "euclid-detail";
      detail.append(this.rhythmCircles(loop, rerender));
      rhythmRow.append(detail);
      sheet.append(rhythmRow);
      // The sequencer grid stands down for the two FLAT layouts. Each is a whole screenful
      // on its own, and is what you came to this page for when it is the selected layout;
      // the rhythm circles above still say what the loop plays. Switch back to the graph
      // (∿) and the grid comes back with it.
      if (this.soundLayout === "graph") sheet.append(this.patternGrid(loop, rerender));

      // The sound panel IS the sound, in whichever layout is selected.
      sheet.append(this.soundPanel(this.graphHostForLoop(loop, rerender), rerender));

      const actions = document.createElement("div");
      actions.className = "loop-actions";
      const mkAction = (text: string, title: string, fn: () => void) => {
        const b = document.createElement("button");
        b.className = "loop-action-btn";
        b.textContent = text;
        b.title = title;
        b.onclick = fn;
        return b;
      };
      const trCount = trs.length;
      actions.append(
        // Straight to the transitioned SOUND — the thing you came for. A loop with no
        // transition yet gets one minted here (an identity copy of its own sound, which is
        // what the list's ＋ made anyway), so the empty list never stands in the way. The
        // list is one button further in, for a second transition.
        mkAction(trCount ? `⇄ Transitions (${trCount})` : "⇄ Transitions", "This loop's transitioned sound",
          () => {
            let tr = trs[0];
            if (!tr) { tr = defaultLoopTransition(loop, this.track.barLimit); trs.push(tr); }
            this.placementTab = "transition";
            this.editTransition = tr;
            this.transTab = "effects";
            this.graphTrace = null;
            this.graphPage = 0;
            this.recompile();
            this.schedulePreview(loop, tr);
            rerender();
          }),
        mkAction("⧉ Copy", "Copy this loop to another row", () => this.openCopyLoopMenu(loop)),
      );
      sheet.append(actions);
    }

    overlay.append(sheet);
    this.root.append(overlay);
    // In-place rebuild: stay where the user was scrolled to.
    if (sameView && prevScroll) sheet.scrollTop = prevScroll;
  }

  /** A back header for a Loop-tab sub-panel (⚙ Options / Accents), returning to the grid. */
  private subPanelHead(title: string, back: () => void): HTMLElement {
    const row = document.createElement("div");
    row.className = "loop-sub-head";
    const b = document.createElement("button");
    b.className = "mixer-back";
    b.textContent = "‹ Back";
    b.onclick = back;
    const t = document.createElement("span");
    t.className = "placement-lbl transition-head";
    t.textContent = title;
    row.append(b, t);
    return row;
  }

  /** The Loop tab's SEQUENCER grid: the pattern's steps laid out like a step sequencer,
      hits highlighted. Tapping a step toggles it — the edit becomes a pattern OVERRIDE
      (`patternOv`) that replaces the Euclid derivation until the circles are touched
      again (editing them clears it); ↺ Euclid drops the override immediately. */
  private patternGrid(loop: Loop, rerender: () => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "pattern-grid-wrap";
    wrap.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#808080");
    const steps = loop.steps >= 1 ? loop.steps : 0;
    if (steps < 1) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Give the loop some steps first (the circles above).";
      wrap.append(hint);
      return wrap;
    }
    const cur: number[] = loop.patternOv && loop.patternOv.length === steps
      ? loop.patternOv.slice()
      : voicePattern(loop.hits, steps, loop.rotation, loop.split).map((b) => (b ? 1 : 0));

    const head = document.createElement("div");
    head.className = "place-grid-head";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = "Pattern";
    const readout = document.createElement("span");
    readout.className = "place-grid-readout";
    const hits = cur.reduce((a, b) => a + b, 0);
    readout.textContent = `${hits} hit${hits === 1 ? "" : "s"} · ${steps} steps${loop.patternOv ? " · edited" : ""}`;
    const euc = document.createElement("button");
    euc.className = "place-grid-rowbtn pattern-euclid";
    euc.textContent = "↺";
    euc.title = "Back to the Euclid pattern (drop the hand edits)";
    euc.disabled = !loop.patternOv;
    euc.onclick = () => { loop.patternOv = undefined; this.recompile(); rerender(); };
    head.append(lbl, readout, euc);
    wrap.append(head);

    const grid = document.createElement("div");
    grid.className = "pattern-grid";
    grid.style.setProperty("--cols", String(Math.min(16, steps)));
    const cells: HTMLElement[] = [];
    for (let i = 0; i < steps; i++) {
      const cell = document.createElement("button");
      cell.className = "pattern-cell" + (cur[i] ? " on" : "") + (i % 4 === 0 ? " beat" : "");
      cell.title = `Step ${i + 1}`;
      cell.onclick = () => {
        const next = cur.slice();
        next[i] = next[i] ? 0 : 1;
        loop.patternOv = next;
        loop.hits = next.reduce((a, b) => a + b, 0); // keep the circles honest
        this.recompile();
        rerender();
      };
      grid.append(cell);
      cells.push(cell);
    }
    wrap.append(grid);
    // Let the transport light the sounding step live (the popup shows only this loop).
    this.patternPlayCells = cells;
    this.patternPlaySteps = steps;
    this.lightPatternStep(-1);
    return wrap;
  }

  /** Toggle the `.playing` class onto the open pattern grid's step `i` (‑1 = none). */
  private lightPatternStep(i: number): void {
    if (!this.patternPlayCells) return;
    for (let k = 0; k < this.patternPlayCells.length; k++) {
      this.patternPlayCells[k].classList.toggle("playing", k === i);
    }
  }

  /** The shared bar-SQUARE grid (8 squares per row): the voice's all-loops grid and a
      transition's Bars tab both use it. Each square is worth 1 / 2 / 4 / 8 bars (the
      per-grid squares picker). Tap toggles a square; drag paints a contiguous run on/off;
      the ⇱⇲ button arms a Start→End pick — the FIRST tap resets the grid and marks the
      start, the SECOND fills straight through to the end. Squares in `occupied` carry the
      faint stripe (context: other loops' bars, or — on a transition — where this loop
      itself sounds), and `underlay` may additionally PAINT an unselected square in another
      loop's own shade, which is what makes the voice grid show all its loops at once.
      With `grow`, painting past the track lengthens it (loop placement only); otherwise
      the grid is clamped to the track. */
  private barGrid(cfg: {
    key: "place" | "trans" | "range";
    color: string;
    read: () => number[];
    write: (bars: number[]) => void; // live during a drag (engine follows along)
    commit: () => void;              // on release → full popup rebuild
    occupied: Set<number>;
    grow: boolean;
    /** Colour for a square this grid doesn't own, by its first bar (1-based). Called from
        paint(), which runs on every pointermove — index a precomputed table, don't walk. */
    underlay?: (barStart: number, span: number) => string | null;
  }): HTMLElement {
    const COLS = 8;
    const SPAN = Math.max(1, this.gridSpan[cfg.key]);
    const barsPerRow = COLS * SPAN;
    const barLimit = Math.max(1, this.track.barLimit);
    const needRows = Math.ceil(barLimit / barsPerRow); // rows the track itself fills
    const maxRows = cfg.grow ? Math.ceil(512 / barsPerRow) : needRows;
    // The track's own rows, plus whatever the user added past its end (see
    // placeGridExtraRows). A growable grid never shows FEWER rows than the track needs.
    const rows = Math.min(maxRows, needRows + (cfg.grow ? this.placeGridExtraRows : 0));
    const total = rows * COLS;
    const picking = this.gridPick?.key === cfg.key ? this.gridPick : null;

    const wrap = document.createElement("div");
    wrap.className = "place-grid-wrap";
    wrap.style.setProperty("--vc", cfg.color);

    const head = document.createElement("div");
    head.className = "place-grid-head";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = "Bars";
    const readout = document.createElement("span");
    readout.className = "place-grid-readout";
    const clear = document.createElement("button");
    clear.className = "play-range-clear";
    clear.textContent = "✕";
    clear.title = "Clear all bars";
    const syncHead = () => {
      const bs = cfg.read();
      // While a Start→End pick is armed, the readout walks the user through it. The live
      // track length rides along on the growing grid (the top-bar pill is hidden here).
      const pick = this.gridPick?.key === cfg.key ? this.gridPick : null;
      readout.textContent = pick
        ? (pick.start < 1 ? "tap the START square" : `start bar ${pick.start} — tap the END square`)
        : bs.length
          ? `${bs.length} bar${bs.length === 1 ? "" : "s"}${cfg.grow ? ` · track ${this.track.barLimit}` : ""}`
          : "tap or drag to place";
      clear.disabled = bs.length === 0;
    };
    clear.onclick = () => { cfg.write([]); cfg.commit(); };
    head.append(lbl, readout, clear);
    wrap.append(head);

    // Tool row: the squares' bar worth (1 / 2 / 4 / 8), the Start→End pick, the row stepper.
    const tools = document.createElement("div");
    tools.className = "place-grid-tools";
    const spanCtl = document.createElement("span");
    spanCtl.className = "place-grid-rowctl";
    const spanLbl = document.createElement("span");
    spanLbl.className = "place-grid-rowsn";
    spanLbl.textContent = "square =";
    spanCtl.append(spanLbl);
    for (const s of [1, 2, 4, 8]) {
      const b = document.createElement("button");
      b.className = "place-grid-rowbtn span-btn" + (SPAN === s ? " on" : "");
      b.textContent = String(s);
      b.title = `Each square counts as ${s} bar${s === 1 ? "" : "s"}`;
      b.onclick = () => { this.gridSpan[cfg.key] = s; cfg.commit(); };
      spanCtl.append(b);
    }
    const barsWord = document.createElement("span");
    barsWord.className = "place-grid-rowsn";
    barsWord.textContent = SPAN === 1 ? "bar" : "bars";
    spanCtl.append(barsWord);
    tools.append(spanCtl);

    const pickBtn = document.createElement("button");
    pickBtn.className = "place-grid-rowbtn pick-btn" + (picking ? " on" : "");
    pickBtn.textContent = "⇱⇲ Start · End";
    pickBtn.title = "Pick a start square (resets the grid), then an end square — the run in between fills in";
    pickBtn.onclick = () => {
      this.gridPick = picking ? null : { key: cfg.key, start: 0 };
      cfg.commit();
    };
    tools.append(pickBtn);

    if (cfg.grow) {
      const rowCtl = document.createElement("span");
      rowCtl.className = "place-grid-rowctl";
      const mkStep = (txt: string, delta: number, atLimit: boolean) => {
        const b = document.createElement("button");
        b.className = "place-grid-rowbtn";
        b.textContent = txt;
        b.title = delta < 0 ? "Fewer rows" : "More rows";
        b.disabled = atLimit;
        b.onclick = () => { this.placeGridExtraRows = Math.max(0, rows - needRows + delta); cfg.commit(); };
        return b;
      };
      const rowsLbl = document.createElement("span");
      rowsLbl.className = "place-grid-rowsn";
      rowsLbl.textContent = `${rows} row${rows === 1 ? "" : "s"}`;
      rowsLbl.title = `${rows * barsPerRow} bars shown`;
      rowCtl.append(mkStep("−", -1, rows <= Math.max(1, needRows)), rowsLbl, mkStep("+", 1, rows >= maxRows));
      tools.append(rowCtl);
    }
    wrap.append(tools);

    const grid = document.createElement("div");
    grid.className = "place-grid" + (picking ? " picking" : "");
    grid.style.setProperty("--cols", String(COLS));
    const cells: HTMLElement[] = [];
    for (let i = 0; i < total; i++) {
      const bar = i * SPAN + 1; // first bar of this square's block
      const cell = document.createElement("div");
      cell.className = "place-cell"
        + (bar > barLimit ? " out" : "")
        + ((i % COLS) === 0 ? " rowstart" : "")
        + (((bar - 1) % 4) === 0 ? " beat" : "");
      cell.dataset.bar = String(bar);
      for (let b = bar; b < bar + SPAN; b++) if (cfg.occupied.has(b)) { cell.classList.add("occ"); break; }
      cells.push(cell);
      grid.append(cell);
    }
    const paint = (set: Set<number>) => {
      for (let i = 0; i < total; i++) {
        const first = i * SPAN + 1;
        let cnt = 0;
        for (let b = first; b < first + SPAN; b++) if (set.has(b)) cnt++;
        cells[i].classList.toggle("sel", cnt === SPAN);
        cells[i].classList.toggle("part", cnt > 0 && cnt < SPAN);
        // A square this grid doesn't own shows whoever does own it (the voice grid's other
        // loops); one it does own goes back to the plain field under its own fill.
        if (cfg.underlay) {
          const other = cnt === 0 ? cfg.underlay(first, SPAN) : null;
          cells[i].style.backgroundColor = other ?? "";
        }
      }
    };
    paint(new Set(cfg.read()));
    wrap.append(grid);
    syncHead();

    const clampBars = (bars: number[]): number[] =>
      cfg.grow ? bars.filter((b) => b <= 512) : bars.filter((b) => b <= barLimit);

    // Start→End pick: two taps instead of painting.
    const pickTap = (bar: number): void => {
      const pick = this.gridPick;
      if (!pick || pick.key !== cfg.key) return;
      if (pick.start < 1) {
        // First tap: reset the grid and mark the start square.
        pick.start = bar;
        const bars = clampBars(Array.from({ length: SPAN }, (_, k) => bar + k));
        cfg.write(bars);
        paint(new Set(bars));
        syncHead();
        return;
      }
      // Second tap: fill straight through start → end (either direction).
      const lo = Math.min(pick.start, bar);
      const hi = Math.max(pick.start, bar) + SPAN - 1;
      const bars = clampBars(Array.from({ length: hi - lo + 1 }, (_, k) => lo + k));
      this.gridPick = null;
      cfg.write(bars);
      cfg.commit();
    };

    // Drag paints the linear square range [anchor..bar] to the anchor's inverse state,
    // from a pre-drag snapshot (so back-and-forth doesn't accumulate). Anchors are block
    // START bars (what dataset.bar holds), so the walk steps by SPAN and each square
    // toggles all of its bars. elementFromPoint reads the cell under the pointer (robust
    // to the grid gaps).
    const barAt = (x: number, y: number): number | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const bAttr = el?.closest(".place-cell") as HTMLElement | null;
      return bAttr?.dataset.bar ? Number(bAttr.dataset.bar) : null;
    };
    let base = new Set<number>();
    let anchor = 0, paintOn = true, lastBar = 0;
    const commitLive = (set: Set<number>) => {
      cfg.write(clampBars([...set].sort((a, b) => a - b)));
      syncHead();
    };
    const applyTo = (bar: number) => {
      const lo = Math.min(anchor, bar), hi = Math.max(anchor, bar);
      const next = new Set(base);
      for (let s = lo; s <= hi; s += SPAN) {
        for (let b = s; b < s + SPAN; b++) { if (paintOn) next.add(b); else next.delete(b); }
      }
      paint(next);
      return next;
    };
    const onMove = (e: PointerEvent) => {
      const bar = barAt(e.clientX, e.clientY);
      if (bar === null || bar === lastBar) return;
      lastBar = bar;
      commitLive(applyTo(bar));
    };
    const onUp = (e: PointerEvent) => {
      grid.removeEventListener("pointermove", onMove);
      grid.removeEventListener("pointerup", onUp);
      grid.removeEventListener("pointercancel", onUp);
      try { grid.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      cfg.commit(); // rebuild (the track may have grown → more rows)
    };
    grid.onpointerdown = (e) => {
      const bar = barAt(e.clientX, e.clientY);
      if (bar === null) return;
      e.preventDefault();
      if (this.gridPick?.key === cfg.key) { pickTap(bar); return; }
      base = new Set(cfg.read());
      anchor = bar; lastBar = bar;
      // A square with ANY of its bars placed erases on tap (so partial squares clear).
      paintOn = true;
      for (let b = bar; b < bar + SPAN; b++) if (base.has(b)) { paintOn = false; break; }
      commitLive(applyTo(bar));
      try { grid.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      grid.addEventListener("pointermove", onMove);
      grid.addEventListener("pointerup", onUp);
      grid.addEventListener("pointercancel", onUp);
    };
    return wrap;
  }

  /** The voice's ALL-LOOPS grid, from the picked loop's point of view: its own bars are
      the selection you paint, and every OTHER loop of the colour shows underneath in its
      own shade (the same ramp as the track column, so the grid and the column read as the
      same picture). Editing sets the rule to "At bars" (seeded from the current placement,
      so switching from an algorithmic rule keeps its bars); painting past the track end
      GROWS the track. Squares another loop covers also carry the clash stripe, which is
      what shows when the picked loop is painted over one of them. */
  private placementGrid(loop: Loop, rerender: () => void): HTMLElement {
    const barLimit = Math.max(1, this.track.barLimit);
    const c = this.colorOf(loop);

    // This loop's placement as an explicit bar set (start bars). Seed from placementsFor so
    // an algorithmic rule shows its bars and converts cleanly to a manual list on edit.
    const ownList = () => loop.rule.every.kind === "at"
      ? (loop.rule.every as { bars: number[] }).bars.slice()
      : placementsFor(loop, barLimit).map((iv) => iv.startBar + 1);

    // One walk over the siblings fills both: the clash stripe set, and the per-bar shade
    // table the underlay indexes. Earliest loop wins a bar (list order = priority, as
    // resolveLane resolves it), so the grid shows what will actually sound.
    const occupied = new Set<number>();
    const shades: (string | null)[] = new Array(barLimit + 1).fill(null);
    (this.track.colors[c]?.loops ?? []).forEach((other, n) => {
      if (other === loop || other.soundId < 0) return;
      const shade = this.loopShade(c, n + 1);
      for (const iv of placementsFor(other, barLimit)) {
        for (let b = iv.startBar; b < iv.startBar + iv.forBars && b < barLimit; b++) {
          occupied.add(b + 1);
          if (shades[b + 1] === null) shades[b + 1] = shade;
        }
      }
    });

    return this.barGrid({
      key: "place",
      color: loop.soundId >= 0 ? loop.color : "#808080",
      read: ownList,
      // A square shows the first sibling anywhere inside it — at square = 8 bars a loop on
      // one bar of the eight still has to be visible.
      underlay: (first, span) => {
        for (let b = first; b < first + span && b <= barLimit; b++) if (shades[b]) return shades[b];
        return null;
      },
      write: (bars) => {
        // Painting past the track grows it to fit the furthest placed bar.
        const max = bars.length ? bars[bars.length - 1] : 0;
        if (max > this.track.barLimit) this.track.barLimit = Math.min(512, max);
        loop.rule.every = { kind: "at", bars };
        this.recompile();
      },
      commit: rerender,
      occupied,
      grow: true,
    });
  }

  /** A transition's Bars tab grid: WHERE the transition runs. The stripes mark where the
      loop itself sounds (context — the default selection is exactly its full loop). */
  private transBarsGrid(loop: Loop, tr: LoopTransition, rerender: () => void): HTMLElement {
    const barLimit = Math.max(1, this.track.barLimit);
    const occupied = new Set<number>();
    for (const iv of placementsFor(loop, barLimit)) {
      for (let b = iv.startBar; b < iv.startBar + iv.forBars && b < barLimit; b++) occupied.add(b + 1);
    }
    return this.barGrid({
      key: "trans",
      color: loop.soundId >= 0 ? loop.color : "#808080",
      read: () => tr.bars.filter((b) => b >= 1 && b <= barLimit),
      write: (bars) => {
        tr.bars = bars;
        this.recompile();
        this.schedulePreview(loop, tr);
      },
      commit: rerender,
      occupied,
      grow: false,
    });
  }

  /** A small picker over the loop popup: tap a coloured row to drop an independent copy of
      this loop there (its own sound id, so the two never share an engine sound). The copy
      is the WHOLE loop — rhythm, sound, options and its transitions ride along (cloneLoop
      deep-copies them), which the title spells out so it's clear before the tap. */
  private openCopyLoopMenu(loop: Loop): void {
    const trs = loop.transitions?.length ?? 0;
    this.openCopyMenu(
      trs ? `Copy loop + ${trs} transition${trs === 1 ? "" : "s"} to…` : "Copy loop to…",
      (c) => this.copyLoopTo(loop, c),
      this.colorOf(loop),
    );
  }

  /** The shared "which voice?" picker: one row per colour with its loop count, calling
      `pick` with the chosen colour index. `from` marks the row the copy comes from. */
  private openCopyMenu(titleText: string, pick: (target: number) => void, from = -1): void {
    document.querySelector(".copy-menu-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "copy-menu-overlay";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    const card = document.createElement("div");
    card.className = "copy-menu-card";
    const title = document.createElement("h3");
    title.className = "tr-title";
    title.textContent = titleText;
    card.append(title);

    for (let c = 0; c < NUM_LINES; c++) {
      const n = this.track.colors[c].loops.length;
      const row = document.createElement("button");
      row.className = "copy-menu-row";
      row.style.setProperty("--vc", VOICE_COLORS[c]);
      const dot = document.createElement("span");
      dot.className = "copy-menu-dot";
      const name = document.createElement("span");
      name.className = "copy-menu-name";
      name.textContent = `Voice ${c + 1}${c === from ? " (this row)" : ""}`;
      const count = document.createElement("span");
      count.className = "copy-menu-count";
      count.textContent = n === 0 ? "empty" : `${n} loop${n === 1 ? "" : "s"}`;
      row.append(dot, name, count);
      row.onclick = () => { overlay.remove(); pick(c); };
      card.append(row);
    }

    const close = document.createElement("button");
    close.className = "tr-cancel";
    close.textContent = "Cancel";
    close.onclick = () => overlay.remove();
    card.append(close);
    overlay.append(card);
    this.root.append(overlay);
  }

  /** Append an independent copy of `loop` to colour `target` (own sound id + editor), then
      resend sounds/lanes. The clone carries the loop's transitions with it, on the same
      bars — they're part of the loop, not of the row. Leaves the current popup as-is
      (least disruptive) and toasts. */
  private copyLoopTo(loop: Loop, target: number): void {
    const clone = cloneLoop(loop);
    clone.color = VOICE_COLORS[target % VOICE_COLORS.length];
    if (clone.soundId >= 0) clone.soundId = this.nextSoundId++; // its own engine sound entry
    this.track.colors[target].loops.push(clone);
    this.pushSounds();  // register the clone's sound before it's asked to play
    this.recompile();
    this.render();      // the loop list / previews may be visible under the popup
    const trs = clone.transitions?.length ?? 0;
    this.toast(trs
      ? `Copied to Voice ${target + 1} with ${trs} transition${trs === 1 ? "" : "s"}`
      : `Copied to Voice ${target + 1}`);
  }

  // --- THE SOUND GRAPH: the sound's settings as coloured time functions --

  /** The ? glossary for the sound graph itself. */
  private static readonly SOUND_GRAPH_HELP: HelpItem[] = [
    {
      name: "The graph",
      desc: "Every ACTIVE setting of this sound drawn as its own coloured function of time — the pitch sweep settling onto its base pitch, the amp envelope, each layer's decay, the LFO wobbles, the echo's dying repeats, steady settings as level lines. Settings that persist run the whole axis; ones that genuinely end stop where they end (their formula states the domain, t < …). A setting at zero level is inactive and isn't drawn.",
    },
    {
      name: "The time axis",
      desc: "Seconds across the bottom. It sizes itself to the longest active setting (a 1s echo stretches it to show the tail) — or set the limit number in the corner to pin it (0 = automatic).",
    },
    {
      name: "The setting buttons",
      desc: "One coloured button per setting, matching its line. The first page is the ACTIVE settings; ‹ › pages through the inactive ones (drawn dashed). Every corner of the engine is here — the oscillators (Tone, Osc 2, Unison, Wavetable, FM/Ring), the noise and click layers, the filter and its resonators (Comb, Modal), the three LFOs, the effects (Drive, Fold, Bitcrush, Echo, Reverb, Mod FX) and per-hit Life. Tap one to open its formula: every value is editable inline (tap = keypad, drag = scrub), with its own ? explaining the function and the engine code behind it. Give an inactive setting's level a value and its line springs to life on the graph.",
    },
    {
      name: "The toolbar",
      desc: "The line above the graph. 🎲 (highlighted) shuffles a whole new sound — every setting redrawn at once, watch the graph redraw; ↩ steps back through previous shuffles; ↺ resets to the default sound (continuous values centred, types and levels at their defaults). Tapping the graph itself plays the current sound (no loop needed). The ? on the far right opens this glossary.",
    },
    {
      name: "Gate / Max len / Spread",
      desc: "Beside the buttons on the toolbar. GATE — how many seconds each hit is held before release (long gates make drones; the amp line follows it). MAX LEN — a shuffled sound is trimmed to at most this long, keeping hits punchy (Off = untrimmed). SPREAD — how the shuffle spreads its pitch & filter draws: linear, log, or weighted toward bass / mid / high. Max len and Spread shape the NEXT 🎲, not the current sound.",
    },
    {
      name: "▤ The other two layouts",
      desc: "The same sound, read two other ways. ▤ THE SHEET: no graph and no functions, every setting listed as a number instead — use it when you know which setting you want and just want to reach it. ◫ THE DECK: one section of the engine at a time, filling the screen, with every setting shown in full — a choice list as a list you drag across, a number as a bar. The toolbar button cycles graph → sheet → deck → graph, so ∿ always comes back here.",
    },
  ];

  private static readonly SOUND_SHEET_HELP: HelpItem[] = [
    {
      name: "The sheet",
      desc: "Every setting of this sound as one row — the whole engine on one screen, in the order the signal runs through it. Nothing is hidden and nothing is drawn: this is the same sound the graph shows, read as numbers instead of curves. The toolbar button cycles on to ◫ the deck, and from there back to ∿ the graph.",
    },
    {
      name: "Changing a value",
      desc: "Hold a value and drag UP or DOWN to scrub it — the sound updates as you drag, and plays when you let go. Or tap it once to type an exact number on the keypad. Values are clamped to what the engine accepts, so you cannot type something it can't play.",
    },
    {
      name: "Choices scrub too",
      desc: "A setting that picks from a list (Wave, Noise Col, Material, Mod FX, an LFO's Dest…) works exactly like a number: drag through Sine / Square / Saw the way you drag through hertz. That's why there are no dropdowns — a list costs the same one row as everything else.",
    },
    {
      name: "What's actually on",
      desc: "A row with a sunken white field is AUDIBLE — it is reaching the output right now. A flat, dim row is a setting that exists but isn't sounding: a comb at zero mix, an LFO routed to None, a wavetable switched off. It still holds a real value and you can still edit it; give it a level and it lights up. This is the same test the graph uses to decide whether to draw a curve, so the two layouts always agree.",
    },
    {
      name: "The blocks",
      desc: "Rows are grouped by what they belong to (Pitch, Tone, Noise, Comb, Modal, the three LFOs, the FX chain, Per-Hit Life…), and a heading lights up in the voice colour once anything under it is sounding — so you can read what a shuffle actually built from the headings alone. A block's own word is dropped from its rows: under ECHO, \"Echo Time\" is just \"Time\". Tap any row and the keypad shows its full name.",
    },
    {
      name: "The drawn pitch contour",
      desc: "The one thing not on the sheet. Setting Pitch Shape to \"Drawn\" plays a curve you draw by hand rather than a formula, and its 32 stored points are samples of that drawing, not settings — they're authored by drawing, from the graph's Pitch trace.",
    },
  ];

  private static readonly SOUND_DECK_HELP: HelpItem[] = [
    {
      name: "The deck",
      desc: "The same sound as the graph and the sheet, but one section of the engine at a time, filling the screen. Where the sheet fits everything at once by giving each setting a single line, the deck spends the whole screen on one section — so nothing has to be read blind. The toolbar button cycles on to ∿ the graph.",
    },
    {
      name: "The section buttons",
      desc: "Along the bottom: one button per part of the engine — Pitch, Tone, Noise, the oscillators and shapers, Click, the Comb and Modal resonators, the three LFOs, the FX chain, the amp envelope, the filter, Per-Hit Life and Output. Tap one to open it above. A button lit in the voice colour has something sounding in it, so the strip alone reads what a shuffle built — the same test the sheet's headings use.",
    },
    {
      name: "Lists you drag across",
      desc: "A setting that picks from a list (Wave, Noise Col, Material, Mod FX, an LFO's Dest…) shows EVERY option, not just the current one. Press anywhere on the list and slide: the choice follows your finger and the sound changes as it goes, so you can hear your way along the row instead of picking blind. Let go and it plays. Tapping a single option picks it outright.",
    },
    {
      name: "Bars you drag along",
      desc: "Everything else is a bar showing where the value sits in the range the engine allows. Press anywhere on it — the value jumps to your finger and follows it, updating live — and let go to hear it. Tap without sliding to type an exact number on the keypad instead.",
    },
    {
      name: "New loops start as drones",
      desc: "Add a loop while this layout is open and it arrives as a DRONE rather than a shuffled drum hit: the gate held for seconds with the sustain up under it, an eased attack and release, and the hit machinery (click, noise, ratchet) at zero. That's the sound this screen is for — one long note you shape while it holds. ∞ on the toolbar turns any existing sound into one, and ↩ takes it back. Sounds you already have are never overwritten by opening this screen.",
    },
    {
      name: "What's actually on",
      desc: "A dim row is a setting that exists but isn't sounding — a comb at zero mix, an LFO routed to None. It still holds a real value and you can still edit it; give it a level and it lights up, here and on the graph alike.",
    },
  ];

  /** A sound-graph panel host: the two graphs (a loop's own sound, and a transition's
      TRANSFORMED sound) share the whole surface — only where edits land differs. */
  private graphHostForLoop(loop: Loop, rerender: () => void): SoundGraphHost {
    const draft = this.draftFor(loop);
    return {
      draft,
      color: loop.soundId >= 0 ? loop.color : "#808080",
      title: "Every setting as a function of time",
      write: () => this.writeLoopFromEditor(loop),
      commitAudition: () => this.auditionLoop(loop),
      // Whole-sound replacements re-level offline before the audition.
      replace: async () => {
        await this.writeAndNormalizeLoop(loop);
        this.auditionLoop(loop);
        rerender();
      },
      resetTitle: "Reset to the preset",
      reset: () => draft.reset(),
      lifeLoop: loop,
    };
  }

  private graphHostForTransition(loop: Loop, tr: LoopTransition, rerender: () => void): SoundGraphHost {
    const draft = this.transitionDraftFor(loop, tr);
    // The draft writes through to tr.snapshot, so this is just the rest of the path.
    const write = () => {
      this.recompile();
      this.schedulePreview(loop, tr);
    };
    // The ⧉ "copy transformed sound as a new loop" action lives in the popup header.
    return {
      draft,
      color: loop.soundId >= 0 ? loop.color : "#808080",
      title: "The transformed sound — the transition's end values",
      write,
      commitAudition: () => this.schedulePreview(loop, tr, true),
      replace: () => {
        write();
        rerender();
      },
      // Reset is about the VALUES; Reverse is a separate axis and survives it.
      resetTitle: "Reset to the untransformed sound (no change) — Reverse stays as it is",
      reset: () => draft.restore(loop.snapshot),
    };
  }

  /** One toolbar button, in the corner-button footprint both sound layouts use. */
  private toolBtn(glyph: string, title: string, fn: () => void, extra = "", disabled = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "graph-corner-btn" + (extra ? " " + extra : "");
    b.textContent = glyph;
    b.title = title;
    b.disabled = disabled;
    b.onclick = fn;
    return b;
  }

  /** The SOUND panel, in whichever layout is selected: the graph (functions drawn over
      time), the sheet (every parameter as a row) or the deck (one section at a time, every
      setting shown in full). All three edit the same draft through the same host, so the
      choice is purely how you'd rather read and reach the values.
      Hosted by a loop's own sound OR a transition's transformed sound. */
  private soundPanel(host: SoundGraphHost, rerender: () => void): HTMLElement {
    if (this.soundLayout === "sheet") return this.soundSheetPanel(host, rerender);
    if (this.soundLayout === "deck") return this.soundDeckPanel(host, rerender);
    return this.soundGraphPanel(host, rerender);
  }

  // The layout cycle, and what the toolbar button says while you are in each one: the
  // glyph and title name where the button GOES, never where you are.
  private static readonly LAYOUT_NEXT: Record<SoundLayout, { next: SoundLayout; glyph: string; title: string }> = {
    graph: { next: "sheet", glyph: "▤", title: "Switch to the parameter sheet — every setting as a number" },
    sheet: { next: "deck", glyph: "◫", title: "Switch to the deck — one section at a time, every setting in full" },
    deck: { next: "graph", glyph: "∿", title: "Switch to the sound graph — every setting as a curve" },
  };

  /** The line above either sound layout: host extras (the ⧉ copy), Back / Reset, the
      shuffle settings (Volume / Gate / Max len / Spread), the layout toggle and the ?.
      `withDice` puts the Shuffle here — the graph layout instead floats it on the
      graph's own top-right corner, where there is a spare corner to put it. */
  private soundToolbar(host: SoundGraphHost, rerender: () => void, withDice: boolean): HTMLElement {
    const p = host.draft;
    const get: ParamGet = (id) => p.get(id);
    const bar = document.createElement("div");
    bar.className = "graph-toolbar";
    const mkTool = (glyph: string, title2: string, fn: () => void, extra = "", disabled = false) =>
      this.toolBtn(glyph, title2, fn, extra, disabled);

    // LAYOUT leads the toolbar. Everything after it can scroll out of reach on a narrow
    // screen (the bar is wider than a phone), and the one control that must never do that
    // is the one that gets you back to the other layout.
    const onGraph = this.soundLayout === "graph";
    const step = App.LAYOUT_NEXT[this.soundLayout];
    bar.append(this.toolBtn(step.glyph, step.title, () => {
      this.soundLayout = step.next;
      this.graphTrace = null; // the graph always comes back on its buttons
      rerender();
    }, "graph-tool-layout"));

    for (const el of host.extraCorner ?? []) bar.append(el);
    bar.append(
      mkTool("↩", "Back to the previous sound", () => {
        if (p.undo()) void host.replace();
      }, "", !p.canUndo()),
      mkTool("↺", host.resetTitle, () => {
        host.reset();
        void host.replace();
      }),
    );
    // The deck's own starting point, stamped on demand — ∞ for the note that doesn't end.
    // A loop ADDED while the deck is open is already minted as one (see mintLoopSound);
    // this is how any other sound becomes one. It lights up while the sound on screen IS a
    // drone, so the button reports as well as acts: shuffle the drone away and it goes out.
    if (this.soundLayout === "deck") {
      const isDrone = p.isDrone();
      bar.append(mkTool("∞",
        isDrone ? "This sound is a held drone — press to start a fresh one"
                : "Start again from the drone — one long held note, no hit",
        () => {
          // The hold is fitted to the gap between this loop's own hits, as the mint does.
          p.resetToDrone(host.lifeLoop ? this.loopGapSeconds(host.lifeLoop) : undefined);
          void host.replace();
        },
        "graph-tool-drone" + (isDrone ? " on" : "")));
    }
    if (withDice) {
      bar.append(mkTool("🎲", "Shuffle a new sound", () => {
        p.shuffle(this.shuffleContext());
        void host.replace();
      }, "graph-tool-dice"));
    }
    // VOL: the sound's overall level (0–100%). On a transition it's the morph target, so
    // dropping it fades the sound out (or up) across the transition.
    bar.append(this.graphCornerNum("vol", "Volume — the sound's overall level (drop it on a transition to fade)",
      () => Math.round(get(ParamId.Volume) * 100),
      (n) => {
        p.set(ParamId.Volume, Math.max(0, Math.min(1, n / 100)));
        host.write();
      },
      () => `${Math.round(get(ParamId.Volume) * 100)}%`,
      () => { host.commitAudition(); rerender(); },
      5,
    ));
    // GATE: the note-hold in seconds (0 = the sequencer default 0.4s) — the drone knob.
    bar.append(this.graphCornerNum("gate", "Gate — seconds each hit is held before release",
      () => Math.round(get(ParamId.Gate) * 100) / 100,
      (n) => {
        p.set(ParamId.Gate, Math.max(0, n));
        host.write();
      },
      () => {
        const g = get(ParamId.Gate);
        return g > 0 ? `${Math.round(g * 100) / 100}s` : "auto";
      },
      () => { host.commitAudition(); rerender(); },
      0.05,
    ));
    // MAX LEN: the shuffle's audible-length cap — the next 🎲 trims tails to fit.
    bar.append(this.graphCornerSelect("max len",
      "Max length — a shuffled sound is trimmed to at most this long (applies to the next 🎲)",
      MAXLEN_OPTIONS.map((o) => o.label),
      () => maxLenOptionIndex(p.maxLen),
      (i) => { p.maxLen = MAXLEN_OPTIONS[i].seconds; },
    ));
    // SPREAD: how the shuffle distributes pitch/cutoff draws across the range.
    bar.append(this.graphCornerSelect("spread",
      "Spread — how the shuffle spreads pitch & filter draws (applies to the next 🎲)",
      CURVE_OPTIONS.map((o) => o.label),
      () => curveOptionIndex(p.curve),
      (i) => { p.curve = CURVE_OPTIONS[i].curve; },
    ));
    const help = helpButton(
      onGraph ? "The sound graph" : this.soundLayout === "deck" ? "The deck" : "The parameter sheet",
      onGraph ? App.SOUND_GRAPH_HELP
        : this.soundLayout === "deck" ? App.SOUND_DECK_HELP : App.SOUND_SHEET_HELP,
    );
    help.classList.add("graph-tool-help");
    bar.append(help);
    return bar;
  }

  /** The sound-graph panel: a big graph (every ACTIVE setting drawn as its own coloured
      time function; the x axis stretches to the longest one), the Shuffle on its top-right
      corner, and — below — either the coloured trace buttons (paged: active first, ‹ ›
      through the inactive ones) or, when a trace is tapped, its EQUATION with the values
      inline. */
  private soundGraphPanel(host: SoundGraphHost, rerender: () => void): HTMLElement {
    const p = host.draft;
    const get: ParamGet = (id) => p.get(id);

    const wrap = document.createElement("div");
    wrap.className = "sound-graph";
    wrap.style.setProperty("--vc", host.color);

    const sel = this.graphTrace ? SOUND_TRACES.find((t) => t.id === this.graphTrace) ?? null : null;
    wrap.append(this.soundToolbar(host, rerender, false));

    const mkTool = (glyph: string, title2: string, fn: () => void, extra = "") =>
      this.toolBtn(glyph, title2, fn, extra);

    // The graph. Tapping it (anywhere but the shuffle) auditions the current sound.
    const box = document.createElement("div");
    box.className = "sound-graph-box";
    const svg = this.soundGraphSvg(get, sel);
    svg.classList.add("graph-tappable");
    svg.addEventListener("click", () => this.auditionDraft(p));
    box.append(svg);
    // The Shuffle sits on the graph's top-right corner and stands out (voice colour).
    const dice = mkTool("🎲", "Shuffle a new sound", () => {
      p.shuffle(this.shuffleContext());
      void host.replace();
    }, "graph-tool-dice graph-dice-corner");
    box.append(dice);
    wrap.append(box);

    if (sel) wrap.append(this.traceEditor(host, sel, rerender));
    else wrap.append(this.traceButtons(get, rerender));
    return wrap;
  }

  /** The PARAMETER SHEET: the same sound with no graph, no functions and nothing drawn —
      just every setting as a `name  value` row, packed into columns dense enough to read
      a whole sound in one screenful.

      Every row behaves identically, continuous and discrete alike: hold and drag to
      scrub, tap to type on the numpad (attachScrub gives both). A choice list is simply
      a parameter whose value happens to have names, so Waveform scrubs through Sine /
      Square / Saw the way Cutoff scrubs through hertz, and neither one needs a dropdown
      or the space one would cost.

      Rows are grouped into short titled blocks (see {@link SHEET_BLOCK_TITLES}) that the
      CSS column layout keeps whole, so the sheet reflows from two columns to four with
      the groupings intact. The 32 PitchDraw slots are the one omission: they are samples
      of a drawn curve, not settings, and are authored in the path overlay. */
  private soundSheetPanel(host: SoundGraphHost, rerender: () => void): HTMLElement {
    const p = host.draft;
    const wrap = document.createElement("div");
    wrap.className = "sound-graph sound-sheet";
    wrap.style.setProperty("--vc", host.color);
    wrap.append(this.soundToolbar(host, rerender, true));

    const cols = document.createElement("div");
    cols.className = "ps-cols";

    const get: ParamGet = (id) => p.get(id);
    for (const section of SHEET_SECTIONS) {
      const block = document.createElement("div");
      block.className = "ps-block";
      const head = document.createElement("div");
      head.className = "ps-head";
      head.textContent = section.title;
      block.append(head);
      cols.append(block);

      for (const id of section.ids) {
        const spec = baseSpec(id);

        // ACTIVE = this setting is audible in the sound right now, by the same test the
        // graph uses to decide whether to draw its curve. An inactive row still holds a
        // real value you can edit — it just isn't reaching the output yet, so it recedes,
        // and its heading only lights up once something under it is doing something.
        const active = sectionRowActive(id, get);
        if (active) head.classList.add("on");

        const row = document.createElement("div");
        row.className = "ps-row" + (active ? "" : " ps-off");
        const name = document.createElement("span");
        name.className = "ps-name";
        name.textContent = sheetRowName(spec.name, section.strip);
        const inp = document.createElement("input");
        inp.type = "text";
        inp.readOnly = true;
        inp.inputMode = "none";
        inp.className = "ps-val";
        const show = () => sheetValue(spec, p.get(id));
        inp.value = show();
        this.attachScrub(inp, {
          label: spec.name, // the numpad gets the FULL name — no block heading over it
          color: host.color,
          read: () => p.get(id),
          write: (n) => {
            p.set(id, n);
            host.write();
          },
          show,
          commit: () => { host.commitAudition(); rerender(); },
          step: sheetStep(spec),
        });
        row.append(name, inp);
        block.append(row);
      }
    }

    wrap.append(cols);
    return wrap;
  }

  /** The DECK: the engine one section at a time, with the sections themselves along the
      bottom as buttons. Where the sheet fits the whole sound on one screen by giving every
      setting a single 18px line, the deck spends the whole screen on ONE section — which
      buys the thing neither other layout can afford: a setting shown IN FULL.

      A choice list is drawn as a list. On the sheet, dragging Waveform flicks one field
      through Sine / Tri / Square / Saw and you never see the options you are passing; here
      they are all on screen and you slide across them, hearing each one. A number is drawn
      as a bar, so where the value sits in the range the engine allows is visible rather
      than inferred from the digits.

      It is also the screen a DRONE is designed on — a sound you hold and shape while it
      rings, rather than a hit you fire. A loop added while this layout is open is minted
      as one instead of being shuffled (see {@link mintLoopSound}), and ∞ on the toolbar
      stamps it onto any sound. Nothing is applied on arrival here: a sound you already
      have is a sound you chose, and this screen is where you would come to work on it. */
  private soundDeckPanel(host: SoundGraphHost, rerender: () => void): HTMLElement {
    const p = host.draft;
    const wrap = document.createElement("div");
    wrap.className = "sound-graph sound-deck";
    wrap.style.setProperty("--vc", host.color);
    wrap.append(this.soundToolbar(host, rerender, true));

    const get: ParamGet = (id) => p.get(id);
    const idx = Math.max(0, Math.min(SHEET_SECTIONS.length - 1, this.deckSection));
    const section = SHEET_SECTIONS[idx];

    const panel = document.createElement("div");
    panel.className = "deck-panel";
    const head = document.createElement("div");
    head.className = "deck-head";
    head.textContent = section.title;
    panel.append(head);
    for (const id of section.ids) {
      const spec = baseSpec(id);
      const row = isDiscrete(spec)
        ? this.deckChoiceRow(host, rerender, id, spec, section.strip)
        : this.deckBarRow(host, rerender, id, spec, section.strip);
      // Dim what isn't reaching the output, by the sheet's own test — the value is still
      // real and still editable, it just isn't sounding yet.
      if (!sectionRowActive(id, get)) row.classList.add("deck-off");
      panel.append(row);
    }
    wrap.append(panel);

    // The sections, as the buttons that switch between them. A lit button has something
    // sounding inside it, so the strip reads like the sheet's headings do.
    const tabs = document.createElement("div");
    tabs.className = "deck-tabs";
    SHEET_SECTIONS.forEach((s, i) => {
      const b = document.createElement("button");
      b.className = "deck-tab"
        + (i === idx ? " on" : "")
        + (s.ids.some((id) => sectionRowActive(id, get)) ? " lit" : "");
      b.textContent = s.title;
      b.title = `${s.title} — ${s.ids.length} setting${s.ids.length === 1 ? "" : "s"}`;
      b.onclick = () => { this.deckSection = i; rerender(); };
      tabs.append(b);
    });
    wrap.append(tabs);
    return wrap;
  }

  /** One choice parameter on the deck: every option visible, and one press that slides
      across them. The write happens on press as well as on move, so a plain tap on an
      option picks it — the list is a row of buttons and a slider at the same time. */
  private deckChoiceRow(
    host: SoundGraphHost, rerender: () => void,
    id: ParamId, spec: ParamSpec, strip?: string,
  ): HTMLElement {
    const p = host.draft;
    const row = document.createElement("div");
    row.className = "deck-row deck-choice";
    const name = document.createElement("span");
    name.className = "deck-name";
    name.textContent = dropBlockWord(spec.name, strip);
    const list = document.createElement("div");
    list.className = "deck-list";

    // "Drawn" is not pickable as a label: choosing it without a drawing would just pin the
    // pitch flat, so it stays author-only (the graph's Pitch trace has the ✏ way in). The
    // options are therefore a SUBSET of the range, and each one carries its own value.
    const opts: { el: HTMLElement; value: number }[] = [];
    (spec.choices ?? []).forEach((label, i) => {
      if (id === ParamId.PitchEnvShape && i === PITCH_SHAPE_DRAWN) return;
      const el = document.createElement("span");
      el.className = "deck-opt";
      el.textContent = label;
      list.append(el);
      opts.push({ el, value: i });
    });
    const paint = () => {
      const v = Math.round(p.get(id));
      for (const o of opts) o.el.classList.toggle("on", o.value === v);
    };
    paint();

    this.attachDeckDrag(list, {
      downWrites: true,
      // Hit-test against the options themselves rather than dividing the width evenly:
      // they are laid out by their labels, so "Sine" and "Wavetable" are not the same
      // width and an even division would not line up with what is under the finger.
      at: (x) => {
        let best = opts[0];
        let bestD = Infinity;
        for (const o of opts) {
          const r = o.el.getBoundingClientRect();
          const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
          if (d < bestD) { bestD = d; best = o; }
        }
        if (!best || Math.round(p.get(id)) === best.value) return;
        p.set(id, best.value);
        host.write();
        paint();
      },
      commit: () => { host.commitAudition(); rerender(); },
    });

    row.append(name, list);
    return row;
  }

  /** One continuous parameter on the deck: a bar showing where the value sits in the range
      the engine allows, dragged along rather than scrubbed up and down. The position is
      ABSOLUTE — the value goes where the finger is — which is what makes the bar worth
      drawing; the numpad (tap, as everywhere else) is still how you land on an exact
      number. The mapping is the registry's own skew, so a bar reads the way that
      parameter's range is actually shaped. */
  private deckBarRow(
    host: SoundGraphHost, rerender: () => void,
    id: ParamId, spec: ParamSpec, strip?: string,
  ): HTMLElement {
    const p = host.draft;
    const row = document.createElement("div");
    row.className = "deck-row deck-bar";
    const name = document.createElement("span");
    name.className = "deck-name";
    name.textContent = dropBlockWord(spec.name, strip);
    const val = document.createElement("span");
    val.className = "deck-val";
    const track = document.createElement("div");
    track.className = "deck-track";
    const fill = document.createElement("div");
    fill.className = "deck-fill";
    track.append(fill);

    const paint = () => {
      const v = p.get(id);
      fill.style.width = `${valueToNorm(spec, v) * 100}%`;
      val.textContent = sheetValue(spec, v);
    };
    paint();

    this.attachDeckDrag(track, {
      downWrites: false, // a press alone must not move the value — that press may be a tap
      at: (x, rect) => {
        const norm = Math.max(0, Math.min(1, (x - rect.left) / Math.max(1, rect.width)));
        p.set(id, normToValue(spec, norm)); // already stepped and clamped
        host.write();
        paint();
      },
      tap: () => this.openNumpad({
        title: spec.name, // the FULL name — no section heading over the keypad
        value: sheetValue(spec, p.get(id)),
        color: host.color,
        onSubmit: (n) => {
          p.set(id, n);
          host.write();
          host.commitAudition();
          rerender();
        },
      }),
      commit: () => { host.commitAudition(); rerender(); },
    });

    row.append(name, track, val);
    return row;
  }

  /** The deck's one pointer gesture: press and slide ALONG a widget, where x means a
      position within it. `attachScrub` cannot serve here — it is vertical and relative (a
      value moves by however far you dragged), while these are horizontal and absolute (the
      value IS where your finger is). Writes go straight to the DOM as they happen; the
      rerender waits for the release, so a slide never rebuilds the thing under the finger.

      `downWrites` is what separates the two widgets: a choice list writes on press, so a
      tap picks an option; a bar does not, so a tap can open the keypad instead. */
  private attachDeckDrag(el: HTMLElement, opts: {
    at: (x: number, rect: DOMRect) => void;
    downWrites: boolean;
    tap?: () => void;
    commit: () => void;
  }): void {
    const MOVE_EPS = 3; // px of travel before a press counts as a slide rather than a tap
    let dragging = false, moved = false, startX = 0;

    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      el.setPointerCapture(e.pointerId);
      if (opts.downWrites) opts.at(e.clientX, el.getBoundingClientRect());
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (!moved && Math.abs(e.clientX - startX) < MOVE_EPS) return;
      moved = true;
      e.preventDefault();
      opts.at(e.clientX, el.getBoundingClientRect());
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (moved || opts.downWrites) opts.commit();
      else opts.tap?.();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  /** One labelled corner number (gate / time limit): a tiny label over a scrub/numpad
      input, matching the corner buttons' footprint. */
  private graphCornerNum(
    label: string, title: string,
    read: () => number, write: (n: number) => void, show: () => string,
    commit: () => void, step: number,
  ): HTMLElement {
    const box = document.createElement("div");
    box.className = "graph-corner-num";
    box.title = title;
    const lbl = document.createElement("span");
    lbl.className = "graph-corner-lbl";
    lbl.textContent = label;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.readOnly = true;
    inp.inputMode = "none";
    inp.value = show();
    this.attachScrub(inp, { label: title, read, write, show, commit, step });
    box.append(lbl, inp);
    return box;
  }

  /** One labelled corner CHOICE (max len / spread): a tiny label over a compact native
      select, matching the corner numbers' footprint. */
  private graphCornerSelect(
    label: string, title: string, options: string[],
    read: () => number, write: (i: number) => void,
  ): HTMLElement {
    const box = document.createElement("div");
    box.className = "graph-corner-num";
    box.title = title;
    const lbl = document.createElement("span");
    lbl.className = "graph-corner-lbl";
    lbl.textContent = label;
    const sel = document.createElement("select");
    sel.className = "graph-corner-select";
    options.forEach((o, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = o;
      sel.append(opt);
    });
    sel.value = String(Math.max(0, Math.min(options.length - 1, read())));
    sel.onchange = () => write(Number(sel.value));
    box.append(lbl, sel);
    return box;
  }

  /** Draw every active setting as its own coloured line over an adaptive time axis (the
      longest active setting sets the span — a 1s echo stretches it to show its tail).
      With a trace selected, it draws bold and the rest dim; a selected INACTIVE trace
      draws nothing extra (its function doesn't exist yet — the empty graph). */
  private soundGraphSvg(get: ParamGet, sel: TraceSpec | null): SVGSVGElement {
    const W = 360, H = 290, L = 8, R = 8, T = 10, B = 22;
    const plotW = W - L - R, plotH = H - T - B;
    const ctx: TraceCtx = { bpm: this.tempo };
    const axisT = traceAxisSeconds(get, ctx);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "sound-graph-svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    // Quarter grid + time tick labels along the bottom.
    const fmtT = (t: number) => (t >= 1 ? `${Math.round(t * 100) / 100}s` : `${Math.round(t * 1000)}ms`);
    for (let q = 0; q <= 4; q++) {
      const x = L + (q / 4) * plotW;
      const l = document.createElementNS(NS, "line");
      l.setAttribute("x1", String(x)); l.setAttribute("y1", String(T));
      l.setAttribute("x2", String(x)); l.setAttribute("y2", String(T + plotH));
      l.setAttribute("class", "curve-viz-grid" + (q === 0 || q === 4 ? " edge" : ""));
      svg.append(l);
      const y = T + (q / 4) * plotH;
      const h = document.createElementNS(NS, "line");
      h.setAttribute("x1", String(L)); h.setAttribute("y1", String(y));
      h.setAttribute("x2", String(L + plotW)); h.setAttribute("y2", String(y));
      h.setAttribute("class", "curve-viz-grid" + (q === 0 || q === 4 ? " edge" : ""));
      svg.append(h);
      if (q > 0) {
        const tx = document.createElementNS(NS, "text");
        tx.setAttribute("x", String(x - 2));
        tx.setAttribute("y", String(H - 7));
        tx.setAttribute("text-anchor", "end");
        tx.setAttribute("class", "curve-viz-lbl");
        tx.textContent = fmtT((q / 4) * axisT);
        svg.append(tx);
      }
    }

    // One polyline per active trace, in its own colour; a trace only spans ITS duration
    // (width = time active), steady settings span the whole axis.
    const drawTrace = (tr: TraceSpec, bold: boolean, dim: boolean) => {
      const d0 = tr.duration(get, ctx);
      const span = isFinite(d0) ? Math.min(d0, axisT) : axisT;
      if (span <= 0) return;
      const N = 160;
      let dPath = "";
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * span;
        const x = L + (t / axisT) * plotW;
        const y = T + (1 - Math.max(0, Math.min(1, tr.curve(get, t, ctx)))) * plotH;
        dPath += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
      }
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", dPath.trim());
      path.setAttribute("class", "sound-trace-line" + (bold ? " bold" : "") + (dim ? " dim" : ""));
      path.setAttribute("stroke", tr.color);
      svg.append(path);
    };
    for (const tr of SOUND_TRACES) {
      if (!tr.active(get)) continue;
      if (sel && tr.id === sel.id) continue; // drawn last, on top
      drawTrace(tr, false, !!sel);
    }
    if (sel && sel.active(get)) drawTrace(sel, true, false);
    return svg;
  }

  /** The coloured trace buttons under the graph: page 0 = every ACTIVE setting, the ‹ ›
      pager walks the INACTIVE ones (dashed buttons — tapping one opens its equation with
      the zeroed values that make the function not exist, ready to be given life). */
  private traceButtons(get: ParamGet, rerender: () => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "trace-panel";
    const active = SOUND_TRACES.filter((t) => t.active(get));
    const inactive = SOUND_TRACES.filter((t) => !t.active(get));
    const PER = 8;
    const pages: { label: string; traces: TraceSpec[]; on: boolean }[] = [
      { label: `active (${active.length})`, traces: active, on: true },
    ];
    for (let i = 0; i < inactive.length; i += PER) {
      pages.push({
        label: `inactive ${Math.floor(i / PER) + 1}/${Math.ceil(inactive.length / PER)}`,
        traces: inactive.slice(i, i + PER),
        on: false,
      });
    }
    const page = Math.max(0, Math.min(pages.length - 1, this.graphPage));
    this.graphPage = page;

    const row = document.createElement("div");
    row.className = "trace-btns";
    for (const tr of pages[page].traces) {
      const b = document.createElement("button");
      b.className = "trace-btn" + (pages[page].on ? "" : " off");
      b.style.setProperty("--tc", tr.color);
      b.textContent = tr.label;
      b.title = tr.about;
      b.onclick = () => { this.graphTrace = tr.id; rerender(); };
      row.append(b);
    }
    if (!pages[page].traces.length) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Nothing here.";
      row.append(hint);
    }
    wrap.append(row);

    const pager = document.createElement("div");
    pager.className = "trace-pager";
    const mkPg = (txt: string, delta: number, disabled: boolean) => {
      const b = document.createElement("button");
      b.className = "place-grid-rowbtn";
      b.textContent = txt;
      b.disabled = disabled;
      b.onclick = () => { this.graphPage = page + delta; rerender(); };
      return b;
    };
    const lbl = document.createElement("span");
    lbl.className = "place-grid-rowsn";
    lbl.textContent = pages[page].label;
    pager.append(mkPg("‹", -1, page === 0), lbl, mkPg("›", 1, page >= pages.length - 1));
    wrap.append(pager);
    return wrap;
  }

  /** One trace's EQUATION, values inline and editable (tap = numpad, drag = scrub) —
      the transition-formula treatment applied to the sound itself. Editing writes the
      bound params live (an inactive setting comes to life the moment its level does);
      the type row switches the function's discrete flavour (LFO wave, noise colour…). */
  private traceEditor(host: SoundGraphHost, spec: TraceSpec, rerender: () => void): HTMLElement {
    const p = host.draft;
    const get: ParamGet = (id) => p.get(id);
    const ctx: TraceCtx = { bpm: this.tempo };
    const card = document.createElement("div");
    card.className = "trace-editor";
    card.style.setProperty("--vc", spec.color);

    const head = document.createElement("div");
    head.className = "trace-ed-head";
    const dot = document.createElement("span");
    dot.className = "trace-dot";
    const name = document.createElement("span");
    name.className = "placement-lbl transition-head";
    name.textContent = spec.label + (spec.active(get) ? "" : " — inactive");
    // The ? glossary: what the function is, plus the ENGINE CODE that implements it —
    // the lines that are the formula's equivalent in the DSP.
    const help = helpButton(spec.label, [
      { name: `${spec.label} — the function`, desc: spec.about, code: spec.code },
    ]);
    const close = document.createElement("button");
    close.className = "loop-remove trace-ed-close";
    close.textContent = "×";
    close.title = "Back to the settings buttons";
    close.onclick = () => { this.graphTrace = null; rerender(); };
    head.append(dot, name, help, close);
    card.append(head);

    // The equation with its values inline. The pieces may be computed from the live
    // values — a beat-synced LFO/echo shows its synced rate at the current tempo, the
    // modal formula names its material's mode set.
    const row = document.createElement("div");
    row.className = "formula-row";
    for (const part of traceParts(spec, get, ctx)) {
      if (typeof part === "string") {
        const t = document.createElement("span");
        t.className = "formula-text";
        t.textContent = part;
        row.append(t);
      } else {
        const v = spec.vars[part];
        const scale = v.scale ?? 1; // scrub/type in DISPLAY units (65, not 0.65)
        const inp = document.createElement("input");
        inp.type = "text";
        inp.readOnly = true;
        inp.inputMode = "none";
        inp.className = "formula-var";
        inp.value = v.fmt(get(v.param));
        inp.size = Math.max(1, inp.value.length);
        this.attachScrub(inp, {
          label: v.sym,
          color: spec.color,
          read: () => get(v.param) * scale,
          write: (n) => {
            p.set(v.param, n / scale); // clamps to the base range
            host.write();
          },
          show: () => v.fmt(get(v.param)),
          step: v.step,
          commit: () => { host.commitAudition(); rerender(); },
        });
        row.append(inp);
      }
    }
    // A finite setting states its DOMAIN next to the formula, calculator style —
    // persistent settings (pitch, filter, LFOs, steady FX) have none and run the
    // whole axis.
    const dom = traceDomain(spec, get, ctx);
    if (dom) {
      const d = document.createElement("span");
      d.className = "formula-text formula-domain";
      d.textContent = `,  ${dom}`;
      row.append(d);
    }
    card.append(row);

    // "from → to" recap of the values as they'll play.
    if (spec.fromTo) {
      const ft = document.createElement("p");
      ft.className = "trace-fromto";
      ft.textContent = "now: " + spec.fromTo(get, ctx);
      card.append(ft);
    }

    // The function's discrete types (an LFO gets Wave + Dest + Sync; noise its colour,
    // the echo its beat-sync and ping-pong, …) — each a segmented row of real choices.
    for (const ty of spec.types ?? []) {
      const ps = baseSpec(ty.param);
      if (!ps.choices || !ps.choices.length) continue;
      const seg = document.createElement("div");
      seg.className = "placement-seg fade-modes";
      ps.choices.forEach((c, i) => {
        // "Drawn" is not pickable as a label: choosing it without a drawing would just pin
        // the pitch flat. The ✏ Draw button below is its only door.
        if (ty.param === ParamId.PitchEnvShape && i === PITCH_SHAPE_DRAWN) return;
        const b = document.createElement("button");
        b.className = "seg-btn" + (Math.round(get(ty.param)) === i ? " on" : "");
        b.textContent = c;
        b.onclick = () => {
          p.set(ty.param, i);
          host.write();
          host.commitAudition();
          rerender();
        };
        seg.append(b);
      });
      // The pitch contour's ninth choice can't be picked from a list — "Drawn" only means
      // something once there IS a drawing — so its row carries the way in as well.
      if (ty.param === ParamId.PitchEnvShape) {
        const drawBtn = document.createElement("button");
        drawBtn.className = "seg-btn" + (Math.round(get(ty.param)) === PITCH_SHAPE_DRAWN ? " on" : "");
        drawBtn.textContent = "✏ Draw";
        drawBtn.title = "Place the pitch by hand, point by point, across the whole graph";
        drawBtn.onclick = () => this.openPitchDraw(host, rerender);
        seg.append(drawBtn);
      }
      card.append(this.labeledRow(ty.label, seg));
    }

    // Life is the one trace with more to say than its own params: the per-loop accent and
    // ghost PLACEMENTS (see LifePlacement in lines.ts) belong with the rest of the per-hit
    // settings, so they hang off this trace rather than a button of their own. They're the
    // deterministic form — every Nth hit, or a ramp — beside the sound's own probabilities,
    // and a placement wins over the probability for its axis (see perHit in engine.js).
    if (spec.id === "life" && host.lifeLoop) {
      const life = document.createElement("div");
      life.className = "trace-life";
      const head2 = document.createElement("span");
      head2.className = "placement-lbl transition-head";
      head2.textContent = "Accents & Ghosts — every Nth hit";
      life.append(head2, this.lifeRow(host.lifeLoop, "accent", rerender), this.lifeRow(host.lifeLoop, "ghost", rerender));
      card.append(life);
    }
    return card;
  }

  // --- per-loop transitions (the Transitions tab) ------------------------

  /** The Transitions tab's LIST: every transition this loop carries — tap one to edit it
      (Bars / Graph / Effects / Speed), toggle it, or remove it. */
  private transitionList(loop: Loop, rerender: () => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "trans-list";
    wrap.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#808080");
    const trs = loop.transitions ?? (loop.transitions = []);

    if (!trs.length) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "A transition transforms this sound into another across a stretch of bars: pick the bars, draw the blend graph, and shape the destination sound in Effects — the values you set there are where the transition ENDS. Add one to start.";
      wrap.append(hint);
    }

    trs.forEach((tr, i) => {
      const row = document.createElement("div");
      row.className = "loop-row trans-row" + (tr.on ? "" : " off");
      row.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#808080");
      const body = document.createElement("button");
      body.className = "loop-body";
      const nm = document.createElement("span");
      nm.className = "loop-name";
      nm.textContent = `Transition ${i + 1}`;
      const sum = document.createElement("span");
      sum.className = "loop-summary";
      sum.textContent = this.transitionSummary(loop, tr);
      body.append(nm, sum);
      body.onclick = () => {
        this.editTransition = tr;
        this.transTab = "graph"; // land on the transition's own curve
        this.graphTrace = null;
        this.graphPage = 0;
        this.schedulePreview(loop, tr);
        rerender();
      };
      const onBtn = document.createElement("button");
      onBtn.className = "seg-btn fade-toggle trans-onoff" + (tr.on ? " on" : "");
      onBtn.textContent = tr.on ? "On" : "Off";
      onBtn.onclick = (e) => { e.stopPropagation(); tr.on = !tr.on; this.recompile(); rerender(); };
      const rm = document.createElement("button");
      rm.className = "loop-remove";
      rm.textContent = "×";
      rm.title = "Remove this transition";
      rm.onclick = (e) => {
        e.stopPropagation();
        trs.splice(i, 1);
        if (this.editTransition === tr) { this.editTransition = null; this.stopPreview(); }
        this.recompile();
        rerender();
      };
      row.append(body, onBtn, rm);
      wrap.append(row);
    });

    const add = document.createElement("button");
    add.className = "loop-add";
    add.textContent = "＋ Add transition";
    add.onclick = () => {
      const tr = defaultLoopTransition(loop, this.track.barLimit);
      trs.push(tr);
      this.editTransition = tr;
      this.transTab = "graph"; // land on the transition's own curve
      this.graphTrace = null;
      this.graphPage = 0;
      this.recompile();
      this.schedulePreview(loop, tr);
      rerender();
    };
    wrap.append(add);
    return wrap;
  }

  /** One-line recap of a transition: its bar count, how many params its target bends,
      the speed warp, and whether it's off. */
  private transitionSummary(loop: Loop, tr: LoopTransition): string {
    const barLimit = Math.max(1, this.track.barLimit);
    const bars = tr.bars.filter((b) => b >= 1 && b <= barLimit).length;
    const changed = this.changedParamCount(loop, tr);
    const bits = [
      `${bars} bar${bars === 1 ? "" : "s"}`,
      changed ? `${changed} param${changed === 1 ? "" : "s"} changed` : "no changes yet",
    ];
    if (tr.speedOn) bits.push(`speed ${(tr.rate ?? 2).toFixed(2)}×`);
    if (tr.reverseOn) bits.push("reverse");
    if (!tr.on) bits.push("off");
    return bits.join(" · ");
  }

  /** How many params the transition's target differs from the loop's own sound in — against
      the EFFECTIVE target, so a reverse-only transition doesn't read "no changes yet". */
  private changedParamCount(loop: Loop, tr: LoopTransition): number {
    let n = 0;
    const target = this.targetSnapshot(tr);
    const len = Math.max(loop.snapshot.length, target.length);
    for (let i = 0; i < len; i++) {
      const a = loop.snapshot[i] ?? 0;
      const b = target[i] ?? a;
      if (Math.abs(a - b) > 1e-6) n++;
    }
    return n;
  }

  /** One transition's editor: a back header + On/Off, then Bars / Graph / Effects /
      Speed tabs. Every edit reschedules the shortened 4-bar looping preview (the sound
      morphing linearly into the transformed sound — the latest changes land each time
      the render catches up). */
  private transitionEditor(loop: Loop, tr: LoopTransition, rerender: () => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "trans-editor";
    wrap.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#808080");
    // The back navigation + On/Off live in the popup header's breadcrumb now.

    const nav = document.createElement("div");
    nav.className = "placement-seg placement-nav trans-nav";
    const mkTab = (tab: typeof this.transTab, text: string) => {
      const b = document.createElement("button");
      b.className = "seg-btn" + (this.transTab === tab ? " on" : "");
      b.textContent = text;
      b.onclick = () => {
        if (this.transTab === tab) return;
        this.transTab = tab;
        this.gridPick = null;
        this.graphTrace = null; // the Sound tab's graph starts on its buttons
        this.graphPage = 0;
        rerender();
      };
      return b;
    };
    // Two graphs live here now: "Curve" is the transition's own blend function,
    // "Sound" is the transformed sound's graph (the end values).
    nav.append(mkTab("bars", "Bars"), mkTab("graph", "Curve"), mkTab("effects", "Sound"), mkTab("speed", "Speed"));
    wrap.append(nav);

    // ⇄ opens THIS transition's sound directly (see the loop page's action), so the LIST —
    // where a second transition is added, toggled or removed — needs its own door back.
    const all = loop.transitions ?? [];
    const listBtn = document.createElement("button");
    listBtn.className = "loop-action-btn trans-list-btn";
    listBtn.textContent = `⇄ All transitions (${all.length})`;
    listBtn.title = "This loop's transitions — add, toggle or remove";
    listBtn.onclick = () => {
      this.stopPreview();
      this.editTransition = null;
      this.gridPick = null;
      rerender();
    };
    wrap.append(listBtn);

    if (this.transTab === "bars") {
      wrap.append(this.transPreviewRow(loop, tr, rerender));
      const hint = document.createElement("p");
      hint.className = "sing-hint";
      hint.textContent = "Where the transition runs. It starts on the loop's full placement (the striped squares are where this loop sounds); each contiguous run sweeps sound → transformed across itself.";
      wrap.append(hint);
      wrap.append(this.transBarsGrid(loop, tr, rerender));
    } else if (this.transTab === "graph") {
      wrap.append(this.transGraphSection(loop, tr, rerender));
    } else if (this.transTab === "effects") {
      wrap.append(this.transEffectsSection(loop, tr, rerender));
    } else {
      wrap.append(this.transSpeedSection(loop, tr, rerender));
    }
    return wrap;
  }

  /** The preview picker shown on every transition tab: hear the whole TRANSITION over a
      loop of a chosen length (sound → transformed, linearly), or just the transformed
      RESULT looping — for shaping the destination on its own. */
  private transPreviewRow(loop: Loop, tr: LoopTransition, rerender: () => void): HTMLElement {
    const row = document.createElement("div");
    row.className = "placement-row fade-row trans-preview-row";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = "Preview";
    const controls = document.createElement("div");
    controls.className = "fade-controls trans-preview-ctl";
    const seg = document.createElement("div");
    seg.className = "placement-seg fade-modes";
    const mkMode = (m: "transition" | "result", text: string, title: string) => {
      const b = document.createElement("button");
      b.className = "seg-btn" + (this.transPreviewMode === m ? " on" : "");
      b.textContent = text;
      b.title = title;
      b.onclick = () => {
        if (this.transPreviewMode === m) return;
        this.transPreviewMode = m;
        this.schedulePreview(loop, tr, true);
        rerender();
      };
      return b;
    };
    seg.append(
      mkMode("transition", "Transition", "Loop the sound morphing into the transformed sound"),
      mkMode("result", "Result only", "Loop just the transformed sound, no morph"),
    );
    controls.append(seg);
    controls.append(this.numRow("Length", () => this.transPreviewBars, (n) => {
      this.transPreviewBars = Math.max(1, Math.min(64, Math.round(n)));
      this.schedulePreview(loop, tr);
    }, rerender, () => `${this.transPreviewBars} bar${this.transPreviewBars === 1 ? "" : "s"}`));
    row.append(lbl, controls);
    return row;
  }

  /** The Graph tab: the blend curve (x = the transition's length, y = 0 the starting
      sound → 100 the transformed sound), the shape picker, and the function written out
      as its FORMULA — every variable an inline input, with the min/max bounds shown as
      an inequality next to it and a ? explaining the function and each variable. */
  private transGraphSection(loop: Loop, tr: LoopTransition, rerender: () => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "placement-controls trans-graph";
    wrap.append(this.transGraphViz(tr));

    const hint = document.createElement("p");
    hint.className = "sing-hint";
    hint.textContent = "y is how far the sound has transformed (0 = as it is, 100 = the Effects values); x runs 0→1 across each bar window. Tap any number in the formula to change it.";
    wrap.append(hint);

    const touch = () => { this.schedulePreview(loop, tr); rerender(); };

    // Shape picker (the same shapes every transition surface offers), plus Draw —
    // a freehand function sketched on its own screen (see openDrawOverlay).
    const shapeSeg = document.createElement("div");
    shapeSeg.className = "placement-seg fade-modes";
    const spec = blendShapeSpec(tr.shape);
    for (const s of BLEND_SHAPES) {
      const b = document.createElement("button");
      b.className = "seg-btn" + (spec.id === s.id ? " on" : "");
      b.textContent = s.label;
      b.onclick = () => {
        // Tapping the already-active category is a no-op (it must never wipe settings).
        if ((tr.shape ?? "ramp") === s.id) return;
        // A fresh function starts from ITS OWN defaults — nothing carries over from
        // editing another one: the whole formula (knob, ease, waves, slope, shift,
        // min/max) resets to the identity.
        tr.shape = s.id === "ramp" ? undefined : s.id; // ramp = the default, stored lean
        tr.curve = undefined;
        tr.dir = undefined;
        tr.cycles = s.usesCycles ? s.cyclesDefault : undefined;
        tr.points = undefined;
        tr.yGain = undefined;
        tr.yBias = undefined;
        tr.yMin = undefined;
        tr.yMax = undefined;
        this.recompile();
        touch();
      };
      shapeSeg.append(b);
    }
    const drawBtn = document.createElement("button");
    drawBtn.className = "seg-btn" + (tr.shape === "drawn" ? " on" : "");
    drawBtn.textContent = "✏ Draw";
    drawBtn.title = "Draw the function by hand — it's cleaned up and matched to a formula";
    drawBtn.onclick = () => this.openDrawOverlay(loop, tr, rerender);
    shapeSeg.append(drawBtn);
    wrap.append(this.labeledRow("Shape", shapeSeg));

    wrap.append(this.transFormula(loop, tr, rerender));

    // Ease direction, where the shape bends time toward one end (parabola's skew lives
    // in the formula's `p` instead).
    if (spec.usesDir && spec.id !== "parabola") {
      const dirSeg = document.createElement("div");
      dirSeg.className = "placement-seg fade-modes";
      const mkDir = (d: "out" | "in", text: string) => {
        const b = document.createElement("button");
        b.className = "seg-btn" + ((tr.dir ?? "out") === d ? " on" : "");
        b.textContent = text;
        b.onclick = () => { tr.dir = d; this.recompile(); touch(); };
        return b;
      };
      dirSeg.append(mkDir("out", "Ease out"), mkDir("in", "Ease in"));
      wrap.append(this.labeledRow("Ease", dirSeg));
    }
    return wrap;
  }

  /** The transition's blend function written out as an editable FORMULA: interleaved
      text and inline variable inputs (tap = numpad, drag = scrub), the min/max bounds
      as an inequality chip beside it, and a ? that explains the function and what each
      variable does. Defaults are the identity — the plain shape until edited. */
  private transFormula(loop: Loop, tr: LoopTransition, rerender: () => void): HTMLElement {
    const spec = blendShapeSpec(tr.shape);
    const touch = () => { this.recompile(); this.schedulePreview(loop, tr); };
    const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
    const lean = (v: number, def: number): number | undefined => (Math.abs(v - def) < 1e-9 ? undefined : v);
    const r2 = (n: number) => Math.round(n * 100) / 100;

    interface FVar { sym: string; read: () => number; write: (n: number) => void; step: number; show: () => string; help: string; }
    const fv = (sym: string, read: () => number, write: (n: number) => void, step: number, help: string, show?: () => string): FVar =>
      ({ sym, read, write, step, help, show: show ?? (() => String(r2(read()))) });

    // The two transform variables every shape shares (y is drawn 0–100).
    const A = fv("a", () => r2(tr.yGain ?? 1), (n) => { tr.yGain = lean(clamp(r2(n), -100, 100), 1); touch(); }, 0.05,
      "Slope / height multiplier. 1 leaves the shape as drawn; 2 makes it climb twice as steeply (clamped at the top — a big a makes the transformation snap early); negative flips it upside down — the transition starts transformed and comes back.");
    const B = fv("b", () => Math.round((tr.yBias ?? 0) * 100), (n) => { tr.yBias = lean(clamp(Math.round(n), -1000, 1000) / 100, 0); touch(); }, 5,
      "Vertical shift, in y units (0–100, but it can run far past either end). +25 lifts the whole curve a quarter of the way toward the transformed sound; a large negative b with a steep a holds the sound plain, then transforms late.",
      () => String(Math.round((tr.yBias ?? 0) * 100)));

    // The shape's own variables (each maps back onto the stored curve/cycles/dir).
    const curve01 = () => tr.curve ?? 0;
    const K_POW = (help: string) => fv("k", () => r2(Math.pow(4, curve01())), (n) => {
      tr.curve = lean(clamp(Math.log(clamp(r2(n), 1, 4)) / Math.log(4), 0, 1), 0);
      touch();
    }, 0.05, help);
    const K_SIG = fv("k", () => r2(4 + 12 * curve01()), (n) => {
      tr.curve = lean(clamp((clamp(r2(n), 4, 16) - 4) / 12, 0, 1), 0);
      touch();
    }, 0.5, "Steepness of the S: 4 is a gentle lean, 16 snaps almost straight from 0 to 100 at the midpoint.");
    const P_PEAK = fv("p", () => r2(0.5 + (tr.dir === "in" ? 1 : -1) * 0.35 * curve01()), (n) => {
      const v = clamp(r2(n), 0.15, 0.85);
      tr.dir = v >= 0.5 ? "in" : "out";
      tr.curve = lean(clamp(Math.abs(v - 0.5) / 0.35, 0, 1), 0);
      touch();
    }, 0.05, "Where the arch peaks, as a fraction of the window (0.5 = the middle; 0.15 peaks early, 0.85 late). The curve goes out to the transformed sound and back.");
    const N_WAVE = fv("n", () => r2(tr.cycles ?? spec.cyclesDefault), (n) => {
      tr.cycles = clamp(r2(n), 0.25, 999);
      touch();
    }, 0.25, "How many waves fit in the window — as many as you like. Half-integers land at the transformed end; whole numbers return home.");
    const N_STEP = fv("n", () => Math.max(2, Math.round(tr.cycles ?? spec.cyclesDefault)), (n) => {
      tr.cycles = clamp(Math.round(n), 2, 99);
      touch();
    }, 1, "How many flat levels the staircase jumps through on its way to the transformed sound.", () => String(Math.max(2, Math.round(tr.cycles ?? spec.cyclesDefault))));
    const W_WARP = K_POW("Time warp exponent on x: 1 spaces the waves evenly; up to 4 squeezes them toward one end (an accelerating oscillation — the Ease buttons pick which end).");
    const D_DEPTH = fv("d", () => r2(0.15 + 0.85 * curve01()), (n) => {
      tr.curve = lean(clamp((clamp(r2(n), 0.15, 1) - 0.15) / 0.85, 0, 1), 0);
      touch();
    }, 0.05, "How hard the wobble swings around the underlying ramp; it always lands exactly on the transformed sound.");
    const G_GAP = fv("g", () => r2(curve01()), (n) => {
      tr.curve = lean(clamp(r2(n), 0, 1), 0);
      touch();
    }, 0.05, "The rest between humps: 0 and they touch (a continuous |sin|), 1 leaves thin spikes with mostly untransformed sound between them.");

    // The formula, as text pieces interleaved with variables, plus what the function is.
    let parts: (string | FVar)[];
    let fnHelp: string;
    switch (spec.id) {
      case "scurve":
        parts = ["y = ", A, " · σ(", K_SIG, "·(x−½)) + ", B];
        fnHelp = "A logistic S-curve: slow start, steep middle, slow landing — σ is the sigmoid 1/(1+e⁻ᵗ), normalised to run 0→100 across the window.";
        break;
      case "parabola":
        parts = ["y = ", A, " · arch(x, ", P_PEAK, ") + ", B];
        fnHelp = "A smooth arch out and back: the sound transforms fully at the peak and returns to itself by the end (y goes 0 → 100 → 0).";
        break;
      case "sine":
        parts = ["y = ", A, " · (½ − ½·cos(2π·", N_WAVE, "·x^", W_WARP, ")) + ", B];
        fnHelp = "A smooth wave starting at the plain sound: it swings to the transformed sound and back n times across the window.";
        break;
      case "cos":
        parts = ["y = ", A, " · (½ + ½·cos(2π·", N_WAVE, "·x^", W_WARP, ")) + ", B];
        fnHelp = "The same wave starting AT the transformed sound: a dip back to the plain sound and return, n times across the window.";
        break;
      case "zigzag":
        parts = ["y = ", A, " · tri(", N_WAVE, "·x^", W_WARP, ") + ", B];
        fnHelp = "The triangle cousin of the sine: straight lines back and forth between the two sounds — tri is a 0→1→0 triangle wave.";
        break;
      case "wobble":
        parts = ["y = ", A, " · (x + ", D_DEPTH, "·sin(2π·", N_WAVE, "·x)·(1−x)) + ", B];
        fnHelp = "A straight ramp with a damped swing riding it: it oscillates on the way but the (1−x) term fades the swing so it lands exactly.";
        break;
      case "steps":
        parts = ["y = ", A, " · ⌊", N_STEP, "·x^", W_WARP, "⌋ / (n−1) + ", B];
        fnHelp = "A staircase: the sound jumps through n flat levels instead of gliding — each ⌊⌋ step is a sudden move toward the transformed sound.";
        break;
      case "halfwave":
        parts = ["y = ", A, " · hump(", N_WAVE, ", ", G_GAP, ", x) + ", B];
        fnHelp = "n half-sine humps with flat rests between them: the sound bulges into the transformed sound and back, g setting the gap between bulges.";
        break;
      case "drawn": {
        parts = ["y = ", A, " · draw(x) + ", B];
        const fit = tr.points && tr.points.length ? fitBlendShape(tr.points) : null;
        fnHelp = "Your drawn function, played back exactly as it looks — whether sketched by hand or snapped to a matched formula (Use formula bakes it in right here, staying in this category)."
          + (fit ? ` Closest named formula: ${fit.label} (off by ~${Math.round(fit.rmse * 100)} y-units on average).` : "");
        break;
      }
      default: {
        const K = K_POW("Curve exponent on x: 1 is a straight line; up to 4 bends it exponential — barely moving at first, then rushing the end (flip with Ease in).");
        parts = tr.dir === "in"
          ? ["y = ", A, " · (1−(1−x)^", K, ") + ", B]
          : ["y = ", A, " · x^", K, " + ", B];
        fnHelp = "The straight line from the plain sound (y=0) to the transformed sound (y=100), bent toward exponential by k.";
      }
    }

    const MIN = fv("min", () => Math.round((tr.yMin ?? 0) * 100), (n) => {
      tr.yMin = lean(clamp(Math.round(n), 0, 100) / 100, 0);
      touch();
    }, 5, "The floor: y never drops below this — the sound always stays at least this transformed inside the window.",
      () => String(Math.round((tr.yMin ?? 0) * 100)));
    const MAX = fv("max", () => Math.round((tr.yMax ?? 1) * 100), (n) => {
      tr.yMax = lean(clamp(Math.round(n), 0, 100) / 100, 1);
      touch();
    }, 5, "The ceiling: y never rises above this — the transformation is capped here even where the curve wants to go further.",
      () => String(Math.round((tr.yMax ?? 1) * 100)));

    const varInput = (v: FVar): HTMLInputElement => {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.readOnly = true;
      inp.inputMode = "none";
      inp.className = "formula-var";
      inp.value = v.show();
      inp.size = Math.max(1, v.show().length);
      this.attachScrub(inp, {
        label: v.sym, read: v.read, write: v.write, show: v.show, step: v.step, commit: rerender,
      });
      return inp;
    };

    const block = document.createElement("div");
    block.className = "formula-block";
    const head = document.createElement("div");
    head.className = "formula-head";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = "Formula";
    // The ? glossary: the function first, then every variable in it (+ the bounds).
    const usedVars = parts.filter((p): p is FVar => typeof p !== "string");
    const items: HelpItem[] = [
      { name: `${spec.label} — the function`, desc: fnHelp, code: parts.map((p) => (typeof p === "string" ? p : p.sym)).join("") },
      ...usedVars.map((v) => ({ name: `${v.sym} (now ${v.show()})`, desc: v.help })),
      { name: "min / max", desc: `${MIN.help} ${MAX.help} Written beside the formula the graph-calculator way: min ≤ y ≤ max.` },
    ];
    head.append(lbl, helpButton(`${spec.label} formula`, items));
    block.append(head);

    const row = document.createElement("div");
    row.className = "formula-row";
    for (const p of parts) {
      if (typeof p === "string") {
        const t = document.createElement("span");
        t.className = "formula-text";
        t.textContent = p;
        row.append(t);
      } else {
        row.append(varInput(p));
      }
    }
    block.append(row);

    // The bounds, in inequality notation next to the formula (identity: 0 ≤ y ≤ 100).
    const bounds = document.createElement("div");
    bounds.className = "formula-row formula-bounds";
    const open = document.createElement("span");
    open.className = "formula-text";
    open.textContent = "where ";
    const mid = document.createElement("span");
    mid.className = "formula-text";
    mid.textContent = " ≤ y ≤ ";
    bounds.append(open, varInput(MIN), mid, varInput(MAX));
    block.append(bounds);
    return block;
  }

  /** The transition's blend graph with its transform applied: a 0–100 y axis (0 = the
      starting sound, 100 = the transformed sound) over the window's length. */
  private transGraphViz(tr: LoopTransition): HTMLElement {
    const W = 320, H = 150, T = 8, B = 24, L = 26;
    const plotW = W - L - 4, plotH = H - T - B;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "curve-viz");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const mkLine = (x1: number, y1: number, x2: number, y2: number, cls: string) => {
      const l = document.createElementNS(NS, "line");
      l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1));
      l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2));
      l.setAttribute("class", cls);
      svg.append(l);
    };
    const mkText = (x: number, y: number, anchor: string, text: string) => {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(x)); t.setAttribute("y", String(y));
      t.setAttribute("text-anchor", anchor);
      t.setAttribute("class", "curve-viz-lbl");
      t.textContent = text;
      svg.append(t);
    };
    for (let q = 0; q <= 4; q++) {
      const x = L + (q / 4) * plotW;
      mkLine(x, T, x, T + plotH, "curve-viz-grid" + (q === 0 || q === 4 ? " edge" : ""));
      const y = T + (q / 4) * plotH;
      mkLine(L, y, L + plotW, y, "curve-viz-grid" + (q === 0 || q === 4 ? " edge" : ""));
    }
    mkText(L - 4, T + 4, "end", "100");
    mkText(L - 4, T + plotH + 3, "end", "0");
    let d = "";
    const N = 160;
    for (let i = 0; i <= N; i++) {
      const x = i / N;
      const y = blendShapeY(tr, x);
      d += (i === 0 ? "M" : "L") + (L + x * plotW).toFixed(1) + " " + (T + plotH - y * plotH).toFixed(1) + " ";
    }
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d.trim());
    path.setAttribute("class", "curve-viz-line");
    svg.append(path);
    mkText(L, H - 6, "start", "sound");
    mkText(W - 4, H - 6, "end", "transformed");

    const box = document.createElement("div");
    box.className = "curve-viz-box";
    box.append(svg);
    return box;
  }

  /** A fitted formula written out with its numbers inline (the draw screen's caption —
      the same notation the Formula row uses, y in 0–100 units). */
  private fitFormulaText(fit: ReturnType<typeof fitBlendShape>): string {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const c = fit.curve ?? 0;
    const kPow = r2(Math.pow(4, c));
    const warp = kPow !== 1 ? `^${kPow}` : "";
    let core: string;
    switch (fit.shape) {
      case "scurve": core = `σ(${r2(4 + 12 * c)}·(x−½))`; break;
      case "parabola": core = `arch(x, ${r2(0.5 + (fit.dir === "in" ? 1 : -1) * 0.35 * c)})`; break;
      case "sine": core = `½ − ½·cos(2π·${r2(fit.cycles ?? 1.5)}·x${warp})`; break;
      case "cos": core = `½ + ½·cos(2π·${r2(fit.cycles ?? 1)}·x${warp})`; break;
      case "zigzag": core = `tri(${r2(fit.cycles ?? 1.5)}·x${warp})`; break;
      case "wobble": core = `x + ${r2(0.15 + 0.85 * c)}·sin(2π·${r2(fit.cycles ?? 2)}·x)·(1−x)`; break;
      case "steps": { const n = Math.max(2, Math.round(fit.cycles ?? 4)); core = `⌊${n}·x${warp}⌋/${n - 1}`; break; }
      case "halfwave": core = `hump(${r2(fit.cycles ?? 3)}, ${r2(c)}, x)`; break;
      default: core = fit.dir === "in" && kPow !== 1 ? `(1−(1−x)^${kPow})` : kPow !== 1 ? `x^${kPow}` : "x";
    }
    const a = fit.yGain !== 1 ? `${r2(fit.yGain)} · ` : "";
    const bU = Math.round(fit.yBias * 100);
    const b = bU ? (bU > 0 ? ` + ${bU}` : ` − ${-bU}`) : "";
    return `y = ${a}${core}${b}`;
  }

  /** The transition's blend function, on the shared draw screen (see ui/drawOverlay.ts).
      The axis is a plain 0..1 "how far transformed", so canvas space IS storage space here
      and no conversion is needed — the pitch caller is the one that has to convert. */
  private openDrawOverlay(loop: Loop, tr: LoopTransition, rerender: () => void): void {
    const done = () => {
      this.recompile();
      this.schedulePreview(loop, tr);
      rerender();
    };
    // Whatever the way out, the drawing carries its own height/offset, so the shape's
    // transform resets to identity.
    const takeCurve = (points: number[]) => {
      tr.shape = "drawn";
      tr.points = points.slice(0, DRAWN_POINTS);
      tr.curve = undefined; tr.dir = undefined; tr.cycles = undefined;
      tr.yGain = undefined; tr.yBias = undefined; tr.yMin = undefined; tr.yMax = undefined;
    };
    // A good fit IS the formula (≲4 y-units off).
    const fitGood = (ys: number[]) => fitBlendShape(ys).rmse <= 0.04;
    openDrawOverlay({
      axis: {
        title: "Draw the function",
        hint: "Sketch how far the sound transforms across the window — bottom = the sound as it is, top = the Effects values. The line is cleaned up as you lift your finger, and matched to a formula. Points thins it out.",
        color: loop.soundId >= 0 ? loop.color : "#808080",
        topLabel: "transformed",
        bottomLabel: "sound",
        xLabel: "",
        slots: DRAWN_POINTS,
      },
      initial: tr.shape === "drawn" && tr.points ? tr.points.slice() : null,
      verdict: (ys) => {
        if (!ys) return "Draw left to right — redrawing replaces the line.";
        const fit = fitBlendShape(ys);
        const match = Math.max(0, Math.min(100, Math.round(100 * (1 - fit.rmse * 2.5))));
        return `Matched: ${fit.label} (${match}%) — ${this.fitFormulaText(fit)}`;
      },
      ghost: (ys) => {
        const fit = fitBlendShape(ys);
        return (x) => fit.yGain * blendShape(fit, x) + fit.yBias;
      },
      actions: [{
        label: "Use formula",
        title: "Replace the drawing with the matched formula",
        highlight: fitGood,
        run: (ys) => {
          // Taking the formula STAYS in the ✏ Draw category: the matched formula is baked
          // into the drawn curve (sampled like a drawing), so the Graph tab doesn't hop to
          // Sine/Steps/… where a stray tap on the shape row would reset it — the drawn
          // function remains its own open category either way.
          const f = fitBlendShape(ys);
          takeCurve(Array.from({ length: DRAWN_POINTS }, (_, i) => {
            const y = f.yGain * blendShape(f, i / (DRAWN_POINTS - 1)) + f.yBias;
            return Math.round(Math.max(0, Math.min(1, y)) * 1000) / 1000;
          }));
          this.toast(`Formula applied: ${this.fitFormulaText(f)}`);
          done();
        },
      }],
      commit: (ys) => {
        const fit = fitBlendShape(ys);
        takeCurve(ys);
        this.toast(`Drawn function kept — closest formula: ${fit.label}`);
        done();
      },
    });
  }

  /** The PITCH contour's editor — the NODE PATH screen (ui/pathOverlay.ts), not the freehand
      one the transitions use: a pitch line is a few places you want the tone to BE, which is
      easier to place and re-grab as points than to hit in one stroke.
      Unlike the transition's, canvas space is not storage
      space: the y axis is the graph's own log-frequency axis (20 Hz .. 12 kHz), and what gets
      stored is the OCTAVE OFFSET from the base pitch at each sample — so the curve renders
      exactly where it was drawn, yet still transposes with Pitch, follows the key, and rides
      pitchTrack. The contour spans traceAxisSeconds, which is why the x caption names it. */
  private openPitchDraw(host: SoundGraphHost, rerender: () => void): void {
    const p = host.draft;
    const get: ParamGet = (id) => p.get(id);
    const ctx: TraceCtx = { bpm: this.tempo };
    const span = traceAxisSeconds(get, ctx);
    const base = Math.max(1, get(ParamId.Pitch));
    const yToOct = (y: number) => Math.log2(normToHz(y) / base);
    const octToY = (oct: number) => hzToNorm(base * Math.pow(2, oct));
    const drawn = Math.round(get(ParamId.PitchEnvShape)) === PITCH_SHAPE_DRAWN;
    openPathOverlay({
      axis: {
        title: "Draw the pitch",
        hint: `Tap to place points across the whole graph — the height is the pitch itself, on the same 20 Hz–12 kHz scale the graph draws. Drag a point to move it, tap it twice to remove it, and hold or drag a line to bend it. The path replaces the sweep's Env, Dec, curve and waves entirely.`,
        color: "#800000",
        topLabel: "12 kHz",
        bottomLabel: "20 Hz",
        xLabel: `${Math.round(span * 100) / 100}s`,
        slots: PITCH_DRAW_SLOTS,
      },
      initial: drawn
        ? Array.from({ length: PITCH_DRAW_SLOTS }, (_, i) => octToY(get((PITCH_DRAW_BASE + i) as ParamId)))
        : null,
      verdict: (ys) => {
        if (!ys) return "Tap the graph to place the first point.";
        const hz = ys.map((y) => normToHz(y));
        return `${Math.round(Math.min(...hz))} Hz … ${Math.round(Math.max(...hz))} Hz over ${Math.round(span * 100) / 100}s`;
      },
      commit: (ys) => {
        for (let i = 0; i < PITCH_DRAW_SLOTS; i++) {
          p.set((PITCH_DRAW_BASE + i) as ParamId, Math.round(yToOct(ys[i]) * 1000) / 1000);
        }
        p.set(ParamId.PitchEnvShape, PITCH_SHAPE_DRAWN);
        host.write();
        host.commitAudition();
        this.toast("Drawn pitch contour kept");
        rerender();
      },
    });
  }

  /** The Sound tab of a transition: the Reverse toggle, then the SAME sound graph the
      voice's Sound panel uses, hosted by the transition's TRANSFORMED sound — every value
      edited here is the transition's END. The corner gains a small ⧉ that lands the
      transformed sound as a new loop after the transition; ↺ resets to "no change" (the
      loop's own sound). Reverse rides ABOVE the graph on purpose: it flips the end sound in
      time without touching the values below it, and this is where that needs saying. */
  private transEffectsSection(loop: Loop, tr: LoopTransition, rerender: () => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "trans-effects";
    wrap.append(this.transReverseRow(loop, tr, rerender));
    wrap.append(this.soundPanel(this.graphHostForTransition(loop, tr, rerender), rerender));
    return wrap;
  }

  /** The Reverse toggle: the transition arrives at the time-MIRROR of the sound below —
      its loudness shape read end for end, so each hit swells instead of falling away. The
      morph gets there gradually, one step further round per hit across the window, since
      the mirror is just another target snapshot (see model/reverse.ts). */
  private transReverseRow(loop: Loop, tr: LoopTransition, rerender: () => void): HTMLElement {
    const on = !!tr.reverseOn;
    const row = document.createElement("div");
    row.className = "placement-row fade-row";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = "Reverse";
    const controls = document.createElement("div");
    controls.className = "fade-controls";
    const toggle = document.createElement("button");
    toggle.className = "seg-btn fade-toggle" + (on ? " on" : "");
    toggle.textContent = on ? "On" : "Off";
    toggle.title = "Mirror the end sound in time (attack ↔ fall)";
    toggle.onclick = () => {
      tr.reverseOn = on ? undefined : true;
      this.recompile();
      this.schedulePreview(loop, tr);
      rerender();
    };
    controls.append(toggle);
    const hint = document.createElement("p");
    hint.className = "sing-hint";
    hint.textContent = on
      ? "The sound arrives back to front — its loudness shape mirrored end for end, so the hits swell into themselves instead of falling away, each one a little further round than the last. The graph below still shows the end values the right way round; Reverse flips them on the way out. The layer decays and the click can't be mirrored, so a sound shaped mostly by those turns round less."
      : "Off — the transition lands on the sound exactly as shaped below. Turn on to have it arrive time-mirrored: the attack and the fall swap places.";
    controls.append(hint);
    row.append(lbl, controls);
    return row;
  }

  /** Copy a transition's TRANSFORMED sound into a new loop, placed from the bar after the
      transition through the end of the track — so the row plays the initial sound,
      transitions, then loops the new sound. The copy keeps the source loop's rhythm; it
      gets its own sound id, name and loudness make-up. `target` defaults to the source's
      own row (the header's ⧉); the header's ⧉→ passes another voice, which is the same
      hand-off one row over.  */
  private copyTransformedSound(loop: Loop, tr: LoopTransition, target?: number): void {
    const c = target ?? this.colorOf(loop);
    const clone = cloneLoop(loop);
    clone.color = VOICE_COLORS[c % VOICE_COLORS.length];
    clone.soundId = this.nextSoundId++;
    clone.snapshot = this.targetSnapshot(tr).slice(); // what the transition ARRIVES at
    clone.transitions = undefined; // the new sound starts with a clean slate
    clone.label = generateName();
    clone.gain = undefined;        // re-measured below for the new sound
    const barLimit = Math.max(1, this.track.barLimit);
    const last = tr.bars.reduce((m, b) => (b >= 1 && b <= barLimit ? Math.max(m, b) : m), 0);
    const bars: number[] = [];
    for (let b = last + 1; b <= barLimit; b++) bars.push(b);
    clone.rule = {
      every: { kind: "at", bars },
      forBars: 1,
      seed: newSeed(),
      seedHistory: [],
    };
    this.track.colors[c].loops.push(clone);
    // Name it from its own sound (a fresh draft over the copied snapshot).
    clone.name = this.draftFor(clone).describe().join(" · ");
    this.pushSounds();
    this.recompile();
    void this.normalizeLoop(clone);
    this.render(); // refresh the loop list under the popup (the popup itself survives)
    const where = c === this.colorOf(loop) ? "" : ` on Voice ${c + 1}`;
    this.toast(bars.length
      ? `“${clone.label}” added${where} after the transition (bars ${bars[0]}–${barLimit})`
      : `“${clone.label}” added${where} — the transition reaches the track end, so place it on its Loop tab`);
  }

  /** The Speed tab: stack the timing warp on the morph — the window's hits rush (rate
      > 1×) or drag (rate < 1×) across it — plus the rhythm being warped (the loop's own
      hits/steps circles and sequencer grid, edited in place). */
  private transSpeedSection(loop: Loop, tr: LoopTransition, rerender: () => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "placement-controls trans-speed";
    const on = !!tr.speedOn;

    const row = document.createElement("div");
    row.className = "placement-row fade-row";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = "Speed";
    const controls = document.createElement("div");
    controls.className = "fade-controls";
    const toggle = document.createElement("button");
    toggle.className = "seg-btn fade-toggle" + (on ? " on" : "");
    toggle.textContent = on ? "On" : "Off";
    toggle.onclick = () => {
      tr.speedOn = on ? undefined : true;
      if (tr.speedOn && tr.rate === undefined) tr.rate = 2;
      this.recompile();
      this.schedulePreview(loop, tr);
      rerender();
    };
    controls.append(toggle);
    const hint = document.createElement("p");
    hint.className = "sing-hint";
    hint.textContent = on
      ? "The hits re-time across each window — above 1× they rush together toward the end, below 1× they stretch apart — while the tone morphs."
      : "Off — the hits keep the grid. Turn on to speed up or slow down the loop's hits across the transition.";
    controls.append(hint);
    if (on) {
      // In × units (type 1.5 for 1.5×; the numpad's dot key); scrubbing steps by 0.05×.
      controls.append(this.numRow("Rate", () => Math.round((tr.rate ?? 2) * 100) / 100, (n) => {
        tr.rate = Math.round(Math.max(0.05, Math.min(32, n)) * 100) / 100;
        this.recompile();
        this.schedulePreview(loop, tr);
      }, rerender, () => `${(tr.rate ?? 2).toFixed(2)}×`, 0.05));
    }
    row.append(lbl, controls);
    wrap.append(row);

    // The rhythm the warp re-times: the loop's own circles + sequencer grid, live.
    const rHead = document.createElement("span");
    rHead.className = "placement-lbl transition-head";
    rHead.textContent = "Rhythm";
    wrap.append(rHead);
    const detail = document.createElement("div");
    detail.className = "euclid-detail";
    detail.append(this.rhythmCircles(loop, rerender));
    wrap.append(detail);
    wrap.append(this.patternGrid(loop, rerender));
    return wrap;
  }

  /** The transition's editing state — the surface the Effects tab edits, writing through
      to the transition's TARGET snapshot. A transition that has no snapshot of its own yet
      starts from the loop's sound. */
  private transitionDraftFor(loop: Loop, tr: LoopTransition): SoundDraft {
    if (!tr.draft) {
      if (!tr.snapshot.length) tr.snapshot = loop.snapshot.slice();
      tr.draft = new SoundDraft(tr.snapshot);
    }
    return tr.draft;
  }

  /** What the transition actually ARRIVES at: the edited target, time-mirrored when Reverse
      is on — the same derivation loopTransitionWindows does at compile time. The Sound tab's
      graph deliberately keeps drawing the un-mirrored `tr.snapshot` (the draft writes through
      to that array); everywhere the END sound is what matters — the preview, the ⧉ copies,
      the "params changed" count — goes through here instead. */
  private targetSnapshot(tr: LoopTransition): number[] {
    return tr.reverseOn ? reverseSnapshot(tr.snapshot) : tr.snapshot;
  }

  // --- transition preview (the shortened 4-bar loop) ---------------------

  /** Debounced: after edits settle, re-render the 4-bar preview and swap the loop to the
      latest changes. `now` skips the debounce (slider releases / opening the editor). */
  private schedulePreview(loop: Loop, tr: LoopTransition, now = false): void {
    clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      void this.playTransitionPreview(loop, tr);
    }, now ? 0 : 350);
  }

  /** Render a short loop of the transition offline (so it's exact), then loop the
      buffer — a shortened stand-in for the real thing while shaping it. "transition"
      mode plays the loop's sound morphing into the transformed sound across the chosen
      preview length as a real morph SWEEP window — following the Graph tab's function
      (drawn functions included) and gliding held notes, exactly like the track.
      "result" mode plays just the transformed sound. Stale renders (the user kept
      editing, or the editor closed) are dropped. */
  private async playTransitionPreview(loop: Loop, tr: LoopTransition): Promise<void> {
    if (loop.soundId < 0 || !loop.snapshot.length) return;
    const token = ++this.previewToken;
    const resultOnly = this.transPreviewMode === "result";
    const bars = Math.max(1, Math.min(64, Math.round(this.transPreviewBars)));
    const unit = loop.steps >= 1 ? loop.steps : STEPS_PER_BAR;
    const reps = Math.max(1, Math.floor((bars * STEPS_PER_BAR) / unit));
    const node = loopToNode(loop, reps);
    node.soundId = 0;
    node.intro = undefined;
    node.outro = undefined;
    const lenSteps = reps * unit;

    const withGain = (snap: number[]): number[] => {
      const s = snap.slice();
      if (loop.gain && loop.gain !== 1) s[ParamId.Volume] = (s[ParamId.Volume] ?? 0.85) * loop.gain;
      return s;
    };
    // The EFFECTIVE target, so both preview modes tell the same story as the track: with
    // Reverse on, "result" plays the mirrored sound on its own and "transition" travels to it.
    const target = tr.snapshot.length ? this.targetSnapshot(tr) : loop.snapshot;
    // In result-only mode the node's own sound (id 0) IS the transformed sound.
    const sounds: EngineSound[] = [
      { id: 0, snap: withGain(resultOnly ? target : loop.snapshot), tail: estimateLength(resultOnly ? target : loop.snapshot, this.tempo), span: snapshotAxisSeconds(resultOnly ? target : loop.snapshot, this.tempo) },
    ];
    // The morph window spans the whole preview loop, carrying the transition's blend
    // function verbatim (mirroring loopTransitionWindows — Volume as a ratio of the
    // loop's own so the gain makeup keeps riding along).
    let sweeps: SweepWindow[] | undefined;
    if (!resultOnly) {
      const morphSnap = target.slice();
      const ownVol = loop.snapshot[ParamId.Volume] ?? 0.85;
      morphSnap[ParamId.Volume] = (morphSnap[ParamId.Volume] ?? 0.85) / Math.max(0.05, ownVol);
      sweeps = [{
        from: 0, to: lenSteps, mode: "morph",
        modes: tr.speedOn ? ["morph", "speed"] : undefined,
        side: "out", morphSnap,
        shape: tr.shape, curve: tr.curve, dir: tr.dir, cycles: tr.cycles, points: tr.points,
        yGain: tr.yGain, yBias: tr.yBias, yMin: tr.yMin, yMax: tr.yMax,
        rate: tr.speedOn ? (tr.rate ?? 2) : undefined,
      }];
    }
    const arr = new LineArrangement();
    arr.setLanes([{ color: 0, nodes: [node], sweeps }], Math.ceil(lenSteps / STEPS_PER_BAR));
    try {
      const buffer = await this.engine.renderToBuffer({
        lines: arr.linesMessage(),
        sounds,
        tempo: this.tempo,
        maxSteps: lenSteps,
        tailSec: 0.1,
      });
      // Stale? A newer edit re-rendered, or the editor was left — drop this one.
      if (token !== this.previewToken || this.editTransition !== tr) return;
      this.engine.playPreviewLoop(buffer, this.stepsToSeconds(lenSteps));
    } catch { /* the preview is best-effort */ }
  }

  /** Silence the looping transition preview and cancel any pending render. */
  private stopPreview(): void {
    this.previewToken++;
    clearTimeout(this.previewTimer);
    this.engine.stopPreview();
  }

  /** One From/To endpoint row for a transition's swept parameter. Percent-style params
      (range ≤ 2) scrub as a percentage; wider ranges (filter Hz) scrub in native units at
      the spec's step so the drag stays usable, and the numpad still takes exact values. */
  /** One labelled control row (label left, control right) in the fade/sweep editors. */
  private labeledRow(label: string, control: HTMLElement): HTMLElement {
    const row = document.createElement("div");
    row.className = "placement-row fade-row";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = label;
    row.append(lbl, control);
    return row;
  }

  /** The blend-FUNCTION controls shared by loop fades and row sweeps: a Shape picker
      (see BLEND_SHAPES — line, s-curve, parabola, sine, cos, zigzag, wobble, steps,
      half wave), the shape's 0..1 knob under its own name (Curve / Steep / Skew / Warp /
      Depth / the half wave's Gap), a Waves/Steps count for the periodic shapes, and the
      ease/skew direction where it applies. Mutates `env` in place; every change
      recompiles so it's heard live. */
  /** A graph of a transition's blend curve: the swept value's path across the span,
      following the blend function (mirrors shapeT in engine.js), labelled with its
      start/end values. */
  /** The blend-curve graph for a ROW SWEEP: it applies to every loop on the row (no single
      snapshot), so the ends are labelled generically — the clean "sound" vs the effect (or
      the From/To overrides when set); "speed" is named by its far-end rate multiple.
      Left = window start, right = window end. */
  /** Draw the blend function's path (see blendShape in lines.ts — mirrors the engine's
      shapeT) into an SVG graph with a quarter grid, with left/right end labels. Shared
      by the loop-fade and row-sweep editors. */
  /** One Life side (accent/ghost): mode segment + its parameter rows. */
  private lifeRow(loop: Loop, kind: "accent" | "ghost", rerender: () => void): HTMLElement {
    const row = document.createElement("div");
    row.className = "placement-row fade-row";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = kind === "accent" ? "Accents" : "Ghosts";

    const spec = loop[kind];
    const controls = document.createElement("div");
    controls.className = "fade-controls";

    const cur: "off" | "everyN" | "ramp" = spec ? spec.mode : "off";
    const seg = document.createElement("div");
    seg.className = "placement-seg fade-modes";
    const defAmount = kind === "accent" ? 0.6 : 0.7;
    const mk = (m: "off" | "everyN" | "ramp", text: string) => {
      const b = document.createElement("button");
      b.className = "seg-btn" + (cur === m ? " on" : "");
      b.textContent = text;
      b.onclick = () => {
        if (m === "off") loop[kind] = undefined;
        else if (m === "everyN") loop[kind] = { mode: "everyN", every: 2, amount: defAmount };
        else loop[kind] = { mode: "ramp", curve: 0, dir: "up", amount: defAmount };
        // Activating a deterministic placement OVERWRITES the sound's own shuffled
        // accent/ghost so the placement is the single source of truth (not a random
        // layer the engine merely masks while the spec is live). Off leaves the sound's
        // own feel intact, so it can fall back to it.
        if (m !== "off") this.overwriteShuffledLife(loop, kind);
        this.recompile();
        rerender();
      };
      return b;
    };
    seg.append(mk("off", "Off"), mk("everyN", "Every-N"), mk("ramp", "Ramp"));
    controls.append(seg);

    if (spec) {
      if (spec.mode === "everyN") {
        controls.append(this.numRow("Every", () => spec.every ?? 2, (n) => {
          spec.every = Math.max(1, Math.round(n));
          this.recompile();
        }, rerender, () => { const e = spec.every ?? 2; return `${e} hit${e === 1 ? "" : "s"}`; }));
        // Which hit in each group of N is marked — 0 = the first, 1 = the second, a
        // negative offset counts from the end (-1 = the last). The hint resolves the raw
        // offset to its 1-based position within the current group size.
        controls.append(this.numRow("Offset", () => spec.offset ?? 0, (n) => {
          spec.offset = Math.round(n);
          this.recompile();
        }, rerender, () => {
          const n = Math.max(1, spec.every ?? 2);
          const pos = ((((spec.offset ?? 0) % n) + n) % n) + 1;
          return `hit ${pos} of ${n}`;
        }));
      } else {
        const dirSeg = document.createElement("div");
        dirSeg.className = "placement-seg fade-modes";
        const mkDir = (d: "up" | "down", text: string) => {
          const b = document.createElement("button");
          b.className = "seg-btn" + ((spec.dir ?? "up") === d ? " on" : "");
          b.textContent = text;
          b.onclick = () => { spec.dir = d; this.recompile(); rerender(); };
          return b;
        };
        dirSeg.append(mkDir("up", "Swell in"), mkDir("down", "Swell out"));
        controls.append(dirSeg);
        controls.append(this.numRow("Curve", () => Math.round((spec.curve ?? 0) * 100), (n) => {
          spec.curve = Math.max(0, Math.min(1, Math.round(n) / 100));
          this.recompile();
        }, rerender, () => `${Math.round((spec.curve ?? 0) * 100)}%`));
      }
      controls.append(this.numRow("Amount", () => Math.round(spec.amount * 100), (n) => {
        spec.amount = Math.max(0, Math.min(1, Math.round(n) / 100));
        this.recompile();
      }, rerender, () => `${Math.round(spec.amount * 100)}%`));
    }
    row.append(lbl, controls);
    return row;
  }

  /** Overwrite a loop's own shuffled accent/ghost with the neutral value, so an active
      per-loop LifePlacement (see lifeRow) fully replaces it instead of leaving a random
      layer baked into the snapshot. Accent → AccentAmount 0 (no ducking); ghost →
      HitChance 1 (no dropped/ghosted hits) — the same neutralisation the sound's own
      Accent/Ghosts modules use when switched off. Resends the sound table so the engine
      picks up the changed snapshot (recompile only resends lanes). */
  private overwriteShuffledLife(loop: Loop, kind: "accent" | "ghost"): void {
    if (!loop.snapshot.length) return;
    loop.snapshot[kind === "accent" ? ParamId.AccentAmount : ParamId.HitChance] =
      kind === "accent" ? 0 : 1;
    this.pushSounds();
  }

  /** A labelled scrub/numpad row inside the placement popup. `step` (native units per scrub
      tick) lets a wide range like filter Hz scrub coarsely while still typing exact values. */
  private numRow(label: string, read: () => number, write: (n: number) => void, commit: () => void, show: () => string, step = 1): HTMLElement {
    const row = document.createElement("div");
    row.className = "placement-row";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = label;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.readOnly = true;
    inp.inputMode = "none";
    inp.value = show();
    this.attachScrub(inp, { label, read, write, show, commit, step });
    row.append(lbl, inp);
    return row;
  }

  // --- rhythm circles (per loop) ----------------------------------------
  private rhythmCircles(loop: Loop, commit: () => void): HTMLElement {
    const mkNum = (label: string, field: RhythmField, disabled = false) => {
      const cell = document.createElement("div");
      // Push shows a fraction ("−1/64"), not a bare number: it gets a wider well.
      cell.className = "euclid-num" + (field === "push" ? " wide" : "");
      const lab = document.createElement("span");
      lab.textContent = label;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = this.rhythmText(loop, field);
      inp.readOnly = true;
      inp.inputMode = "none";
      inp.disabled = disabled;
      if (!disabled) {
        this.attachScrub(inp, {
          label,
          color: loop.soundId >= 0 ? loop.color : undefined,
          read: () => this.rhythmValue(loop, field),
          write: (n) => this.applyRhythm(loop, field, n),
          show: () => this.rhythmText(loop, field),
          // One drag tick = one notch of push (1/128 of a bar); every other field counts 1.
          step: field === "push" ? 1 / PUSH_STEPS_PER_BAR : 1,
          commit,
        });
      }
      cell.append(lab, inp);
      return cell;
    };

    const splitLocked = loop.hits < 2 || maxSplitGap(loop.hits, loop.steps) <= 1;
    const vals = document.createElement("div");
    vals.className = "euclid-vals";
    vals.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#808080");
    vals.append(
      mkNum("Hits", "hits"),
      mkNum("Steps", "steps"),
      mkNum("Start", "rotation"),
      mkNum("Split", "split", splitLocked),
      // Push sits with the rest of the timing: where the hits LAND, once the pattern has
      // said which steps they're on. Off the grid by eighths of a step (see PUSH_UNIT),
      // negative landing ahead of the beat.
      mkNum("Push", "push"),
    );
    return vals;
  }

  /** A rhythm field's value in the units it is scrubbed and typed in. Push counts in BARS
      (a fraction of one), not in the steps it's stored in, so the numpad takes the same
      "1/64" the field shows. */
  private rhythmValue(loop: Loop, field: RhythmField): number {
    if (field === "hits") return loop.hits;
    if (field === "steps") return loop.steps;
    if (field === "rotation") return loop.rotation;
    if (field === "push") return (loop.push ?? 0) / STEPS_PER_BAR;
    return loop.split ?? evenGap(loop.hits, loop.steps);
  }

  /** What a rhythm field shows. Push reads as the fraction of a BAR it moves the hits —
      the unit the ear counts in — rather than a raw number: one notch is "+1/128". */
  private rhythmText(loop: Loop, field: RhythmField): string {
    if (field !== "push") return String(this.rhythmValue(loop, field));
    const n = this.pushNotches(this.rhythmValue(loop, field));
    if (n === 0) return "0";
    // n notches = n/128 of a bar; reduce so the common ones read as 1/64, 1/32, 3/64 …
    let num = Math.abs(n), den = PUSH_STEPS_PER_BAR;
    while (num % 2 === 0 && den % 2 === 0) { num /= 2; den /= 2; }
    return `${n < 0 ? "−" : "+"}${num}/${den}`;
  }

  /** A push in bars, snapped to whole notches (1/128 of a bar) and clamped to just under
      a whole step either way — see PUSH_UNIT/MAX_PUSH. */
  private pushNotches(bars: number): number {
    const max = Math.round(MAX_PUSH / PUSH_UNIT);
    return Math.max(-max, Math.min(max, Math.round(bars * PUSH_STEPS_PER_BAR)));
  }

  private applyRhythm(loop: Loop, field: RhythmField, n: number): void {
    if (Number.isNaN(n)) n = 0;
    if (field === "push") {
      // Timing only — the pattern is untouched, so this one does NOT drop patternOv.
      const notches = this.pushNotches(n);
      loop.push = notches === 0 ? undefined : notches * PUSH_UNIT;
      this.recompile();
      return;
    }
    // Editing the circles hands the pattern back to the Euclid derivation.
    loop.patternOv = undefined;
    if (field === "steps") loop.steps = clampSteps(n);
    else if (field === "hits") loop.hits = Math.max(0, Math.min(MAX_STEPS, Math.round(n)));
    else if (field === "rotation") loop.rotation = Math.round(n);
    else loop.split = Math.max(1, Math.min(maxSplitGap(loop.hits, loop.steps), Math.round(n)));
    if (loop.steps >= 1 && loop.hits > loop.steps) loop.hits = loop.steps;
    this.recompile();
  }

  // --- loop sound editing (the sound graph) ------------------------------
  /** The loop's editing state, made on first use and kept for the life of the loop. The
      draft writes THROUGH to `loop.snapshot` (see model/sound.ts), so there is nothing to
      copy back — only the rest of the write path, in writeLoopFromEditor. */
  private draftFor(loop: Loop): SoundDraft {
    if (!loop.draft) {
      loop.draft = new SoundDraft(loop.snapshot);
      loop.draft.maxLen = ROW_MAXLEN_SEC[this.colorOf(loop)] ?? 0; // per-row default cap
    }
    return loop.draft;
  }

  /** Finish an edit to a loop's sound: the draft has already written the values into
      `loop.snapshot`, so what is left is the rest of the write path — mint the sound id on
      the first edit, refresh the description, resend the sound table, recompile, persist. */
  private writeLoopFromEditor(loop: Loop): void {
    const draft = this.draftFor(loop);
    if (loop.soundId < 0) {
      loop.soundId = this.nextSoundId++;
      loop.color = VOICE_COLORS[this.colorOf(loop) % VOICE_COLORS.length];
      if (loop.steps < 1) { loop.steps = 16; loop.hits = 1; loop.rotation = 0; }
    }
    loop.name = draft.describe().join(" · ");
    this.pushSounds();
    this.recompile();
  }

  private colorOf(loop: Loop): number {
    for (let c = 0; c < this.track.colors.length; c++) {
      if (this.track.colors[c].loops.includes(loop)) return c;
    }
    return this.openColor;
  }

  private auditionLoop(loop: Loop): void {
    this.withAudio(() => {
      const snap = loop.snapshot.slice();
      if (loop.gain && loop.gain !== 1) snap[ParamId.Volume] = (snap[ParamId.Volume] ?? 0.85) * loop.gain;
      this.engine.audition(snap, Math.round(this.engine.sampleRate * 0.4), estimateLength(snap, this.tempo), snapshotAxisSeconds(snap, this.tempo));
    });
  }

  /** One-shot audition of whatever sound a draft currently holds (a loop's own sound, or
      a transition's transformed sound) — used by the graph tap-to-play. */
  private auditionDraft(draft: SoundDraft): void {
    this.withAudio(() => {
      const snap = draft.capture();
      this.engine.audition(snap, Math.round(this.engine.sampleRate * 0.4), estimateLength(snap, this.tempo), snapshotAxisSeconds(snap, this.tempo));
    });
  }

  /** Closed-loop loudness pass for a loop: render one hit offline, measure it, and store
      the makeup gain that lands it at the reference loudness (best-effort). */
  private async normalizeLoop(loop: Loop): Promise<void> {
    if (loop.soundId < 0 || !loop.snapshot.length) return;
    // The draft writes through, so the snapshot array's identity never changes — its
    // REVISION is what says whether this measurement is still about the sound on screen.
    const draft = this.draftFor(loop);
    const token = draft.rev;
    const meas = loop.snapshot.slice();
    meas[ParamId.Volume] = 1;
    meas[ParamId.HitChance] = 1;
    meas[ParamId.Ratchet] = 0;
    meas[ParamId.Humanize] = 0;
    try {
      const tail = Math.min(1.6, Math.max(0.4, estimateLength(meas, this.tempo)));
      const buffer = await this.engine.renderToBuffer({
        lines: [{ nodes: [{ soundId: 0, steps: 1, lenSteps: STEPS_PER_BAR, waitSteps: 0, pattern: [1] }] }],
        sounds: [{ id: 0, snap: meas, tail: 0, span: snapshotAxisSeconds(meas, this.tempo) }],
        tempo: this.tempo,
        maxSteps: 1,
        tailSec: tail,
      });
      if (draft.rev !== token) return;
      loop.gain = makeupGain(measureLoudness(buffer));
      this.pushSounds();
      this.persist();
    } catch { /* keep previous gain */ }
  }

  private async writeAndNormalizeLoop(loop: Loop): Promise<void> {
    this.writeLoopFromEditor(loop);
    await this.normalizeLoop(loop);
  }

  /** Mint an audible sound for a fresh loop: a shuffle, or — when the DECK is the open
      layout — the drone start it is built around (see {@link SoundDraft.resetToDrone}).
      The layout is the whole signal: a shuffled hit is what you want a new loop to be when
      you are working on the graph or the sheet, and a held note is what you want it to be
      when you are on the screen for shaping one. Existing sounds are never touched either
      way — ∞ on the deck's toolbar is how an already-minted sound becomes a drone.

      A drone is minted as a RHYTHM as well as a sound, because the two only work together:
      the hold has to reach the next hit or the drone breathes in and out, and it must not
      overshoot it either — an 8s note against a hit every 2s stacks four copies of itself,
      and past the engine's six voices the seventh steals a live one mid-note, which clicks.
      So: one hit every MAX_STEPS (the longest gap the model allows — 4 bars), with the gate
      fitted to exactly that gap at the current tempo. One note holds until the next begins. */
  private mintLoopSound(loop: Loop): void {
    const draft = this.draftFor(loop);
    if (this.soundLayout === "deck") {
      loop.steps = MAX_STEPS;
      loop.hits = 1;
      loop.rotation = 0;
      draft.resetToDrone(this.stepsToSeconds(MAX_STEPS));
    } else {
      draft.shuffle(this.shuffleContext(), randomSeed());
    }
    this.writeLoopFromEditor(loop);
    void this.normalizeLoop(loop);
  }

  /** How long a run of sequencer steps lasts at the current tempo. Steps are 16ths, so a
      step is a quarter of a beat. */
  private stepsToSeconds(steps: number): number {
    return (steps * 60) / Math.max(1, this.tempo) / 4;
  }

  /** Seconds between this loop's own hits, which is the gate a drone on it wants: the note
      then reaches the next hit without overshooting it. `undefined` when the loop has no
      rhythm yet, so the drone falls back to its own default hold. */
  private loopGapSeconds(loop: Loop): number | undefined {
    if (loop.steps < 1) return undefined;
    return this.stepsToSeconds(loop.steps / Math.max(1, loop.hits));
  }

  private toast(text: string): void {
    document.querySelector(".toast")?.remove();
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    this.root.append(t);
    setTimeout(() => t.remove(), 1700);
  }

  private shuffleContext(): { root: number; scale: number; bpm: number } {
    return { root: this.track.root, scale: this.track.scale, bpm: this.tempo };
  }

  // --- number entry helpers ---------------------------------------------
  /** Make a read-only number input scrub (click-hold + drag) or tap to open the numpad.
      `read`/`write` mutate the model; `show` formats the input; `commit` re-renders. */
  private attachScrub(input: HTMLInputElement, opts: {
    label: string;
    color?: string;
    read: () => number;
    write: (n: number) => void;
    show?: () => string;
    commit?: () => void;
    step?: number; // native units moved per scrub tick (default 1)
  }): void {
    const PX_PER_STEP = 7;
    const step = opts.step ?? 1;
    let startY = 0, startVal = 0, dragging = false, moved = false;
    const show = () => { input.value = opts.show ? opts.show() : String(opts.read()); };
    const commit = opts.commit ?? (() => this.render());

    input.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      startY = e.clientY;
      startVal = opts.read();
      dragging = true;
      moved = false;
      input.setPointerCapture(e.pointerId);
    });
    input.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const delta = Math.round((startY - e.clientY) / PX_PER_STEP);
      if (delta === 0 && !moved) return;
      if (!moved) { moved = true; input.blur(); }
      e.preventDefault();
      opts.write(startVal + delta * step);
      show();
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { input.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (moved) { commit(); return; }
      this.openNumpad({
        title: opts.label,
        // The pad quotes the value the way the FIELD does (a push reads "−1/64", not
        // -0.0078125); it's only the "now" line, and what's typed is parsed as a number.
        value: opts.show ? opts.show() : startVal,
        color: opts.color,
        onSubmit: (n) => { opts.write(n); commit(); },
      });
    };
    input.addEventListener("pointerup", end);
    input.addEventListener("pointercancel", end);
  }

  /** The custom on-screen numpad. Single-value by default (`onSubmit` gets the number;
      a dot key allows decimals, e.g. 2.5 waves); pass `list: true` for a comma-separated
      list (a comma key replaces the dot and `onSubmitList` gets the raw string). A Clear
      (C) key wipes the buffer like a calculator. */
  private openNumpad(opts: {
    title: string;
    value: number | string;
    color?: string;
    list?: boolean;
    onSubmit?: (n: number) => void;
    onSubmitList?: (raw: string) => void;
  }): void {
    document.querySelector(".numpad-overlay")?.remove();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    const list = !!opts.list;
    const maxLen = list ? 60 : 6;
    let buf = "";
    const overlay = document.createElement("div");
    overlay.className = "numpad-overlay";
    const pad = document.createElement("div");
    pad.className = "numpad";
    if (opts.color) pad.style.setProperty("--vc", opts.color);

    const head = document.createElement("div");
    head.className = "numpad-head win-title";
    const title = document.createElement("span");
    title.className = "numpad-title";
    title.textContent = opts.title;
    const hint = document.createElement("span");
    hint.className = "numpad-hint";
    hint.textContent = `now ${opts.value}`;
    head.append(title, hint);

    const display = document.createElement("div");
    display.className = "numpad-display" + (list ? " list" : "");
    const refresh = () => {
      display.textContent = buf === "" ? String(opts.value) : buf;
      display.classList.toggle("empty", buf === "");
    };
    refresh();

    // Parse the buffer: a plain (optionally negative/decimal) number, OR an "a/b" fraction
    // (e.g. "1/3" -> 0.333, "-3/4" -> -0.75). Guards a zero/empty denominator with NaN.
    const evalNum = (str: string): number => {
      const m = str.match(/^(-?\d*\.?\d+)\/(\d*\.?\d+)$/);
      if (m) { const d = parseFloat(m[2]); return d === 0 ? NaN : parseFloat(m[1]) / d; }
      return parseFloat(str);
    };
    const close = () => { document.removeEventListener("keydown", onKey, true); overlay.remove(); };
    const submit = () => {
      if (list) opts.onSubmitList?.(buf);
      else if (buf !== "" && !Number.isNaN(evalNum(buf))) opts.onSubmit?.(evalNum(buf));
      close();
    };
    const press = (d: string) => { if (buf.length < maxLen) { buf += d; refresh(); } };
    const comma = () => {
      // No leading comma, no doubling; a single ", " separator.
      if (buf === "" || buf.endsWith(",") || buf.endsWith(", ")) return;
      if (buf.length < maxLen) { buf += ", "; refresh(); }
    };
    const dot = () => {
      // One decimal point per number; an empty buffer starts "0." like a calculator.
      if (buf.includes(".")) return;
      if (buf.length < maxLen) { buf = buf === "" ? "0." : buf + "."; refresh(); }
    };
    const backspace = () => { buf = buf.replace(/, $|.$/, ""); refresh(); };
    const clear = () => { buf = ""; refresh(); };
    // Sign toggle: flip a leading "-" on the whole value (works with fractions too).
    const negate = () => { buf = buf.startsWith("-") ? buf.slice(1) : "-" + buf; refresh(); };
    // Fraction bar: one per number, never leading or straight after a decimal point.
    const frac = () => {
      if (buf.includes("/") || buf === "" || buf === "-" || buf.endsWith(".")) return;
      if (buf.length < maxLen) { buf += "/"; refresh(); }
    };

    const grid = document.createElement("div");
    grid.className = "numpad-grid";
    const key = (glyph: string, cls: string, fn: () => void) => {
      const b = document.createElement("button");
      b.className = "numpad-key" + (cls ? " " + cls : "");
      b.textContent = glyph;
      b.onclick = fn;
      return b;
    };
    ["1", "2", "3", "4", "5", "6", "7", "8", "9"].forEach((d) => grid.append(key(d, "", () => press(d))));
    grid.append(key("C", "clear", clear), key("0", "", () => press("0")), key("⌫", "back", backspace));
    if (list) {
      // Bar-index lists don't take signs or fractions: keep the compact comma + wide ✓.
      grid.append(key(",", "comma", comma), key("✓", "enter wide2", submit));
    } else {
      // Single-value pad: a modifier row (decimal / sign / fraction) then a full-width ✓.
      grid.append(key(".", "comma", dot), key("±", "sign", negate), key("/", "frac", frac));
      grid.append(key("✓", "enter wide3", submit));
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") press(e.key);
      else if (list && (e.key === "," || e.key === " ")) comma();
      else if (!list && (e.key === "." || e.key === ",")) dot();
      else if (!list && (e.key === "-" || e.key === "_")) negate();
      else if (!list && e.key === "/") frac();
      else if (e.key === "Backspace") backspace();
      else if (e.key === "Enter") submit();
      else if (e.key === "Escape") close();
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey, true);
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    pad.append(head, display, grid);
    overlay.append(pad);
    this.root.append(overlay);
  }

  // --- mixer view -------------------------------------------------------
  private renderMixer(): void {
    const v = this.viewRoot;
    this.mixerLeds = new Map();

    const head = document.createElement("div");
    head.className = "mixer-head";
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = this.mixerReturn === "grid" ? "‹ Loops" : "‹ Track";
    back.onclick = () => { this.view = this.mixerReturn; this.render(); };
    const title = document.createElement("h2");
    title.className = "mixer-title";
    title.textContent = "Mixer";
    head.append(back, title);
    v.append(head);
    v.append(this.mixerStripList());
  }

  /** The mixer strips — one per sounding colour (or a hint when the track is empty).
      Shared by the mixer view and the row panels' Mixer tab. Requires
      this.mixerLeds to be a fresh Map (render() nulls it; renderMixer / the tabs re-init). */
  private mixerStripList(): HTMLElement {
    this.mixerLeds = new Map();
    const active = this.track.colors.map((_, i) => i).filter((i) => this.track.colors[i].loops.some((l) => l.soundId >= 0));
    if (active.length === 0) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "No loops yet. Add loops to the colours, then mix them here.";
      return hint;
    }
    const list = document.createElement("div");
    list.className = "mixer-list";
    active.forEach((c) => list.append(this.mixerStrip(c)));
    return list;
  }

  /** A single mixer strip for one colour (all its loops move together). */
  private mixerStrip(c: number): HTMLElement {
    const ct = this.track.colors[c];
    const sounds = ct.loops.filter((l) => l.soundId >= 0);
    return this.buildMixStrip(`Voice ${c + 1}`, VOICE_COLORS[c], ct, sounds);
  }

  /** Build a mixer strip: LED + name + mute/solo (on `ct`) + Vol/Verb/Pan faders that move
      every sound in `sounds` together. */
  private buildMixStrip(name: string, laneColor: string, ct: { mute?: boolean; solo?: boolean }, sounds: Loop[]): HTMLElement {
    const strip = document.createElement("div");
    strip.className = "mix-strip";
    strip.style.setProperty("--lane", laneColor);

    const hd = document.createElement("div");
    hd.className = "mix-strip-head";
    const led = document.createElement("span");
    led.className = "mix-led";
    for (const l of sounds) this.mixerLeds!.set(l.soundId, led);
    const nameEl = document.createElement("span");
    nameEl.className = "mix-name";
    nameEl.textContent = name;

    const toggles = document.createElement("div");
    toggles.className = "mix-toggles";
    const mute = document.createElement("button");
    mute.className = "mix-toggle mute" + (ct.mute ? " on" : "");
    mute.textContent = "M";
    mute.title = "Mute";
    const solo = document.createElement("button");
    solo.className = "mix-toggle solo" + (ct.solo ? " on" : "");
    solo.textContent = "S";
    solo.title = "Solo";
    mute.onclick = () => { ct.mute = !ct.mute; mute.classList.toggle("on", !!ct.mute); this.pushSounds(); this.persist(); };
    solo.onclick = () => { ct.solo = !ct.solo; solo.classList.toggle("on", !!ct.solo); this.pushSounds(); this.persist(); };
    toggles.append(mute, solo);
    hd.append(led, nameEl, toggles);
    strip.append(hd);

    strip.append(this.mixFader("Vol", sounds, ParamId.Volume));
    strip.append(this.mixFader("Verb", sounds, ParamId.ReverbMix));
    strip.append(this.mixFader("Pan", sounds, ParamId.Pan, -1, 1));
    return strip;
  }

  /** A labelled fader bound to one snapshot index of every sound in `sounds`. */
  private mixFader(label: string, sounds: Loop[], id: ParamId, min = 0, max = 1): HTMLElement {
    const first = sounds[0];
    const row = document.createElement("div");
    row.className = "mix-fader";
    const lbl = document.createElement("span");
    lbl.className = "mix-fader-lbl";
    lbl.textContent = label;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(min);
    slider.max = String(max);
    slider.step = "0.02";
    slider.value = String(first?.snapshot[id] ?? baseSpec(id).def);
    const val = document.createElement("span");
    val.className = "mix-fader-val";
    const showVal = (x: number) => {
      if (min >= 0) return `${Math.round(x * 100)}`;
      if (Math.abs(x) < 0.01) return "C";
      return `${x < 0 ? "L" : "R"}${Math.round(Math.abs(x) * 100)}`;
    };
    val.textContent = showVal(Number(slider.value));
    slider.oninput = () => {
      const x = Number(slider.value);
      for (const l of sounds) {
        for (let i = l.snapshot.length; i < NUM_PARAMS; i++) l.snapshot[i] = baseSpec(i as ParamId).def;
        l.snapshot[id] = x;
      }
      val.textContent = showVal(x);
      this.pushSounds();
      this.persist();
    };
    row.append(lbl, slider, val);
    return row;
  }

}
