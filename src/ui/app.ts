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
import { ParamId, NUM_PARAMS, PITCH_DRAW_BASE, PITCH_DRAW_SLOTS } from "../model/params";
import { baseSpec, PITCH_SHAPE_DRAWN } from "../model/paramSpec";
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
  LineArrangement, STEPS_PER_BAR, NUM_LINES, VOICE_COLORS,
  BLEND_SHAPES, blendShapeSpec, blendShape, blendShapeY, SweepWindow,
} from "../model/lines";
import { fitBlendShape, DRAWN_POINTS } from "../model/curveFit";
import {
  Track, Loop, EveryRule, LoopTransition, emptyLoop, cloneLoop, loopToNode,
  randomSeed as newSeed, ruleLengths, defaultLoopTransition,
  placementsFor,
} from "../model/track";
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

// The colour panel's timeline wraps to a new row ("line") every this many bars, so a long
// track stays legible.
const BARS_PER_ROW = 32;

// The track overview draws each colour as a column of this many blocks, ALWAYS — a block
// covers barLimit/OVERVIEW_BLOCKS bars, so the whole track fits one screenful at any
// length (and at the 256-bar default a block is exactly 16 bars).
const OVERVIEW_BLOCKS = 16;

type View = "track" | "color" | "mixer";

// The loop editor's three pages. Named because the tabs that pick them live out on the
// loop rows now, so the type crosses between the list and the popup.
type PlacementTab = "sound" | "loop" | "transition";

// The editable numeric fields of a loop's rhythm (its scrubbable number circles).
type RhythmField = "hits" | "steps" | "rotation" | "split";

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
  private openColor = 0;               // which colour panel is open
  private editLoop: Loop | null = null; // loop whose placement popup is open
  private placementTab: PlacementTab = "sound"; // which sub-page of the loop popup
  // Loop tab sub-view: the main page (default), or the panels the action buttons open.
  private loopSub: "grid" | "options" | "life" = "grid";
  // Loop-tab drag grid: rows shown. A view preference — the grid auto-grows past it so
  // the whole track always fits.
  private placeGridRows = 8;
  // The open Loop-tab pattern grid's step cells + step count, so the transport can light
  // the currently-sounding step while playing (cleared when the popup closes).
  private patternPlayCells: HTMLElement[] | null = null;
  private patternPlaySteps = 0;
  // Bar-square grids (loop placement / transition bars / the play range): how many bars
  // one square is worth (1 / 2 / 4), and the armed Start→End pick (start 0 = awaiting
  // the start square).
  private gridSpan: Record<"place" | "trans" | "range", number> = { place: 2, trans: 2, range: 2 };
  private gridPick: { key: "place" | "trans" | "range"; start: number } | null = null;
  // The popup's view identity at the last rebuild — an unchanged key means an in-place
  // rebuild (a value scrub, a toggle), whose scroll position is preserved.
  private popupViewKey = "";
  // The SOUND GRAPH (the popup's Sound tab): the trace whose equation is open (null =
  // the coloured trace buttons) and which button page shows (0 = active settings;
  // later pages = the inactive ones).
  private graphTrace: string | null = null;
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
    const sec = (steps * 60) / Math.max(1, this.tempo) / 4;
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

    if (this.view === "color") this.renderColorPanel();
    else if (this.view === "mixer") this.renderMixer();
    else this.renderTrackPanel();

    this.updateLoopTime();

    // An open placement popup floats above everything (appended to root, so it survives
    // the panel re-render below it).
    if (this.view === "color" && this.editLoop) this.openPlacement(this.editLoop);
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
  /** A MULTI-select bar strip (the play-range gesture, but several bars/ranges at once):
      tap a bar to toggle it; drag to paint a contiguous span on or off (the anchor bar's
      starting state decides which). `read`/`write` are the 1-indexed selected bars; `write`
      fires live during the drag (engine-only), and `commit` runs once on release for the
      full re-render. Tinted by the container's `--vc`. */
  private multiBarStrip(
    barLimit: number,
    read: () => number[],
    write: (bars: number[]) => void,
    commit: () => void,
  ): HTMLElement {
    const strip = document.createElement("div");
    strip.className = "play-range-strip multi-bar-strip";
    const cells: HTMLElement[] = [];
    for (let b = 0; b < barLimit; b++) {
      const cell = document.createElement("span");
      cell.className = "play-range-cell" + (b % 4 === 0 ? " tick" : "");
      cells.push(cell);
      strip.append(cell);
    }
    const paint = (set: Set<number>) => {
      for (let b = 0; b < barLimit; b++) cells[b].classList.toggle("sel", set.has(b + 1));
    };
    paint(new Set(read()));

    const barAt = (clientX: number) => {
      const rect = strip.getBoundingClientRect();
      const frac = Math.max(0, Math.min(0.9999, (clientX - rect.left) / Math.max(1, rect.width)));
      return Math.max(1, Math.min(barLimit, Math.floor(frac * barLimit) + 1));
    };
    // Each drag paints the swept span [anchor, bar] to `paintOn`, computed fresh from the
    // pre-drag snapshot so sweeping back and forth doesn't accumulate.
    let base = new Set<number>();
    let anchor = 0, paintOn = true;
    const applyTo = (bar: number): number[] => {
      const lo = Math.min(anchor, bar), hi = Math.max(anchor, bar);
      const next = new Set(base);
      for (let i = lo; i <= hi; i++) { if (paintOn) next.add(i); else next.delete(i); }
      paint(next);
      return [...next].sort((a, b) => a - b);
    };
    const onMove = (e: PointerEvent) => write(applyTo(barAt(e.clientX)));
    const onUp = (e: PointerEvent) => {
      strip.removeEventListener("pointermove", onMove);
      strip.removeEventListener("pointerup", onUp);
      strip.removeEventListener("pointercancel", onUp);
      try { strip.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      commit();
    };
    strip.onpointerdown = (e) => {
      e.preventDefault();
      base = new Set(read());
      anchor = barAt(e.clientX);
      paintOn = !base.has(anchor);
      write(applyTo(anchor));
      try { strip.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      strip.addEventListener("pointermove", onMove);
      strip.addEventListener("pointerup", onUp);
      strip.addEventListener("pointercancel", onUp);
    };
    return strip;
  }

  private renderTrackPanel(): void {
    const v = this.viewRoot;
    // Whole-track overview: one VERTICAL COLUMN per colour, the whole timeline at once and
    // in one screenful whatever the track length. Each column is OVERVIEW_BLOCKS blocks
    // tall; a block covers barLimit/OVERVIEW_BLOCKS bars (exactly 16 at the 256-bar
    // default) and paints those bars as slices, so its fill shows both how many bars sound
    // and where they sit. No numbers anywhere — the column is a shape, not a table.
    // Tap a column to open that colour's loop list.
    this.voiceBtns = new Map();
    const barLimit = Math.max(1, this.track.barLimit);

    const overview = document.createElement("div");
    overview.className = "track-overview";
    // A horizontal line that slides down the columns as the track plays (see handlePlayhead).
    this.trackPlayheadEl = document.createElement("div");
    this.trackPlayheadEl.className = "track-playhead";
    overview.append(this.trackPlayheadEl);

    for (let c = 0; c < NUM_LINES; c++) {
      const ct = this.track.colors[c];
      const col = document.createElement("button");
      col.className = "track-color-col";
      col.style.setProperty("--vc", VOICE_COLORS[c]);
      col.title = `Voice ${c + 1}`;

      const bars = this.colorBarNumbers(c);
      for (let i = 0; i < OVERVIEW_BLOCKS; i++) {
        // Split by rounded boundaries rather than a fixed block size, so the blocks always
        // tile the track exactly even when barLimit isn't a multiple of OVERVIEW_BLOCKS.
        const from = Math.round((i * barLimit) / OVERVIEW_BLOCKS);
        const to = Math.round(((i + 1) * barLimit) / OVERVIEW_BLOCKS);
        col.append(this.overviewBlock(bars.slice(from, Math.max(from + 1, to)), c));
      }
      for (const l of ct.loops) if (l.soundId >= 0) this.voiceBtns.set(l.soundId, col);

      col.onclick = () => { this.openColor = c; this.view = "color"; this.editLoop = null; this.render(); };
      overview.append(col);
    }
    v.append(overview);
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
      const col = n > 0 ? this.shade(VOICE_COLORS[c], Math.min(0.9, 0.5 + (n - 1) * 0.16)) : "transparent";
      const a = ((i / cells.length) * 100).toFixed(4);
      const b = (((i + 1) / cells.length) * 100).toFixed(4);
      stops.push(`${col} ${a}% ${b}%`);
    }
    el.style.backgroundImage = `linear-gradient(to bottom, ${stops.join(", ")})`;
    return el;
  }

  // --- colour view (loop list) ------------------------------------------
  private renderColorPanel(): void {
    const v = this.viewRoot;
    const c = this.openColor;
    this.voiceBtns = new Map();

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

    // Just the loop list — mixing lives in the main-menu mixer, transitions in each
    // voice's own settings, so the old Transition / Mixer sub-tabs are gone.
    const loops = this.track.colors[c].loops;

    // Read-only timeline: the colour's compiled lanes across the whole track, so the
    // procedural placement is visible (one row per lane; a bar is lit where it sounds).
    if (loops.some((l) => l.soundId >= 0)) v.append(this.colorPreview(c));

    const list = document.createElement("div");
    list.className = "loop-list";
    loops.forEach((loop, i) => list.append(this.loopRow(loop, i)));
    v.append(list);

    const add = document.createElement("button");
    add.className = "loop-add";
    add.textContent = "＋ Add loop";
    add.onclick = () => this.addLoop(c);
    v.append(add);
  }

  /** The row's Transition tab: a LIST of overarching FX sweeps, each across its own bar
      range of the whole row (see RowSweep / the engine's line sweeps). Cards may overlap —
      the engine composes them, each morphing the result of the previous. */
  /** One row-transition card: On/Off + remove, a draggable placement strip (the same
      gesture as the play range), a MULTI-SELECT style row (active styles are lit and
      sweep together), direction into/out of the effect, and the ramp curve + preview. */
  /** Toggle one style in a transition's multi-select set. Every style stacks — "speed"
      included (it warps the timing while the tonal styles morph the tone) — and the last
      active style can't be removed. */
  /** One row in a colour's loop list: priority reorder (solo), name + rule summary,
      remove, and — across the card's foot — the loop's own Sound / Loop / Transitions tabs.
      The tabs live HERE rather than inside the popup so any of the three pages is one tap
      away from the list, and so the popup itself doesn't spend a row on navigation. */
  private loopRow(loop: Loop, i: number): HTMLElement {
    const c = this.openColor;
    const loops = this.track.colors[c].loops;
    const row = document.createElement("div");
    // .loop-row-tabs stacks the card: the strip below, then the tab nav. (Plain .loop-row
    // stays a horizontal strip — the transition list reuses it as one.)
    row.className = "loop-row loop-row-tabs";
    row.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#808080");

    // Reorder controls (priority for solo loops; list order in general).
    const order = document.createElement("div");
    order.className = "loop-order";
    const up = document.createElement("button");
    up.className = "loop-move";
    up.textContent = "▲";
    up.title = "Higher priority";
    up.disabled = i === 0;
    up.onclick = (e) => { e.stopPropagation(); this.moveLoop(c, i, -1); };
    const down = document.createElement("button");
    down.className = "loop-move";
    down.textContent = "▼";
    down.title = "Lower priority";
    down.disabled = i === loops.length - 1;
    down.onclick = (e) => { e.stopPropagation(); this.moveLoop(c, i, 1); };
    order.append(up, down);

    const body = document.createElement("button");
    body.className = "loop-body";
    if (loop.soundId >= 0) this.voiceBtns!.set(loop.soundId, body);
    const nm = document.createElement("span");
    nm.className = "loop-name";
    // The coined voice name (label); falls back to the sound description on older loops.
    nm.textContent = loop.label || loop.name || (loop.soundId >= 0 ? `Loop ${i + 1}` : "Empty loop");
    if (loop.label && loop.name) body.title = loop.name; // keep the sound description in reach
    const sum = document.createElement("span");
    sum.className = "loop-summary";
    sum.textContent = this.ruleSummary(loop);
    body.append(nm, sum);
    body.onclick = () => this.openPlacement(loop);

    const rm = document.createElement("button");
    rm.className = "loop-remove";
    rm.textContent = "×";
    rm.title = "Remove this loop";
    rm.onclick = (e) => { e.stopPropagation(); this.removeLoop(c, i); };

    const head = document.createElement("div");
    head.className = "loop-row-head";
    head.append(order, body, rm);

    // The three pages of this loop's editor, each opening the popup straight onto it.
    const nav = document.createElement("div");
    nav.className = "placement-seg loop-nav";
    const mkTab = (tab: PlacementTab, text: string) => {
      const b = document.createElement("button");
      b.className = "seg-btn";
      b.textContent = text;
      // No lit state: the popup covers the page, so this row is never visible while one of
      // its tabs is active — these are launchers, not a display of where you are.
      b.onclick = (e) => { e.stopPropagation(); this.openPlacement(loop, tab); };
      return b;
    };
    nav.append(mkTab("sound", "Sound"), mkTab("loop", "Loop"), mkTab("transition", "Transitions"));

    row.append(head, nav);
    return row;
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

  /** A row of timeline cells for one lane segment starting at absolute bar `startBar`.
      Cell value: -1 = pad (off the track), 0 = empty bar, >0 = a loop number. Each filled
      cell shows the BAR NUMBER it sits on; its shade encodes WHICH loop of the colour it is
      (the first is the base colour, each successive loop a shade lighter) so same-row loops
      still read apart. */
  private laneCells(cells: number[], c: number, startBar = 0): HTMLElement {
    const row = document.createElement("div");
    row.className = "color-preview-lane";
    for (let b = 0; b < cells.length; b++) {
      const cell = document.createElement("span");
      const num = cells[b];
      cell.className = "color-preview-cell" + (num > 0 ? " on" : num < 0 ? " pad" : "");
      if (num > 0) {
        // Loop 1 = the base colour, each later loop a shade lighter (capped so it stays legible).
        const t = Math.min(0.9, 0.5 + (num - 1) * 0.16);
        const bg = this.shade(VOICE_COLORS[c], t);
        cell.style.background = bg;
        // Dark text on light shades, light text on dark shades.
        const lum = 0.299 * parseInt(bg.slice(1, 3), 16) + 0.587 * parseInt(bg.slice(3, 5), 16) + 0.114 * parseInt(bg.slice(5, 7), 16);
        cell.style.color = lum > 150 ? "#000" : "#fff";
        cell.textContent = String(startBar + b + 1); // the bar this square sits on
      }
      row.append(cell);
    }
    return row;
  }

  /** Append a colour's lanes to `parent` as timeline rows, wrapping every BARS_PER_ROW
      bars into stacked "line" sub-rows. Used by the colour panel's preview; the track
      overview draws its own block columns instead (see renderTrackPanel). */
  private appendLanes(parent: HTMLElement, lanes: number[][], c: number): void {
    const barLimit = Math.max(1, this.track.barLimit);
    const segCount = Math.max(1, Math.ceil(barLimit / BARS_PER_ROW));
    const rowBars = segCount > 1 ? BARS_PER_ROW : barLimit;
    const laneList = lanes.length ? lanes : [new Array(barLimit).fill(0)];
    for (const cells of laneList) {
      for (let s = 0; s < segCount; s++) {
        const segCells: number[] = [];
        for (let i = 0; i < rowBars; i++) {
          const bar = s * rowBars + i;
          segCells.push(bar < barLimit ? cells[bar] : -1); // -1 pads a short final line
        }
        parent.append(this.laneCells(segCells, c, s * rowBars));
      }
    }
  }

  /** A read-only timeline of one colour's compiled lanes (used on the colour panel). */
  private colorPreview(c: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "color-preview";
    wrap.style.setProperty("--vc", VOICE_COLORS[c]);
    this.appendLanes(wrap, this.colorLaneNumbers(c), c);
    return wrap;
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
    this.openPlacement(loop);
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

  /** The placement popup for `loop`, showing ONE of its three pages — Sound = the FULL
      parameter editor, embedded; Loop = the rhythm circles + sequencer pattern grid + the
      placement squares; Transitions = the loop's transition list (each opening its Bars /
      Graph / Effects / Speed editor). Which one is chosen out in the list, by the tabs on
      the loop's own row, and passed in as `tab`; the popup carries no nav of its own, so
      each page gets the whole sheet.
      Omitting `tab` means "rebuild where we are": that's how every in-place re-render goes
      through here without resetting the page you're on.
      Rebuilt in place on any change (it's appended to the root, so it survives a panel
      re-render). */
  private openPlacement(loop: Loop, tab?: PlacementTab): void {
    // The sheet is rebuilt from scratch on every change, which would snap its scroll
    // back to the top — capture it before the old overlay goes, restore it below when
    // the rebuild is IN-PLACE (same tab/sub-page; a genuine navigation starts at top).
    const prevScroll = document.querySelector<HTMLElement>(".placement-overlay .voice-sheet")?.scrollTop ?? 0;
    document.querySelector(".placement-overlay")?.remove();
    // Stale cell refs from a previous Loop-tab render; patternGrid re-sets them if shown.
    this.patternPlayCells = null;
    // A genuine open: a different loop, or the same one re-entered through a tab.
    const opening = this.editLoop !== loop || tab !== undefined;
    if (opening) {
      // Land on the page the row's tab asked for (Sound when opened by the name alone) and
      // reset every sub-state the popup carries.
      this.placementTab = tab ?? "sound";
      this.loopSub = "grid";
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
      this.placementTab, this.loopSub,
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

    // While a transition's editor is open it takes the whole page — the popup's own
    // Sound / Loop / Transitions nav hides, and its back button folds into the header's
    // breadcrumb (Loops › name › Transition N) instead of a second row.
    const trs = loop.transitions ?? (loop.transitions = []);
    const openTr = this.placementTab === "transition" && this.editTransition && trs.includes(this.editTransition)
      ? this.editTransition
      : null;

    const head = document.createElement("div");
    head.className = "voice-sheet-head win-title";
    const loopName = loop.label || loop.name || "Loop";
    if (openTr) {
      // Breadcrumb: Loops (close) › name (back to the transition list) › Transition N.
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
        seg("‹ Loops", () => this.closePlacement()), sep(),
        seg(loopName, () => { this.stopPreview(); this.editTransition = null; this.gridPick = null; rerender(); }), sep(),
        cur,
      );
      head.append(crumb);
      // A ⧉ on the header's right edge lands the transformed sound as a new loop after
      // the transition. (On/Off lives in the transition list, so it's not repeated here.)
      const copy = document.createElement("button");
      copy.className = "voice-name-dice crumb-copy";
      copy.textContent = "⧉";
      copy.title = "New loop from this transformed sound, placed after the transition";
      copy.onclick = () => this.copyTransformedSound(loop, openTr);
      head.append(copy);
      sheet.append(head);
    } else {
      const back = document.createElement("button");
      back.className = "mixer-back";
      back.textContent = "‹ Loops";
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
      sheet.append(head);
      // The sound description under the coined name, for reference.
      if (loop.label && loop.name) {
        const sub = document.createElement("p");
        sub.className = "voice-sheet-sub";
        sub.textContent = loop.name;
        sheet.append(sub);
      }
    }

    // No tab nav here — the pages are picked by the tabs on the loop's row, and ‹ Loops
    // goes back to them.
    if (this.placementTab === "sound") {
      // The sound graph IS the sound panel.
      sheet.append(this.soundGraphPanel(this.graphHostForLoop(loop, rerender), rerender));
    } else if (this.placementTab === "transition") {
      if (openTr) sheet.append(this.transitionEditor(loop, openTr, rerender));
      else { this.editTransition = null; sheet.append(this.transitionList(loop, rerender)); }
    } else if (this.loopSub === "options") {
      // Procedural placement options (behind the ⚙ button): the Repeat-every rule.
      sheet.append(this.subPanelHead("Placement options", () => { this.loopSub = "grid"; rerender(); }));
      sheet.append(this.placementControls(loop, rerender));
    } else if (this.loopSub === "life") {
      sheet.append(this.subPanelHead("Accents & Ghosts", () => { this.loopSub = "grid"; rerender(); }));
      sheet.append(this.lifeControls(loop, rerender));
    } else {
      // Default Loop view: the rhythm circles up front, the sequencer pattern grid always
      // shown below them, the placement squares, then a row of small actions.
      const rhythmRow = document.createElement("div");
      rhythmRow.className = "loop-rhythm";
      const detail = document.createElement("div");
      detail.className = "euclid-detail";
      detail.append(this.rhythmCircles(loop, rerender));
      rhythmRow.append(detail);
      sheet.append(rhythmRow);
      sheet.append(this.patternGrid(loop, rerender));

      sheet.append(this.placementGrid(loop, rerender));

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
      actions.append(
        mkAction("⚙ Options", "Repeat rule", () => { this.loopSub = "options"; rerender(); }),
        mkAction("◔ Accents", "Accents & ghosts", () => { this.loopSub = "life"; rerender(); }),
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

  /** The shared bar-SQUARE grid (8 squares per row): the Loop tab's placement editor and
      a transition's Bars tab both use it. Each square is worth 1 / 2 / 4 bars (the
      per-grid squares picker). Tap toggles a square; drag paints a contiguous run on/off;
      the ⇱⇲ button arms a Start→End pick — the FIRST tap resets the grid and marks the
      start, the SECOND fills straight through to the end. Squares in `occupied` carry the
      faint stripe (context: other loops' bars, or — on a transition — where this loop
      itself sounds). With `grow`, painting past the track lengthens it (loop placement
      only); otherwise the grid is clamped to the track. */
  private barGrid(cfg: {
    key: "place" | "trans" | "range";
    color: string;
    read: () => number[];
    write: (bars: number[]) => void; // live during a drag (engine follows along)
    commit: () => void;              // on release → full popup rebuild
    occupied: Set<number>;
    grow: boolean;
  }): HTMLElement {
    const COLS = 8;
    const SPAN = Math.max(1, this.gridSpan[cfg.key]);
    const barsPerRow = COLS * SPAN;
    const barLimit = Math.max(1, this.track.barLimit);
    const needRows = Math.ceil(barLimit / barsPerRow); // rows the track itself fills
    const maxRows = cfg.grow ? Math.ceil(512 / barsPerRow) : needRows;
    const rows = Math.min(maxRows, Math.max(needRows, cfg.grow ? this.placeGridRows : 1));
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

    // Tool row: the squares' bar worth (1 / 2 / 4), the Start→End pick, the row stepper.
    const tools = document.createElement("div");
    tools.className = "place-grid-tools";
    const spanCtl = document.createElement("span");
    spanCtl.className = "place-grid-rowctl";
    const spanLbl = document.createElement("span");
    spanLbl.className = "place-grid-rowsn";
    spanLbl.textContent = "square =";
    spanCtl.append(spanLbl);
    for (const s of [1, 2, 4]) {
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
        b.onclick = () => { this.placeGridRows = rows + delta; cfg.commit(); };
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

  /** The Loop tab's placement grid: this loop's bars across the track. Editing sets the
      rule to "At bars" (seeded from the current placement, so switching from an
      algorithmic rule keeps its bars); painting past the track end GROWS the track.
      Squares covered by ANOTHER loop of this colour carry the clash stripe. */
  private placementGrid(loop: Loop, rerender: () => void): HTMLElement {
    const barLimit = Math.max(1, this.track.barLimit);
    const c = this.colorOf(loop);

    // This loop's placement as an explicit bar set (start bars). Seed from placementsFor so
    // an algorithmic rule shows its bars and converts cleanly to a manual list on edit.
    const ownList = () => loop.rule.every.kind === "at"
      ? (loop.rule.every as { bars: number[] }).bars.slice()
      : placementsFor(loop, barLimit).map((iv) => iv.startBar + 1);

    // Bars where ANOTHER loop of this colour sounds (covered bars) — a clash hint.
    const occupied = new Set<number>();
    for (const other of this.track.colors[c]?.loops ?? []) {
      if (other === loop || other.soundId < 0) continue;
      for (const iv of placementsFor(other, barLimit)) {
        for (let b = iv.startBar; b < iv.startBar + iv.forBars && b < barLimit; b++) occupied.add(b + 1);
      }
    }

    return this.barGrid({
      key: "place",
      color: loop.soundId >= 0 ? loop.color : "#808080",
      read: ownList,
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
      this loop there (its own sound id, so the two never share an engine sound). */
  private openCopyLoopMenu(loop: Loop): void {
    document.querySelector(".copy-menu-overlay")?.remove();
    const from = this.colorOf(loop);
    const overlay = document.createElement("div");
    overlay.className = "copy-menu-overlay";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    const card = document.createElement("div");
    card.className = "copy-menu-card";
    const title = document.createElement("h3");
    title.className = "tr-title";
    title.textContent = "Copy loop to…";
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
      row.onclick = () => { overlay.remove(); this.copyLoopTo(loop, c); };
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
      resend sounds/lanes. Leaves the current popup as-is (least disruptive) and toasts. */
  private copyLoopTo(loop: Loop, target: number): void {
    const clone = cloneLoop(loop);
    clone.color = VOICE_COLORS[target % VOICE_COLORS.length];
    if (clone.soundId >= 0) clone.soundId = this.nextSoundId++; // its own engine sound entry
    this.track.colors[target].loops.push(clone);
    this.pushSounds();  // register the clone's sound before it's asked to play
    this.recompile();
    this.render();      // the loop list / previews may be visible under the popup
    this.toast(`Copied to Voice ${target + 1}`);
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
      resetTitle: "Reset to the untransformed sound (no change)",
      reset: () => draft.restore(loop.snapshot),
    };
  }

  /** The sound-graph panel: a big graph (every ACTIVE setting drawn as its own coloured
      time function; the x axis stretches to the longest one), the Shuffle / Back /
      Reset column with the Gate / Max-len / Spread controls under it in the top-right
      corner, and — below — either the coloured trace buttons (paged: active first, ‹ ›
      through the inactive ones) or, when a trace is tapped, its EQUATION with the
      values inline. Hosted by a loop's own sound OR a transition's transformed sound. */
  private soundGraphPanel(host: SoundGraphHost, rerender: () => void): HTMLElement {
    const p = host.draft;
    const get: ParamGet = (id) => p.get(id);

    const wrap = document.createElement("div");
    wrap.className = "sound-graph";
    wrap.style.setProperty("--vc", host.color);

    const sel = this.graphTrace ? SOUND_TRACES.find((t) => t.id === this.graphTrace) ?? null : null;

    // One toolbar line above the graph (no title blurb): the Back / Reset buttons,
    // then Gate / Max len / Spread, then the ?. The Shuffle lives on the graph's own
    // top-right corner (built below). Any host extras (e.g. ⧉) lead.
    const bar = document.createElement("div");
    bar.className = "graph-toolbar";
    const mkTool = (glyph: string, title2: string, fn: () => void, extra = "", disabled = false) => {
      const b = document.createElement("button");
      b.className = "graph-corner-btn" + (extra ? " " + extra : "");
      b.textContent = glyph;
      b.title = title2;
      b.disabled = disabled;
      b.onclick = fn;
      return b;
    };
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
    const help = helpButton("The sound graph", App.SOUND_GRAPH_HELP);
    help.classList.add("graph-tool-help");
    bar.append(help);
    wrap.append(bar);

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
    if (!tr.on) bits.push("off");
    return bits.join(" · ");
  }

  /** How many params the transition's target differs from the loop's own sound in. */
  private changedParamCount(loop: Loop, tr: LoopTransition): number {
    let n = 0;
    const len = Math.max(loop.snapshot.length, tr.snapshot.length);
    for (let i = 0; i < len; i++) {
      const a = loop.snapshot[i] ?? 0;
      const b = tr.snapshot[i] ?? a;
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

  /** The Sound tab of a transition: the SAME sound graph the voice's Sound panel uses,
      hosted by the transition's TRANSFORMED sound — every value edited here is the
      transition's END. The corner gains a small ⧉ that lands the transformed sound as
      a new loop after the transition; ↺ resets to "no change" (the loop's own sound). */
  private transEffectsSection(loop: Loop, tr: LoopTransition, rerender: () => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "trans-effects";
    wrap.append(this.soundGraphPanel(this.graphHostForTransition(loop, tr, rerender), rerender));
    return wrap;
  }

  /** Copy a transition's TRANSFORMED sound into a new loop on the same row, placed from
      the bar after the transition through the end of the track — so the row plays the
      initial sound, transitions, then loops the new sound. The copy keeps the source
      loop's rhythm; it gets its own sound id, name and loudness make-up. */
  private copyTransformedSound(loop: Loop, tr: LoopTransition): void {
    const c = this.colorOf(loop);
    const clone = cloneLoop(loop);
    clone.soundId = this.nextSoundId++;
    clone.snapshot = tr.snapshot.slice();
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
    this.toast(bars.length
      ? `“${clone.label}” added after the transition (bars ${bars[0]}–${barLimit})`
      : `“${clone.label}” added — the transition reaches the track end, so place it on its Loop tab`);
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
    const target = tr.snapshot.length ? tr.snapshot : loop.snapshot;
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
      this.engine.playPreviewLoop(buffer, (lenSteps * 60) / Math.max(1, this.tempo) / 4);
    } catch { /* the preview is best-effort */ }
  }

  /** Silence the looping transition preview and cancel any pending render. */
  private stopPreview(): void {
    this.previewToken++;
    clearTimeout(this.previewTimer);
    this.engine.stopPreview();
  }

  /** The rule editor block: Repeat-every (three-way) and For-n-bars. */
  private placementControls(loop: Loop, rerender: () => void): HTMLElement {
    const r = loop.rule;
    const wrap = document.createElement("div");
    wrap.className = "placement-controls";

    // Repeat every: three-way toggle.
    const everyRow = document.createElement("div");
    everyRow.className = "placement-row";
    const everyLbl = document.createElement("span");
    everyLbl.className = "placement-lbl";
    everyLbl.textContent = "Repeat every";
    const seg = document.createElement("div");
    seg.className = "placement-seg";
    const mkSeg = (key: EveryRule["kind"], text: string) => {
      const b = document.createElement("button");
      b.className = "seg-btn" + (r.every.kind === key ? " on" : "");
      b.textContent = text;
      b.onclick = () => {
        if (r.every.kind === key) return;
        if (key === "nth") r.every = { kind: "nth", n: 4 };
        else if (key === "pow2") r.every = { kind: "pow2" };
        else if (key === "at") r.every = { kind: "at", bars: [1] };
        else if (key === "fill") r.every = { kind: "fill" };
        else if (key === "dice") r.every = { kind: "dice", weight: 3 };
        else r.every = { kind: "weight", weight: 0.5 };
        this.recompile();
        rerender();
      };
      return b;
    };
    seg.append(
      mkSeg("nth", "Nth bar"), mkSeg("pow2", "Powers of 2"), mkSeg("at", "At bars"),
      mkSeg("fill", "Fill blanks"), mkSeg("dice", "Dice"), mkSeg("weight", "Chance"),
    );
    everyRow.append(everyLbl, seg);
    wrap.append(everyRow);

    // Per-kind parameter.
    if (r.every.kind === "nth") {
      wrap.append(this.numRow("Every N bars", () => (r.every as { n: number }).n, (n) => {
        const e = r.every as { n: number; start?: number };
        r.every = { kind: "nth", n: Math.max(1, Math.round(n)), start: e.start };
        this.recompile();
      }, rerender, () => `${(r.every as { n: number }).n}`));
      // Start at bar: shift the whole series later. 1 (or off the track) = no shift.
      wrap.append(this.numRow("Start at bar", () => (r.every as { start?: number }).start ?? 1, (n) => {
        const e = r.every as { n: number };
        const s = Math.max(1, Math.min(this.track.barLimit, Math.round(n)));
        r.every = { kind: "nth", n: e.n, start: s > 1 ? s : undefined };
        this.recompile();
      }, rerender, () => {
        const s = (r.every as { start?: number }).start ?? 1;
        return s <= 1 ? "bar 1" : `bar ${s}`;
      }));
    } else if (r.every.kind === "at") {
      // Manual bar list: a read-only field (tap → list numpad for precise / large-track
      // entry) plus a play-range-style strip you tap or drag to pick MULTIPLE bars/ranges.
      const row = document.createElement("div");
      row.className = "placement-row placement-atbars";
      const lbl = document.createElement("span");
      lbl.className = "placement-lbl";
      lbl.textContent = "Bars";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.readOnly = true;
      inp.inputMode = "none";
      inp.placeholder = "tap or drag below — e.g. 1, 5, 9";
      const readBars = () => (r.every as { bars: number[] }).bars;
      inp.value = readBars().join(", ");
      inp.onclick = () => this.openNumpad({
        title: "At bars",
        value: readBars().join(", ") || "—",
        color: loop.soundId >= 0 ? loop.color : undefined,
        list: true,
        onSubmitList: (raw) => {
          const bars = (raw.match(/\d+/g) ?? []).map((s) => parseInt(s, 10)).filter((n) => n >= 1);
          r.every = { kind: "at", bars };
          this.recompile();
          rerender();
        },
      });
      row.append(lbl, inp);
      wrap.append(row);

      // The multi-select bar strip: tap toggles a bar, drag paints a span on/off.
      const pick = document.createElement("div");
      pick.className = "atbars-pick";
      pick.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#808080");
      const readout = document.createElement("span");
      readout.className = "atbars-pick-hint";
      const syncReadout = () => {
        const bs = readBars();
        readout.textContent = bs.length ? `bars ${bs.join(", ")}` : "tap or drag bars to pick";
      };
      syncReadout();
      pick.append(readout);
      pick.append(this.multiBarStrip(
        Math.max(1, this.track.barLimit),
        readBars,
        (bars) => { r.every = { kind: "at", bars }; this.recompile(); inp.value = bars.join(", "); syncReadout(); },
        rerender,
      ));
      wrap.append(pick);
    } else if (r.every.kind === "fill") {
      const hint = document.createElement("p");
      hint.className = "hint placement-hint";
      hint.textContent = "Sounds on every bar this colour's other loops leave empty — it fills the blanks around them, whatever their mode.";
      wrap.append(hint);
    } else if (r.every.kind === "dice") {
      const hint = document.createElement("p");
      hint.className = "hint placement-hint";
      hint.textContent = "All this colour's Dice loops share the bars — a bigger face wins more of the track. Every bar is filled, none overlap.";
      wrap.append(hint);
      // Dice-face picker (1..6): this loop's slice of the pool.
      const diceRow = document.createElement("div");
      diceRow.className = "placement-row placement-dice";
      const diceLbl = document.createElement("span");
      diceLbl.className = "placement-lbl";
      diceLbl.textContent = "Weight";
      const faces = document.createElement("div");
      faces.className = "dice-faces";
      const FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
      for (let d = 1; d <= 6; d++) {
        const b = document.createElement("button");
        b.className = "dice-face" + ((r.every as { weight: number }).weight === d ? " on" : "");
        b.textContent = FACES[d - 1];
        b.title = `${d}`;
        b.onclick = () => { r.every = { kind: "dice", weight: d }; this.recompile(); rerender(); };
        faces.append(b);
      }
      diceRow.append(diceLbl, faces);
      wrap.append(diceRow, this.rollRow(r, rerender));
    } else if (r.every.kind === "weight") {
      const chanceRow = this.numRow("Chance %", () => Math.round((r.every as { weight: number }).weight * 100), (n) => {
        r.every = { kind: "weight", weight: Math.max(0, Math.min(1, Math.round(n) / 100)) };
        this.recompile();
      }, rerender, () => `${Math.round((r.every as { weight: number }).weight * 100)}%`);
      wrap.append(chanceRow, this.rollRow(r, rerender));
    }

    // For: bar length(s). A single value, or a comma list that CYCLES across successive
    // placements (2, 4 → 2 bars, then 4, then 2 …). The native keypad has no comma, so this
    // opens our list numpad.
    const forRow = document.createElement("div");
    forRow.className = "placement-row placement-atbars";
    const forLbl = document.createElement("span");
    forLbl.className = "placement-lbl";
    forLbl.textContent = "For (bars)";
    const forInp = document.createElement("input");
    forInp.type = "text";
    forInp.readOnly = true;
    forInp.inputMode = "none";
    const shownLen = () => ruleLengths(r).join(", ");
    forInp.value = shownLen();
    forInp.onclick = () => this.openNumpad({
      title: "For — bar length(s)",
      value: shownLen(),
      color: loop.soundId >= 0 ? loop.color : undefined,
      list: true,
      onSubmitList: (raw) => {
        const nums = (raw.match(/\d+/g) ?? []).map((s) => Math.max(1, parseInt(s, 10))).filter((n) => n >= 1);
        if (nums.length <= 1) { r.forBars = nums[0] ?? r.forBars; r.lengths = undefined; }
        else { r.lengths = nums; r.forBars = nums[0]; }
        this.recompile();
        rerender();
      },
    });
    forRow.append(forLbl, forInp);
    wrap.append(forRow);
    if (ruleLengths(r).length > 1) {
      const hint = document.createElement("p");
      hint.className = "hint placement-hint";
      hint.textContent = `Placements cycle through ${ruleLengths(r).join(", ")} bars in turn.`;
      wrap.append(hint);
    }

    // No clash control: a colour's loops always resolve by list priority (the earlier loop
    // wins the bar), so a colour compiles to one lane — see track.ts resolveLane.
    return wrap;
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
  /** Per-loop Accent / Ghost placement (see LifePlacement in lines.ts): a deterministic
      alternative to the sound's own random accent/ghost. Each side picks Off / Every-N
      (mark every Nth hit) / Ramp (swell across the loop) plus its amount. */
  private lifeControls(loop: Loop, rerender: () => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "placement-controls transition-controls life-controls";
    const head = document.createElement("span");
    head.className = "placement-lbl transition-head";
    head.textContent = "Accents & Ghosts";
    wrap.append(head);
    wrap.append(this.lifeRow(loop, "accent", rerender));
    wrap.append(this.lifeRow(loop, "ghost", rerender));
    return wrap;
  }

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

  /** Re-roll / Back for a seeded rule (Chance or Dice): re-roll mints a new seed (pushing
      the old one onto the history stack), Back pops it. For a Dice loop the pool is seeded
      from every member's seed, so re-rolling any one reshuffles the whole colour. */
  private rollRow(r: { seed: number; seedHistory: number[] }, rerender: () => void): HTMLElement {
    const rollRow = document.createElement("div");
    rollRow.className = "placement-row placement-roll";
    const reroll = document.createElement("button");
    reroll.className = "roll-btn";
    reroll.textContent = "⟳ Re-roll";
    reroll.onclick = () => {
      r.seedHistory.push(r.seed);
      r.seed = newSeed();
      this.recompile();
      rerender();
    };
    const backBtn = document.createElement("button");
    backBtn.className = "roll-btn";
    backBtn.textContent = "↩ Back";
    backBtn.disabled = r.seedHistory.length === 0;
    backBtn.onclick = () => {
      const prev = r.seedHistory.pop();
      if (prev === undefined) return;
      r.seed = prev;
      this.recompile();
      rerender();
    };
    rollRow.append(reroll, backBtn);
    return rollRow;
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
    const mkNum = (label: string, value: number, field: RhythmField, disabled = false) => {
      const cell = document.createElement("div");
      cell.className = "euclid-num";
      const lab = document.createElement("span");
      lab.textContent = label;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = String(value);
      inp.readOnly = true;
      inp.inputMode = "none";
      inp.disabled = disabled;
      if (!disabled) {
        this.attachScrub(inp, {
          label,
          color: loop.soundId >= 0 ? loop.color : undefined,
          read: () => this.rhythmValue(loop, field),
          write: (n) => this.applyRhythm(loop, field, n),
          show: () => String(this.rhythmValue(loop, field)),
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
      mkNum("Hits", loop.hits, "hits"),
      mkNum("Steps", loop.steps, "steps"),
      mkNum("Start", loop.rotation, "rotation"),
      mkNum("Split", loop.split ?? evenGap(loop.hits, loop.steps), "split", splitLocked),
    );
    return vals;
  }

  private rhythmValue(loop: Loop, field: RhythmField): number {
    if (field === "hits") return loop.hits;
    if (field === "steps") return loop.steps;
    if (field === "rotation") return loop.rotation;
    return loop.split ?? evenGap(loop.hits, loop.steps);
  }

  private applyRhythm(loop: Loop, field: RhythmField, n: number): void {
    if (Number.isNaN(n)) n = 0;
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

  /** Mint an audible sound for a fresh loop by shuffling its draft and writing it. */
  private mintLoopSound(loop: Loop): void {
    this.draftFor(loop).shuffle(this.shuffleContext(), randomSeed());
    this.writeLoopFromEditor(loop);
    void this.normalizeLoop(loop);
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
        value: startVal,
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
    back.textContent = this.mixerReturn === "color" ? "‹ Loops" : "‹ Track";
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
