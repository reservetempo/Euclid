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
import { DRUMS, DrumType } from "../model/drums";
import { ParamId, NUM_PARAMS } from "../model/params";
import { baseSpec } from "../model/paramSpec";
import { DrumKit, estimateLength } from "../model/drumKit";
import { FULL_RANGE_PRESET } from "../model/presets";
import { serialize, deserialize, ProjectJSON } from "../model/project";
import { addReport, reportCount, exportReports, clearReports, ReportKind } from "../model/soundReports";
import {
  LineArrangement, STEPS_PER_BAR, NUM_LINES, VOICE_COLORS,
  TransitionMode, FADE_MODES, TRANSITION_SWEEP, TransitionShape,
} from "../model/lines";
import {
  Track, Loop, EveryRule, RowSweep, emptyLoop, cloneLoop, loopToNode, randomSeed as newSeed,
  ruleLengths, defaultRowSweep, MelodyItem, newMelodyItem,
} from "../model/track";
import { generateTrackName, reshuffleNames } from "../model/name";
import { clampSteps, MAX_STEPS, evenGap, maxSplitGap } from "../model/euclid";
import {
  MelodyNote, MelodyNode, MELODY_COLOR_INDEX, defaultNote, newBranch, countNotes, randomizeNotes,
  generateMelody, chainNotes, isChain,
} from "../model/melody";
import {
  ALL_SCALES, ALL_ROOTS, degreesPerOctave, noteNameForDegree, semitoneForDegree,
} from "../model/melodyScale";
import { detectPitchHz, SingTracker, SungNote, sungToMelodyNotes, midiName } from "../model/sing";
import { EuclidView, RingState } from "./euclidView";
import { SoundView } from "./soundView";
import { defaultShuffleSettings, shuffleOptions, randomSeed } from "./controls";
import { buildVoiceShuffleMenu, VoiceEditor } from "./voiceShuffleMenu";
import { logoLetters } from "./logo";

// Storage key kept from the app's working title so existing saves keep loading.
const PROJECT_KEY = "msq010.project";

// Every loop's inline shuffle editor drives a single-drum DrumKit; the reference drum
// only picks parameter specs — Full Range opens all ranges so any character is reachable.
const REF_DRUM = DrumType.Kick;

// Overview timeline wraps to a new row ("line") every this many bars, so a long track
// stays legible; the playhead loops back at each wrap and a badge names the active line.
const BARS_PER_ROW = 32;

type View = "track" | "color" | "sound" | "mixer" | "melody";

/** A live Sing recording: the mic stream + analyser tap, the pitch tracker, and the DOM
    bits the rAF loop writes into (rebound whenever the Sing tab re-renders). */
interface SingSession {
  stream: MediaStream;
  dispose: () => void; // disconnects the analyser tap
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  tracker: SingTracker;
  raf: number;
  els: { note: HTMLElement; cents: HTMLElement; hz: HTMLElement; strip: HTMLElement } | null;
  lastN: number; // completed sung notes already rendered into the strip
}

// The editable numeric fields of a loop's rhythm (its scrubbable number circles).
type RhythmField = "hits" | "steps" | "rotation" | "split";

// Bend a transition's blend progress t∈[0,1] for the curve visualization — must match
// bendT in engine.js: `curve` 0 (linear) → 1 (exponential); `dir` "out" eases slowly then
// rushes to the end, "in" rushes early then eases in. Endpoints (0→0, 1→1) are preserved.
function bend(t: number, curve: number, dir: "in" | "out"): number {
  const c = Math.max(0, Math.min(1, curve || 0));
  t = Math.max(0, Math.min(1, t));
  if (c <= 0) return t;
  const exp = Math.pow(4, c);
  return dir === "in" ? 1 - Math.pow(1 - t, exp) : Math.pow(t, exp);
}

export class App {
  private engine = new EngineHost();
  private arr = new LineArrangement();       // COMPILED lanes (engine source of truth)
  private track = new Track();               // the authoring model
  private kit = new DrumKit(DRUMS.map((d) => d.type)); // background editor kit (serialised)
  private drumTypes = DRUMS.map((d) => d.type);
  private saveTimer = 0;

  private view: View = "track";
  private lastViewKey = "";             // view identity at the previous render (scroll-preserve guard)
  private openColor = 0;               // which colour panel is open
  private melodyPath: MelodyNote[] = []; // notes descended into (branch drill-down); [] = root
  private melodyItemIndex = -1;          // which melody in the list is open (-1 = the list/menu)
  private melodyBranchMode = false;      // Add-branch mode: tapping a note square branches it
  private melodyGenCount = 4;            // desired note count for the Generate button
  private melodyNoteEdit: MelodyNote | null = null; // note whose settings popup is open
  private melodyOptionsPage = false;     // melody sub-page: the current item's loop options
  // Melody item sub-tabs: notes editor / sing-to-notes / instrument sound / transition.
  private melodyTab: "notes" | "sing" | "sound" | "transition" = "notes";
  private singSession: SingSession | null = null; // live mic recording (null = idle)
  private singTake: SungNote[] | null = null;     // last finished take, awaiting Apply
  private singError: string | null = null;        // mic/take status line for the Sing tab
  // Headphone-solo: hear ONLY this melody (all other voices + melodies muted) while
  // shaping its instrument. Transient — never saved; cleared on navigating away.
  private melodySoloItem: MelodyItem | null = null;
  private editLoop: Loop | null = null; // loop whose placement popup is open
  private placementTab: "loop" | "transition" | "sound" = "loop"; // which sub-page of the loop popup
  private soundLoop: Loop | null = null; // loop the deep sound view is editing
  private selectedDrum: DrumType = DrumType.Kick;
  private soundName = "";
  private playing = false;
  private tempo = 120;
  // Play-range loop region (1-indexed bars, inclusive); 0/0 = loop the whole track. A
  // transient playback aid (see applySection) — not saved with the project.
  private playFromBar = 0;
  private playToBar = 0;
  private nextSoundId = 0;             // monotonic id for loop sounds

  private soundReturn: View = "color"; // where the deep sound view's Back returns to
  private mixerReturn: View = "track"; // where the mixer's Back returns to

  // Per-loop inline shuffle editors, keyed by loop identity. Rebuilt from a loop's saved
  // snapshot/ranges/preset; dropped when the loop is removed.
  private voiceEditors = new Map<Loop, VoiceEditor>();

  private root: HTMLElement;
  private viewRoot!: HTMLElement;
  private euclidView = new EuclidView();
  private loopTimeEl: HTMLElement | null = null;
  private trackPlayheadEl: HTMLElement | null = null; // overview playback line
  private trackOverviewEl: HTMLElement | null = null; // overview container (dims inactive lines while playing)
  private trackSegEl: HTMLElement | null = null;      // "Line n / N" badge
  private segRows: HTMLElement[] = [];                 // overview lane sub-rows, tagged by their wrap segment
  private overviewSegCount = 1;                        // how many 32-bar lines the track wraps into
  private overviewRowBars = BARS_PER_ROW;              // bars per overview line (= barLimit when it fits in one)
  // Channel -> flash LED (mixer) and sound id -> loop-row button (colour panel).
  private mixerLeds: Map<number, HTMLElement> | null = null;
  private voiceBtns: Map<number, HTMLElement> | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.engine.onPlayhead = (p) => this.handlePlayhead(p);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.engine.resume();
    });
    this.renderStart();
  }

  // --- audibility (per colour) ------------------------------------------
  private anySolo(): boolean {
    return this.track.colors.some((c) => c.solo);
  }
  /** A colour is heard unless it's muted or another colour has stolen solo. */
  private colorAudible(c: number): boolean {
    // Headphone-soloing a melody: only the melody row is heard (buildSounds narrows it
    // further, to the one soloed instrument).
    if (this.melodySoloItem) return c === MELODY_COLOR_INDEX;
    const ct = this.track.colors[c];
    if (!ct) return false;
    return !ct.mute && (!this.anySolo() || !!ct.solo);
  }

  // --- playhead ----------------------------------------------------------
  private handlePlayhead(p: Playhead): void {
    if (!p.lines) {
      this.refreshRings();
      this.trackPlayheadEl?.classList.remove("live");
      this.trackOverviewEl?.classList.remove("playing");
      for (const row of this.segRows) row.classList.remove("seg-live");
      return;
    }
    // Overview: sweep the playback line to the current position — it loops back at each
    // 32-bar wrap — highlight the active wrapped line, and name it in the badge.
    if (this.trackPlayheadEl) {
      const loopLen = this.arr.loopSteps();
      if (loopLen > 0) {
        const bar = (p.pos % loopLen) / STEPS_PER_BAR;
        const rowBars = this.overviewRowBars;
        const seg = Math.floor(bar / rowBars);
        this.trackPlayheadEl.style.setProperty("--ph", String((bar % rowBars) / rowBars));
        this.trackPlayheadEl.classList.add("live");
        this.trackOverviewEl?.classList.add("playing");
        for (const row of this.segRows) row.classList.toggle("seg-live", Number(row.dataset.seg) === seg);
        if (this.trackSegEl) this.trackSegEl.textContent = `Line ${seg + 1} / ${this.overviewSegCount}`;
      }
    }
    // Rings show ONLY what's audibly playing, aggregated to the six colours: for each
    // colour, whichever of its lanes is sounding this step lights its ring.
    const states: RingState[] = Array.from({ length: NUM_LINES }, () => ({ node: null, step: -1 }) as RingState);
    this.arr.lines.forEach((lane, li) => {
      const st = p.lines![li];
      const c = lane.color ?? -1;
      if (c < 0 || c >= NUM_LINES) return;
      if (st && st.node >= 0 && st.step >= 0 && this.colorAudible(c)) {
        states[c] = { node: lane.nodes[st.node] ?? null, step: st.step };
      }
    });
    this.euclidView.setRings(states);
    this.euclidView.pulse(p.fired);
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

  /** Point the rings at a preview of each colour (its open loop, else its first sound). */
  private refreshRings(): void {
    const states: RingState[] = Array.from({ length: NUM_LINES }, () => ({ node: null, step: -1 }) as RingState);
    for (let c = 0; c < NUM_LINES; c++) {
      const loops = this.track.colors[c].loops;
      let show: Loop | undefined;
      if (this.editLoop && loops.includes(this.editLoop)) show = this.editLoop;
      else show = loops.find((l) => l.soundId >= 0);
      if (show) states[c] = { node: loopToNode(show), step: -1 };
    }
    this.euclidView.setRings(states);
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
        sounds.push({ id: l.soundId, snap, lo: l.pitch[0], hi: l.pitch[1], tail: estimateLength(snap, this.tempo) });
      }
    });
    // Each melody's own re-pitched instrument (its notes override P.Pitch in the engine).
    // A headphone-soloed melody mutes its siblings too — only its instrument sounds.
    const soloInst = this.melodySoloItem?.inst ?? null;
    const melodyAudible = this.colorAudible(MELODY_COLOR_INDEX);
    for (const m of this.track.melodies) {
      const inst = m.inst;
      if (inst.soundId < 0 || !inst.snapshot.length || seen.has(inst.soundId)) continue;
      seen.add(inst.soundId);
      const snap = inst.snapshot.slice();
      if (soloInst ? inst !== soloInst : !melodyAudible) snap[ParamId.Volume] = 0;
      else if (inst.gain && inst.gain !== 1) snap[ParamId.Volume] = (snap[ParamId.Volume] ?? 0.85) * inst.gain;
      sounds.push({ id: inst.soundId, snap, lo: inst.pitch[0], hi: inst.pitch[1], tail: estimateLength(snap, this.tempo) });
    }
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
        const json = serialize(this.track, this.kit, this.tempo, this.drumTypes, this.soundName);
        localStorage.setItem(PROJECT_KEY, JSON.stringify(json));
      } catch { /* ignore quota errors */ }
    }, 300);
  }

  private loadFromStorage(): boolean {
    try {
      const raw = localStorage.getItem(PROJECT_KEY);
      if (!raw) return false;
      const json = JSON.parse(raw) as ProjectJSON;
      this.tempo = deserialize(json, this.track, this.kit, this.drumTypes);
      this.soundName = json.soundName ?? this.soundName;
      this.resetIds();
      return true;
    } catch {
      return false;
    }
  }

  private saveToFile(): void {
    const json = serialize(this.track, this.kit, this.tempo, this.drumTypes, this.soundName);
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
    // The melody headphone-solo is an editing aid — exports honour the mixer state only.
    const hs = this.melodySoloItem;
    this.melodySoloItem = null;
    const sounds = this.buildSounds();
    this.melodySoloItem = hs;
    const maxTail = sounds.reduce((m, s) => Math.max(m, s.tail || 0), 0);
    const tailSec = Math.min(8, Math.max(1.5, maxTail + 0.5));
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
        this.tempo = deserialize(json, this.track, this.kit, this.drumTypes);
        this.soundName = json.soundName ?? "";
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
    this.kit = new DrumKit(this.drumTypes);
    this.applyRandomDefault();
    this.tempo = 120;
    this.voiceEditors.clear();
    this.nextSoundId = 0;
    this.editLoop = null;
    this.soundLoop = null;
    this.openColor = 0;
    this.playFromBar = 0;
    this.playToBar = 0;
    this.view = "track";
    // A fresh project re-shuffles the name pools (a whole new draw order) and coins a name.
    reshuffleNames();
    this.track.name = generateTrackName();
    this.afterProjectChange();
  }

  /** After load/new: bump the id counter past every loaded loop id so new sounds never
      collide, and clear cached editors. */
  private resetIds(): void {
    this.voiceEditors.clear();
    let maxId = -1;
    for (const c of this.track.colors) {
      for (const l of c.loops) if (l.soundId > maxId) maxId = l.soundId;
    }
    for (const m of this.track.melodies) if (m.inst.soundId > maxId) maxId = m.inst.soundId;
    this.nextSoundId = maxId + 1;
    this.editLoop = null;
    this.soundLoop = null;
  }

  private afterProjectChange(): void {
    if (this.playing) { this.playing = false; this.engine.stop(); }
    this.pushAll();
    this.render();
  }

  /** Seed the (background) editor kit with a fresh random Full Range sound, so a
      new/loaded project still serialises a valid drum kit + preset. */
  private applyRandomDefault(): void {
    this.kit.applyPreset(this.selectedDrum, FULL_RANGE_PRESET);
    this.kit.shuffleAll(this.selectedDrum, { randomness: 1.0 });
    this.soundName = "";
  }

  // --- start gate -------------------------------------------------------
  private renderStart(): void {
    this.root.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "start-screen";
    const h = document.createElement("h1");
    h.className = "logo";
    h.append(...logoLetters(46, true));
    const btn = document.createElement("button");
    btn.id = "start";
    btn.textContent = "▶ Start";
    btn.onclick = async () => {
      await this.engine.start();
      if (!this.loadFromStorage()) this.applyRandomDefault();
      this.pushAll();
      this.render();
    };
    wrap.append(h, btn);
    this.root.append(wrap);
  }

  // --- main render ------------------------------------------------------
  private render(): void {
    // A melody's headphone-solo lives only while EDITING that melody (its pages, or its
    // instrument's deep sound view); navigating anywhere else restores the full mix.
    const hs = this.melodySoloItem;
    if (hs) {
      const onItem = this.view === "melody" && this.currentMelodyItem() === hs;
      const onSound = this.view === "sound" && this.soundLoop === hs.inst;
      if (!this.track.melodies.includes(hs) || (!onItem && !onSound)) {
        this.melodySoloItem = null;
        this.pushSounds();
      }
    }
    // Preserve the scroll position across an in-view re-render: render() rebuilds the
    // whole view (a fresh .viewroot scroller), which would otherwise snap back to the
    // top on every edit. Only restore when the view is unchanged — a genuine navigation
    // should start at the top.
    const savedScroll = this.viewRoot?.scrollTop ?? 0;
    // The melody instrument sub-page and Sing tab are distinct scroll contexts from the
    // notes page.
    let viewKey = this.view;
    // Each melody sub-tab is its own scroll context (distinct from the notes page).
    if (this.view === "melody" && this.currentMelodyItem() && !this.melodyOptionsPage) viewKey += ":" + this.melodyTab;
    const sameView = this.lastViewKey === viewKey;
    this.lastViewKey = viewKey;
    this.root.innerHTML = "";
    this.loopTimeEl = null;
    this.trackPlayheadEl = null;
    this.trackOverviewEl = null;
    this.trackSegEl = null;
    this.segRows = [];
    this.mixerLeds = null;
    this.voiceBtns = null;

    const bar = document.createElement("header");
    bar.className = "topbar";
    bar.append(this.topLeftControl(), this.transport(), this.menu());
    this.root.append(bar);

    this.viewRoot = document.createElement("main");
    // .view-enter plays the entrance stagger — only on a genuine navigation, so
    // in-place re-renders (scrubs, toggles) don't replay it.
    this.viewRoot.className = "viewroot" + (sameView ? "" : " view-enter");
    this.root.append(this.viewRoot);

    if (this.view === "track") this.renderTrackPanel();
    else if (this.view === "color") this.renderColorPanel();
    else if (this.view === "mixer") this.renderMixer();
    else if (this.view === "melody") this.renderMelodyPanel();
    else this.renderSound();

    this.updateLoopTime();
    if (!this.playing) this.refreshRings();

    // An open placement popup floats above everything (appended to root, so it survives
    // the panel re-render below it).
    if (this.view === "color" && this.editLoop) this.openPlacement(this.editLoop);
    // Likewise the melody note-settings popup (re-opens over the rebuilt grid).
    if (this.view === "melody" && this.melodyNoteEdit && this.currentMelodyItem()) {
      this.buildMelodyNotePopup(this.currentMelodyNode(), this.melodyNoteEdit);
    }

    // A live Sing recording only survives while its tab is on screen (the rAF loop's DOM
    // targets are rebound each render); navigating anywhere else stops the mic.
    if (this.singSession && !(this.singSession.els && document.contains(this.singSession.els.note))) {
      this.stopSing();
    }

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
        this.refreshRings();
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
      const b = document.createElement("button");
      b.className = "loop-view-btn loop-time-btn on";
      b.title = "Loop length";
      b.setAttribute("aria-label", "Loop length");
      this.loopTimeEl = document.createElement("span");
      this.loopTimeEl.className = "loop-time-btn-val";
      b.append(this.loopTimeEl);
      return b;
    }
    const b = document.createElement("button");
    b.className = "loop-view-btn";
    b.title = "Track";
    b.setAttribute("aria-label", "Track");
    b.append(this.chainIcon());
    b.onclick = () => { this.view = "track"; this.editLoop = null; this.render(); };
    return b;
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

  // --- track view (colours + bar limit) --------------------------------
  /** The track's coined name (see model/name.ts) with a die to re-generate it. */
  private trackNameBlock(): HTMLElement {
    if (!this.track.name) { this.track.name = generateTrackName(); this.persist(); }
    const wrap = document.createElement("div");
    wrap.className = "track-name";
    const name = document.createElement("span");
    name.className = "track-name-text";
    name.textContent = this.track.name;
    const dice = document.createElement("button");
    dice.className = "track-name-dice";
    dice.textContent = "🎲";
    dice.title = "Coin a new name";
    dice.onclick = () => { this.track.name = generateTrackName(); this.persist(); this.render(); };
    wrap.append(name, dice);
    return wrap;
  }

  /** Play-range: DRAG across a bar strip to loop just bars n→m. A whole-track mini-timeline
      (one row, whatever the bar limit) with a highlight band, a readout, and a clear. Applied
      live to the engine while dragging. A rehearsal aid, kept in app state only (not saved). */
  private playRangeStrip(): HTMLElement {
    const barLimit = Math.max(1, this.track.barLimit);
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
    const readoutText = () => isOn()
      ? `bars ${this.playFromBar}–${this.playToBar}`
      : "whole track — drag to loop a section";
    readout.textContent = readoutText();
    const clear = document.createElement("button");
    clear.className = "play-range-clear";
    clear.textContent = "✕";
    clear.title = "Clear the play range";
    clear.disabled = !isOn();
    clear.onclick = () => { this.playFromBar = 0; this.playToBar = 0; this.applySection(); this.render(); };
    head.append(lbl, readout, clear);
    wrap.append(head);

    // The draggable bar strip: one faint cell per bar, ticked every 4, with a band overlay.
    const strip = document.createElement("div");
    strip.className = "play-range-strip";
    for (let b = 0; b < barLimit; b++) {
      const cell = document.createElement("span");
      cell.className = "play-range-cell" + (b % 4 === 0 ? " tick" : "");
      strip.append(cell);
    }
    const band = document.createElement("div");
    band.className = "play-range-band";
    strip.append(band);
    const layout = () => {
      band.style.display = isOn() ? "block" : "none";
      if (isOn()) {
        band.style.left = `${((this.playFromBar - 1) / barLimit) * 100}%`;
        band.style.width = `${((this.playToBar - this.playFromBar + 1) / barLimit) * 100}%`;
      }
      readout.textContent = readoutText();
      clear.disabled = !isOn();
      wrap.classList.toggle("on", isOn());
    };
    layout();

    const barAt = (clientX: number) => {
      const rect = strip.getBoundingClientRect();
      const frac = Math.max(0, Math.min(0.9999, (clientX - rect.left) / Math.max(1, rect.width)));
      return Math.max(1, Math.min(barLimit, Math.floor(frac * barLimit) + 1));
    };
    let anchor = 0;
    const onMove = (e: PointerEvent) => {
      const bar = barAt(e.clientX);
      this.playFromBar = Math.min(anchor, bar);
      this.playToBar = Math.max(anchor, bar);
      layout();
      this.applySection(); // follow the drag live while playing
    };
    const onUp = (e: PointerEvent) => {
      strip.removeEventListener("pointermove", onMove);
      strip.removeEventListener("pointerup", onUp);
      strip.removeEventListener("pointercancel", onUp);
      try { strip.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    };
    strip.onpointerdown = (e) => {
      e.preventDefault();
      anchor = barAt(e.clientX);
      this.playFromBar = anchor;
      this.playToBar = anchor;
      layout();
      this.applySection();
      try { strip.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      strip.addEventListener("pointermove", onMove);
      strip.addEventListener("pointerup", onUp);
      strip.addEventListener("pointercancel", onUp);
    };
    wrap.append(strip);
    return wrap;
  }

  private renderTrackPanel(): void {
    const v = this.viewRoot;
    // Generated track name + a die to re-coin it.
    v.append(this.trackNameBlock());

    const rings = document.createElement("div");
    rings.className = "loop-rings";
    rings.append(this.euclidView.canvas, this.mixerOpenBtn("track"));
    v.append(rings);
    this.euclidView.layout();
    requestAnimationFrame(() => this.euclidView.layout());

    // Bar limit for the whole track.
    const barRow = document.createElement("div");
    barRow.className = "track-barlimit";
    const lbl = document.createElement("span");
    lbl.textContent = "Track length";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.readOnly = true;
    inp.inputMode = "none";
    inp.value = `${this.track.barLimit} bars`;
    this.attachScrub(inp, {
      label: "Track length (bars)",
      read: () => this.track.barLimit,
      write: (n) => { this.track.barLimit = Math.max(1, Math.min(512, Math.round(n))); this.recompile(); },
      show: () => `${this.track.barLimit} bars`,
    });
    barRow.append(lbl, inp);
    v.append(barRow);

    // Play-range: drag across the bar strip to loop just bars n→m (a rehearsal region).
    v.append(this.playRangeStrip());

    // Whole-track overview: every colour's compiled lanes laid out across the full bar
    // limit (zoomed out — the entire loop at once). Tap a colour to open its loop list.
    this.voiceBtns = new Map();
    const barLimit = Math.max(1, this.track.barLimit);
    this.overviewSegCount = Math.max(1, Math.ceil(barLimit / BARS_PER_ROW));
    this.overviewRowBars = this.overviewSegCount > 1 ? BARS_PER_ROW : barLimit;

    const overview = document.createElement("div");
    overview.className = "track-overview";
    this.trackOverviewEl = overview;
    // A vertical line that sweeps to the current playback position and loops back at each
    // 32-bar wrap (see handlePlayhead).
    this.trackPlayheadEl = document.createElement("div");
    this.trackPlayheadEl.className = "track-playhead";
    overview.append(this.trackPlayheadEl);
    // "Line n / N" badge — which wrapped line is playing (only when the track wraps).
    if (this.overviewSegCount > 1) {
      this.trackSegEl = document.createElement("div");
      this.trackSegEl.className = "track-line-indicator";
      this.trackSegEl.textContent = `Line 1 / ${this.overviewSegCount}`;
      overview.append(this.trackSegEl);
    }
    overview.append(this.barRuler(this.overviewRowBars));
    for (let c = 0; c < NUM_LINES; c++) {
      if (c === MELODY_COLOR_INDEX) { overview.append(this.melodyOverviewRow()); continue; }
      const ct = this.track.colors[c];
      const row = document.createElement("button");
      row.className = "track-color-row";
      row.style.setProperty("--vc", VOICE_COLORS[c]);

      const head = document.createElement("div");
      head.className = "track-color-head";
      const dot = document.createElement("span");
      dot.className = "track-color-dot";
      const name = document.createElement("span");
      name.className = "track-color-name";
      name.textContent = `Voice ${c + 1}`;
      const count = document.createElement("span");
      count.className = "track-color-count";
      const n = ct.loops.length;
      count.textContent = n === 0 ? "no loops" : n === 1 ? "1 loop" : `${n} loops`;
      head.append(dot, name, count);
      row.append(head);

      // Lane timeline(s) for this colour, wrapped into 32-bar lines; the active line is
      // highlighted while playing (segRows collects each sub-row for the playhead).
      const strip = document.createElement("div");
      strip.className = "track-color-lanes";
      this.appendLanes(strip, this.colorLaneNumbers(c), c, this.segRows);
      row.append(strip);
      for (const l of ct.loops) if (l.soundId >= 0) this.voiceBtns.set(l.soundId, row);

      row.onclick = () => { this.openColor = c; this.view = "color"; this.editLoop = null; this.render(); };
      overview.append(row);
    }
    v.append(overview);
  }

  // --- melody view (the last coloured row) ------------------------------
  /** Open the melody section on its LIST/menu (add a melody, or tap one to edit). */
  private openMelody(): void {
    this.melodyItemIndex = -1;
    this.melodyPath = [];
    this.melodyOptionsPage = false;
    this.resetSingTab();
    this.view = "melody";
    this.render();
  }

  /** Back to the Sing tab's idle state (mic off, take discarded). */
  private resetSingTab(): void {
    this.stopSing();
    this.melodyTab = "notes";
    this.singTake = null;
    this.singError = null;
  }

  /** The melody item currently being edited, or null when on the list/menu. */
  private currentMelodyItem(): MelodyItem | null {
    return this.melodyItemIndex >= 0 && this.melodyItemIndex < this.track.melodies.length
      ? this.track.melodies[this.melodyItemIndex]
      : null;
  }

  /** Enter one melody item's editor (minting its instrument sound on first entry). */
  private openMelodyItem(i: number): void {
    this.melodyItemIndex = i;
    this.melodyPath = [];
    this.melodyOptionsPage = false;
    this.resetSingTab();
    const item = this.currentMelodyItem();
    if (item && item.inst.soundId < 0) this.mintLoopSound(item.inst);
    this.render();
  }

  /** Add a fresh melody to the list and open it. */
  private addMelody(): void {
    this.track.melodies.push(newMelodyItem());
    this.openMelodyItem(this.track.melodies.length - 1);
  }

  /** The melody context currently being edited: the item's root node, or a branch reached
      by drilling through `melodyPath`. Assumes an item is open (guarded by the caller). */
  private currentMelodyNode(): MelodyNode {
    let node = this.currentMelodyItem()!.node;
    for (const note of this.melodyPath) node = note.branch ?? node;
    return node;
  }

  /** Re-generate + resend after any melody edit (recompile persists + updates the lane). */
  private melodyChanged(): void {
    this.recompile();
    this.render();
  }

  /** The 🎧 headphone-solo toggle for a melody item's pages: hear ONLY this melody (every
      other voice and melody muted) while trying out its instrument. */
  private melodySoloBtn(item: MelodyItem): HTMLElement {
    const on = this.melodySoloItem === item;
    const b = document.createElement("button");
    b.className = "melody-tree-btn melody-solo-btn" + (on ? " on" : "");
    b.textContent = "🎧 Solo";
    b.title = on
      ? "Back to the full mix"
      : "Hear only this melody — mutes every other voice and melody while you try sounds";
    b.onclick = () => {
      this.melodySoloItem = on ? null : item;
      this.pushSounds();
      this.render();
    };
    return b;
  }

  /** The banner shown while a melody is headphone-soloed. */
  private melodySoloNote(): HTMLElement {
    const p = document.createElement("p");
    p.className = "melody-solo-note";
    p.textContent = "🎧 Solo — hearing only this melody; everything else is muted until you leave or toggle it off.";
    return p;
  }

  /** The last overview row: the melody list summary + generated lane, tapping to its menu. */
  private melodyOverviewRow(): HTMLElement {
    const items = this.track.melodies;
    const c = MELODY_COLOR_INDEX;
    const row = document.createElement("button");
    row.className = "track-color-row melody-row";
    row.style.setProperty("--vc", VOICE_COLORS[c]);
    const head = document.createElement("div");
    head.className = "track-color-head";
    const dot = document.createElement("span");
    dot.className = "track-color-dot";
    const name = document.createElement("span");
    name.className = "track-color-name";
    name.textContent = "Melody";
    const count = document.createElement("span");
    count.className = "track-color-count";
    count.textContent = items.length === 0 ? "no melodies" : `${items.length} melod${items.length === 1 ? "y" : "ies"}`;
    head.append(dot, name, count);
    row.append(head);
    if (this.melodyLaneCells().some((x) => x > 0)) row.append(this.melodyStrip(this.segRows));
    row.onclick = () => this.openMelody();
    return row;
  }

  private renderMelodyPanel(): void {
    const item = this.currentMelodyItem();
    if (!item) { this.renderMelodyList(); return; }
    if (this.melodyOptionsPage) { this.renderMelodyOptionsPage(item); return; }
    this.renderMelodyItemParams(item);
  }

  /** The melody LIST / menu: a whole-row preview + the list of melodies (tap to edit,
      reorder, remove) + Add melody. */
  private renderMelodyList(): void {
    const v = this.viewRoot;
    const c = MELODY_COLOR_INDEX;
    const head = document.createElement("div");
    head.className = "mixer-head";
    head.style.setProperty("--vc", VOICE_COLORS[c]);
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = "‹ Track";
    back.onclick = () => { this.view = "track"; this.render(); };
    const title = document.createElement("h2");
    title.className = "mixer-title";
    title.textContent = "Melody";
    head.append(back, title);
    v.append(head);

    const seq = this.melodyLanesPreview();
    if (seq) v.append(seq);

    const list = document.createElement("div");
    list.className = "mixer-list melody-list";
    if (this.track.melodies.length === 0) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "No melodies yet. Add one, generate notes from a scale, then place it across the track like a loop.";
      list.append(hint);
    } else {
      this.track.melodies.forEach((item, i) => list.append(this.melodyListRow(item, i)));
    }
    v.append(list);

    const add = document.createElement("button");
    add.className = "loop-add";
    add.textContent = "＋ Add melody";
    add.onclick = () => this.addMelody();
    v.append(add);
  }

  /** One row in the melody list: reorder, name + scale/notes/placement summary, remove. */
  private melodyListRow(item: MelodyItem, i: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "loop-row";
    row.style.setProperty("--vc", VOICE_COLORS[MELODY_COLOR_INDEX]);

    const order = document.createElement("div");
    order.className = "loop-order";
    const mkMove = (text: string, disabled: boolean, dir: number) => {
      const b = document.createElement("button");
      b.className = "loop-move"; b.textContent = text; b.disabled = disabled;
      b.onclick = (e) => { e.stopPropagation(); this.moveMelody(i, dir); };
      return b;
    };
    order.append(mkMove("▲", i === 0, -1), mkMove("▼", i === this.track.melodies.length - 1, 1));

    const body = document.createElement("button");
    body.className = "loop-body";
    const nm = document.createElement("span");
    nm.className = "loop-name";
    nm.textContent = `Melody ${i + 1}`;
    const sum = document.createElement("span");
    sum.className = "loop-summary";
    const n = countNotes(item.node);
    sum.textContent = `${ALL_SCALES[item.node.scale]} · ${n} note${n === 1 ? "" : "s"} · ${this.ruleSummary(item.inst)}`;
    body.append(nm, sum);
    body.onclick = () => this.openMelodyItem(i);

    const rm = document.createElement("button");
    rm.className = "loop-remove";
    rm.textContent = "×";
    rm.title = "Remove this melody";
    rm.onclick = (e) => { e.stopPropagation(); this.track.melodies.splice(i, 1); this.melodyChanged(); };

    row.append(order, body, rm);
    return row;
  }

  /** Reorder a melody in the list. */
  private moveMelody(i: number, dir: number): void {
    const j = i + dir;
    const ms = this.track.melodies;
    if (j < 0 || j >= ms.length) return;
    [ms[i], ms[j]] = [ms[j], ms[i]];
    this.melodyChanged();
  }

  /** One melody item's params page: the scale/notes editor + Length + Instrument-sound and
      Loop-options buttons. Back returns to the melody list. */
  private renderMelodyItemParams(item: MelodyItem): void {
    const v = this.viewRoot;
    const c = MELODY_COLOR_INDEX;
    const atRoot = this.melodyPath.length === 0;
    const node = this.currentMelodyNode();
    // Sound / Transition are item-level (root only); drilling into a branch drops back to Notes.
    if (!atRoot && (this.melodyTab === "sound" || this.melodyTab === "transition")) this.melodyTab = "notes";

    const head = document.createElement("div");
    head.className = "mixer-head";
    head.style.setProperty("--vc", VOICE_COLORS[c]);
    const back = document.createElement("button");
    back.className = "mixer-back";
    // At the item root, Back returns to the melody list; inside a branch, up one level.
    back.textContent = atRoot ? "‹ Melodies" : "‹ Back";
    back.onclick = () => {
      if (atRoot) { this.melodyItemIndex = -1; this.render(); }
      else { this.melodyPath.pop(); this.render(); }
    };
    const title = document.createElement("h2");
    title.className = "mixer-title";
    title.textContent = atRoot ? `Melody ${this.melodyItemIndex + 1}` : "Branch";
    const tree = document.createElement("button");
    tree.className = "mixer-open melody-tree-btn";
    tree.textContent = "⤢ Tree";
    tree.title = "Zoomed-out tree of this melody";
    tree.onclick = () => this.openMelodyTree(item);
    head.append(back, title, this.melodySoloBtn(item), tree);
    v.append(head);

    if (this.melodySoloItem === item) v.append(this.melodySoloNote());
    if (!atRoot) v.append(this.melodyBreadcrumb(item));

    // Tab nav: Notes / Sing / Sound / Transition — mirroring a voice loop's popup. Sing
    // records into the context being edited (root or branch); Sound and Transition act on
    // the whole item's instrument, so they're only offered at the item root.
    const nav = document.createElement("div");
    nav.className = "placement-seg placement-nav melody-tabs";
    nav.style.setProperty("--vc", VOICE_COLORS[c]);
    const mkTab = (tab: typeof this.melodyTab, text: string) => {
      const b = document.createElement("button");
      b.className = "seg-btn" + (this.melodyTab === tab ? " on" : "");
      b.textContent = text;
      b.onclick = () => { if (this.melodyTab !== tab) { this.melodyTab = tab; this.render(); } };
      return b;
    };
    nav.append(mkTab("notes", "Notes"), mkTab("sing", "🎤 Sing"));
    if (atRoot) nav.append(mkTab("sound", "🎛 Sound"), mkTab("transition", "Transition"));
    v.append(nav);

    if (this.melodyTab === "sing") { v.append(this.melodySingSection(node)); return; }
    // Sound / Transition act on the item instrument (root only — a branch has no own sound).
    if (atRoot && this.melodyTab === "sound") {
      const instWrap = document.createElement("div");
      instWrap.className = "melody-inst";
      instWrap.append(this.melodyInstrumentMenu(item.inst));
      v.append(instWrap);
      return;
    }
    if (atRoot && this.melodyTab === "transition") {
      v.append(this.transitionControls(item.inst, () => this.render(), { unit: "bar" }));
      return;
    }

    if (atRoot) {
      const seqView = this.melodySequenceView(node, Math.max(1, Math.round(item.inst.rule.forBars)));
      if (seqView) v.append(seqView);
      v.append(this.melodyGenerateRow(node));

      // Length (phrase bars) + Loop options.
      const lenBar = document.createElement("div");
      lenBar.className = "placement-controls melody-genbar";
      lenBar.style.setProperty("--vc", VOICE_COLORS[c]);
      lenBar.append(this.stepperRow("Length", Math.max(1, Math.round(item.inst.rule.forBars)), 1, 64,
        (nn) => { item.inst.rule.forBars = nn; this.melodyChanged(); }, (nn) => `${nn} bar${nn === 1 ? "" : "s"}`));
      v.append(lenBar);

      const optBtn = document.createElement("button");
      optBtn.className = "seg-btn melody-inst-btn";
      optBtn.style.setProperty("--vc", VOICE_COLORS[c]);
      optBtn.textContent = "⚙ Loop options ›";
      optBtn.onclick = () => { this.melodyOptionsPage = true; this.render(); };
      v.append(optBtn);
    }

    v.append(this.melodyScaleControls(node));

    const notesHd = document.createElement("div");
    notesHd.className = "placement-row melody-notes-head";
    const nLbl = document.createElement("span");
    nLbl.className = "placement-lbl transition-head";
    nLbl.textContent = "Notes";
    notesHd.append(nLbl);
    v.append(notesHd);

    v.append(this.melodyGenerateBar(node));
    v.append(this.melodyNoteGrid(node));

    const add = document.createElement("button");
    add.className = "loop-add";
    add.textContent = "＋ Add note";
    add.onclick = () => { node.notes.push(defaultNote()); this.melodyChanged(); };
    v.append(add);
  }

  /** One melody item's Loop-options page: the placement rule (Repeat every / length /
      overlap-solo), reusing the loop placement editor. Back returns to the item. */
  private renderMelodyOptionsPage(item: MelodyItem): void {
    const v = this.viewRoot;
    const head = document.createElement("div");
    head.className = "mixer-head";
    head.style.setProperty("--vc", VOICE_COLORS[MELODY_COLOR_INDEX]);
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = "‹ Melody";
    back.onclick = () => { this.melodyOptionsPage = false; this.render(); };
    const title = document.createElement("h2");
    title.className = "mixer-title";
    title.textContent = "Loop options";
    head.append(back, title);
    v.append(head);
    v.append(this.placementControls(item.inst, () => this.render()));
  }


  /** Scale-driven generation controls: how many notes to draw, a Generate button that
      fills the grid with fresh random notes, and the Add-branch mode toggle. */
  private melodyGenerateBar(node: MelodyNode): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "placement-controls melody-genbar";
    wrap.style.setProperty("--vc", VOICE_COLORS[MELODY_COLOR_INDEX]);
    const maxNotes = degreesPerOctave(node.scale) * 2;
    wrap.append(this.stepperRow("Count", this.melodyGenCount, 1, maxNotes,
      (n) => { this.melodyGenCount = n; this.render(); }, (n) => `${n} note${n === 1 ? "" : "s"}`));

    const row = document.createElement("div");
    row.className = "placement-row melody-genbtns";
    const gen = document.createElement("button");
    gen.className = "seg-btn melody-gen-btn";
    gen.textContent = "⚄ Generate";
    gen.onclick = () => { randomizeNotes(node, this.melodyGenCount); this.melodyChanged(); };
    const branch = document.createElement("button");
    branch.className = "seg-btn melody-branch-toggle" + (this.melodyBranchMode ? " on" : "");
    branch.textContent = this.melodyBranchMode ? "⑃ Branching…" : "⑃ Add branch";
    branch.title = "When on, tap a note square to branch a sub-phrase off it";
    branch.onclick = () => { this.melodyBranchMode = !this.melodyBranchMode; this.render(); };
    row.append(gen, branch);
    wrap.append(row);
    return wrap;
  }

  /** The context's notes as a compact wrapping grid of squares (letter + weight). Branch
      (Bn) squares sit inline right after the note they branch from. Tapping a note square
      opens its settings popup — or, in Add-branch mode, branches it; tapping a Bn square
      drills into that sub-phrase. */
  private melodyNoteGrid(node: MelodyNode): HTMLElement {
    const grid = document.createElement("div");
    grid.className = "melody-grid";
    grid.style.setProperty("--vc", VOICE_COLORS[MELODY_COLOR_INDEX]);
    if (node.notes.length === 0) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Pick a scale and a count, then Generate — or add notes by hand. Tap a square to edit it; turn on Add branch to branch a note into a sub-phrase.";
      grid.append(hint);
      return grid;
    }
    let branchN = 0;
    node.notes.forEach((note) => {
      const sq = document.createElement("button");
      sq.className = "melody-sq" + (note.branch ? " has-branch" : "") + (this.melodyBranchMode ? " arm" : "");
      sq.style.setProperty("--nc", this.noteColor(node, note)); // each note its own colour
      const letter = document.createElement("span");
      letter.className = "melody-sq-letter";
      letter.textContent = this.noteLabelFor(node, note);
      const w = document.createElement("span");
      w.className = "melody-sq-weight";
      w.textContent = String(note.weight);
      sq.append(letter, w);
      sq.onclick = () => {
        if (this.melodyBranchMode) {
          if (!note.branch) { note.branch = newBranch(node); this.melodyChanged(); }
        } else {
          this.openMelodyNotePopup(node, note);
        }
      };
      grid.append(sq);

      if (note.branch) {
        branchN++;
        const n = countNotes(note.branch);
        const b = document.createElement("button");
        b.className = "melody-sq branch";
        const bl = document.createElement("span");
        bl.className = "melody-sq-letter";
        bl.textContent = `B${branchN}`;
        const bc = document.createElement("span");
        bc.className = "melody-sq-weight";
        bc.textContent = `${n}n`;
        b.append(bl, bc);
        b.title = "Open this branch";
        b.onclick = () => { this.melodyPath = [...this.melodyPath, note]; this.render(); };
        grid.append(b);
      }
    });
    return grid;
  }

  // --- Sing tab (voice → notes) -----------------------------------------

  /** The Sing tab: record yourself singing and the app pitch-tracks the mic live — the
      tuner shows the note it hears, the strip collects the sung notes in order, and
      Apply turns the take into this context's notes: as a sequential chain that keeps
      the sung order, or as a plain weighted pool for the dice walk. */
  private melodySingSection(node: MelodyNode): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "melody-sing";
    wrap.style.setProperty("--vc", VOICE_COLORS[MELODY_COLOR_INDEX]);
    const rec = this.singSession;

    // Live tuner: the pitch being heard right now.
    const tuner = document.createElement("div");
    tuner.className = "sing-tuner";
    const noteEl = document.createElement("div");
    noteEl.className = "sing-note";
    noteEl.textContent = "—";
    const centsTrack = document.createElement("div");
    centsTrack.className = "sing-cents";
    const centsMark = document.createElement("div");
    centsMark.className = "sing-cents-mark";
    centsTrack.append(centsMark);
    const hzEl = document.createElement("div");
    hzEl.className = "sing-hz";
    hzEl.textContent = rec ? "listening…" : "mic off";
    tuner.append(noteEl, centsTrack, hzEl);
    wrap.append(tuner);

    const btn = document.createElement("button");
    btn.className = "sing-rec" + (rec ? " armed" : "");
    btn.textContent = rec ? "■ Stop" : "● Record";
    btn.onclick = () => {
      if (this.singSession) { this.stopSing(); this.render(); }
      else void this.startSing();
    };
    wrap.append(btn);

    if (this.singError) {
      const err = document.createElement("p");
      err.className = "sing-err";
      err.textContent = this.singError;
      wrap.append(err);
    }

    // The sung notes so far (live: as heard; after Stop: snapped onto this scale).
    const strip = document.createElement("div");
    strip.className = "sing-strip";

    if (rec) {
      rec.els = { note: noteEl, cents: centsMark, hz: hzEl, strip };
      rec.lastN = 0;
      for (const s of rec.tracker.done) {
        strip.append(this.singChip(midiName(s.midi), "", this.pcColor(Math.round(s.midi))));
      }
      rec.lastN = rec.tracker.done.length;
      wrap.append(strip);
      const hint = document.createElement("p");
      hint.className = "sing-hint";
      hint.textContent = "Sing or hum — hold each note; take a short breath to separate repeated notes.";
      wrap.append(hint);
      return wrap;
    }

    if (this.singTake && this.singTake.length > 0) {
      const mapped = sungToMelodyNotes(this.singTake, this.tempo, node.scale, node.root, node.octave);
      const headline = document.createElement("p");
      headline.className = "sing-take-head";
      headline.textContent = `Your take — ${mapped.length} note${mapped.length === 1 ? "" : "s"}, snapped to ${ALL_ROOTS[node.root]} ${ALL_SCALES[node.scale]}:`;
      wrap.append(headline);
      mapped.forEach((mn) => strip.append(this.singChip(this.noteLabelFor(node, mn), `×${mn.lengthSteps}`, this.noteColor(node, mn))));
      wrap.append(strip);

      const apply = document.createElement("div");
      apply.className = "placement-row sing-apply";
      const inOrder = document.createElement("button");
      inOrder.className = "seg-btn sing-apply-order";
      inOrder.textContent = "✓ Use as my loop";
      inOrder.title = "Loop exactly what you sang — the melody plays your take on repeat, in order, nothing added";
      inOrder.onclick = () => {
        const steps = chainNotes(node, mapped);
        const atRoot = this.melodyPath.length === 0;
        let bars = 0;
        if (atRoot) {
          // Size the phrase to ONE pass of the take, so the fill placement loops it
          // back-to-back across the track.
          bars = Math.max(1, Math.min(64, Math.ceil(steps / STEPS_PER_BAR)));
          this.currentMelodyItem()!.inst.rule.forBars = bars;
        }
        this.afterSingApply();
        if (bars) this.toast(`Looping your take — Length set to ${bars} bar${bars === 1 ? "" : "s"}`);
      };
      const asPool = document.createElement("button");
      asPool.className = "seg-btn";
      asPool.textContent = "⚄ Use as dice pool";
      asPool.title = "Replace this context's notes with the sung notes; the seeded walk picks their order";
      asPool.onclick = () => { node.notes = mapped; this.afterSingApply(); };
      const clear = document.createElement("button");
      clear.className = "seg-btn sing-clear";
      clear.textContent = "✕";
      clear.title = "Discard this take";
      clear.onclick = () => { this.singTake = null; this.render(); };
      apply.append(inOrder, asPool, clear);
      wrap.append(apply);

      const hint = document.createElement("p");
      hint.className = "sing-hint";
      hint.textContent = "Use as my loop plays the take verbatim — your notes, your order, on repeat, nothing added (Length is set to one pass). Dice pool lets the seeded walk shuffle the sung notes instead. Lengths and pauses are quantized to 16ths at the current tempo.";
      wrap.append(hint);
      return wrap;
    }

    const hint = document.createElement("p");
    hint.className = "sing-hint";
    hint.textContent = "Hit Record and sing a phrase — each held note becomes a note here, in the order you sang it, snapped to this scale and quantized to the tempo.";
    wrap.append(hint);
    return wrap;
  }

  /** One chip in the Sing strip: a sung/mapped note label (+ optional length sub). */
  private singChip(label: string, sub: string, color: string): HTMLElement {
    const chip = document.createElement("span");
    chip.className = "sing-chip";
    chip.style.setProperty("--nc", color);
    const l = document.createElement("span");
    l.textContent = label;
    chip.append(l);
    if (sub) {
      const s = document.createElement("span");
      s.className = "sub";
      s.textContent = sub;
      chip.append(s);
    }
    return chip;
  }

  /** Shared post-Apply: drop the take and show the result on the Notes tab. */
  private afterSingApply(): void {
    this.singTake = null;
    this.melodyTab = "notes";
    this.melodyChanged();
  }

  /** Per-frame DOM updates while recording (no full render): the tuner's note, cents
      marker and Hz read-out, plus newly completed sung notes appended to the strip. */
  private updateSingLive(s: SingSession): void {
    const els = s.els;
    if (!els || !document.contains(els.note)) return;
    const m = s.tracker.liveMidi;
    if (m === null) {
      els.note.textContent = "—";
      els.note.classList.remove("voiced");
      els.hz.textContent = "listening…";
    } else {
      els.note.textContent = midiName(m);
      els.note.classList.add("voiced");
      const cents = Math.round((m - Math.round(m)) * 100);
      els.cents.style.left = `${50 + cents}%`;
      els.hz.textContent = `${Math.round(440 * Math.pow(2, (m - 69) / 12))} Hz · ${cents >= 0 ? "+" : ""}${cents}¢`;
    }
    const done = s.tracker.done;
    for (let i = s.lastN; i < done.length; i++) {
      els.strip.append(this.singChip(midiName(done[i].midi), "", this.pcColor(Math.round(done[i].midi))));
    }
    s.lastN = done.length;
  }

  /** Start a live Sing recording: mic → analyser → per-frame pitch detection into a
      SingTracker, with the tuner and strip updated directly (no re-render per frame). */
  private async startSing(): Promise<void> {
    if (this.singSession) return;
    this.singTake = null;
    this.singError = null;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Raw voice tracks best: browser echo-cancel/noise-suppress smear the pitch.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      this.singError = "Microphone unavailable — check the browser's mic permission.";
      this.render();
      return;
    }
    const tap = this.engine.micTap(stream);
    if (!tap) {
      for (const t of stream.getTracks()) t.stop();
      this.singError = "Audio engine isn't running yet — tap ▶ Start first.";
      this.render();
      return;
    }
    const session: SingSession = {
      stream, dispose: tap.dispose, analyser: tap.analyser,
      buf: new Float32Array(tap.analyser.fftSize),
      tracker: new SingTracker(), raf: 0, els: null, lastN: 0,
    };
    this.singSession = session;
    const loop = () => {
      if (this.singSession !== session) return; // stopped
      session.analyser.getFloatTimeDomainData(session.buf);
      session.tracker.push(detectPitchHz(session.buf, this.engine.sampleRate), performance.now());
      this.updateSingLive(session);
      session.raf = requestAnimationFrame(loop);
    };
    session.raf = requestAnimationFrame(loop);
    this.render(); // arm the tuner and swap Record → Stop
  }

  /** Stop the live Sing recording (mic off), keeping the take for the Apply buttons. */
  private stopSing(): void {
    const s = this.singSession;
    if (!s) return;
    this.singSession = null;
    cancelAnimationFrame(s.raf);
    s.dispose();
    for (const t of s.stream.getTracks()) t.stop();
    const take = s.tracker.finish();
    this.singTake = take.length ? take : null;
    if (take.length === 0) this.singError = "No notes heard — try singing closer to the mic.";
  }

  /** Open (or re-open, after a re-render) a note's settings popup — the full per-note
      controls in a floating card over the grid. */
  private openMelodyNotePopup(node: MelodyNode, note: MelodyNote): void {
    this.melodyNoteEdit = note;
    this.buildMelodyNotePopup(node, note, true);
  }

  /** Pass `enter` on a fresh open to play the card's entrance (re-opens after an
      in-place re-render stay still). */
  private buildMelodyNotePopup(node: MelodyNode, note: MelodyNote, enter = false): void {
    document.querySelector(".melody-note-overlay")?.remove();
    const i = node.notes.indexOf(note);
    if (i < 0) { this.melodyNoteEdit = null; return; } // note gone (removed / drilled away)
    const overlay = document.createElement("div");
    overlay.className = "voice-sheet-overlay melody-note-overlay" + (enter ? " sheet-enter" : "");
    overlay.onclick = (e) => { if (e.target === overlay) this.closeMelodyNotePopup(); };
    const card = document.createElement("div");
    card.className = "voice-sheet placement-sheet melody-note-sheet";
    card.style.setProperty("--vc", VOICE_COLORS[MELODY_COLOR_INDEX]);
    const head = document.createElement("div");
    head.className = "voice-sheet-head";
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = "‹ Notes";
    back.onclick = () => this.closeMelodyNotePopup();
    const title = document.createElement("h2");
    title.className = "voice-sheet-title";
    title.textContent = `Note ${this.noteLabelFor(node, note)}`;
    head.append(back, title);
    card.append(head);
    card.append(this.melodyNoteRow(node, note, i));
    overlay.append(card);
    this.root.append(overlay);
  }

  private closeMelodyNotePopup(): void {
    this.melodyNoteEdit = null;
    document.querySelector(".melody-note-overlay")?.remove();
    this.render();
  }

  /** The path from the root context down to the branch being edited, each crumb tapping
      back to that level. */
  private melodyBreadcrumb(item: MelodyItem): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "melody-crumbs";
    const crumb = (text: string, depth: number) => {
      const b = document.createElement("button");
      b.className = "melody-crumb" + (depth === this.melodyPath.length ? " here" : "");
      b.textContent = text;
      b.onclick = () => { this.melodyPath = this.melodyPath.slice(0, depth); this.render(); };
      return b;
    };
    wrap.append(crumb(`Melody ${this.melodyItemIndex + 1}`, 0));
    let node = item.node;
    this.melodyPath.forEach((note, i) => {
      const sep = document.createElement("span");
      sep.className = "melody-crumb-sep";
      sep.textContent = "›";
      wrap.append(sep, crumb(this.noteLabelFor(node, note), i + 1));
      node = note.branch ?? node;
    });
    return wrap;
  }

  /** A note's display label ("E", "A+1") in its context's scale/root. */
  private noteLabelFor(node: MelodyNode, note: MelodyNote): string {
    const len = degreesPerOctave(node.scale);
    const nm = noteNameForDegree(note.degree, node.root, node.scale);
    const oct = Math.floor(note.degree / len);
    return oct === 0 ? nm : `${nm}${oct > 0 ? "+" : ""}${oct}`;
  }

  /** Generate-again / Back for the melody's seeded note order, plus a note-count read-out.
      A strict chain (a take kept in order) plays verbatim, so its roll buttons are hidden. */
  private melodyGenerateRow(node: MelodyNode): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "placement-controls melody-generate";
    wrap.style.setProperty("--vc", VOICE_COLORS[MELODY_COLOR_INDEX]);
    const chain = isChain(node);
    const row = document.createElement("div");
    row.className = "placement-row";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = "Order";
    const hint = document.createElement("span");
    hint.className = "melody-gen-hint";
    hint.textContent = node.notes.length === 0 ? "add notes to generate"
      : chain ? "your order — plays verbatim, looping"
      : "seeded — same weights, new order";
    row.append(lbl, hint);
    wrap.append(row);
    if (!chain) wrap.append(this.rollRow(node, () => this.render()));
    return wrap;
  }

  /** A melody instrument's shuffle menu (same authoring surface as a loop's sound). */
  private melodyInstrumentMenu(inst: Loop): HTMLElement {
    return buildVoiceShuffleMenu(this.voiceEditorFor(inst), REF_DRUM, {
      onChange: async () => { await this.writeAndNormalizeLoop(inst); this.render(); },
      audition: () => this.auditionLoop(inst),
      onFullParams: () => { this.soundLoop = inst; this.soundReturn = "melody"; this.view = "sound"; this.render(); },
      context: () => this.shuffleContext(),
      mates: () => this.breedMatesFor(inst),
      report: (kind) => this.reportLoopSound(inst, kind),
    });
  }

  /** Zoomed-out view of the whole melody as a NODE TREE: a pulsing CLOCK node at the top
      feeds every first-level note; a note that spawns a branch fans out into that
      sub-phrase's notes, and so on down. Notes are pitch-coloured circles (matching the
      grid squares), wires blend parent → child colour, and contexts other than the one
      being edited sit dimmed. Tap a note to jump to its settings, tap the clock for the
      root context, or tap a ⊕ port to grow a branch off a leaf note right here.
      `focusNote` centres the viewport on that note (used after adding a branch). */
  private openMelodyTree(item: MelodyItem, focusNote?: MelodyNote): void {
    document.querySelector(".melody-tree-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "melody-tree-overlay";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    const card = document.createElement("div");
    card.className = "melody-tree-card";
    card.style.setProperty("--vc", VOICE_COLORS[MELODY_COLOR_INDEX]);

    const head = document.createElement("div");
    head.className = "melody-tree-head";
    const title = document.createElement("h3");
    title.className = "tr-title";
    title.textContent = `Melody ${this.melodyItemIndex + 1}`;
    const sub = document.createElement("p");
    sub.className = "melody-tree-sub";
    const total = countNotes(item.node);
    sub.textContent = `${ALL_ROOTS[item.node.root]} ${ALL_SCALES[item.node.scale]} · ${total} note${total === 1 ? "" : "s"}`;
    head.append(title, sub);
    card.append(head);

    // Tidy-tree layout over individual NOTES: the clock is the root, and a note's
    // children are its branch's notes. Leaves take sequential x slots; a parent centres
    // over its children; y = depth. Positions are in slot/row units, scaled below.
    interface TN {
      ctx: MelodyNode;         // the context that owns `note` (for the clock: the root context)
      note: MelodyNote | null; // null = the clock
      ctxPath: MelodyNote[];   // melodyPath that reaches `ctx`
      color: string; label: string; depth: number; x: number; kids: TN[];
    }
    let leaf = 0, maxDepth = 0;
    const layNote = (ctx: MelodyNode, ctxPath: MelodyNote[], note: MelodyNote, depth: number): TN => {
      maxDepth = Math.max(maxDepth, depth);
      const kids = note.branch ? note.branch.notes.map((k) => layNote(note.branch!, [...ctxPath, note], k, depth + 1)) : [];
      const x = kids.length ? kids.reduce((s, k) => s + k.x, 0) / kids.length : leaf++;
      return { ctx, note, ctxPath, color: this.noteColor(ctx, note), label: this.noteLabelFor(ctx, note), depth, x, kids };
    };
    const kids = item.node.notes.map((n) => layNote(item.node, [], n, 1));
    const rootT: TN = {
      ctx: item.node, note: null, ctxPath: [], color: VOICE_COLORS[MELODY_COLOR_INDEX], label: "",
      depth: 0, x: kids.length ? kids.reduce((s, k) => s + k.x, 0) / kids.length : leaf++, kids,
    };

    const NS = "http://www.w3.org/2000/svg";
    const R = 16, CR = 19, SLOT = 56, ROW = 82, PAD = 18;
    const cx = (t: TN) => PAD + t.x * SLOT + SLOT / 2;
    const cy = (t: TN) => PAD + CR + t.depth * ROW;
    const width = leaf * SLOT + PAD * 2;
    const height = PAD + CR + maxDepth * ROW + R + 30 + PAD; // extra room for the last row's ⊕ ports
    const cur = this.currentMelodyNode();

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "melody-tree-svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    const defs = document.createElementNS(NS, "defs");
    svg.append(defs);
    const el = (name: string, attrs: Record<string, string | number>, parent: Element): SVGElement => {
      const e = document.createElementNS(NS, name);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      parent.append(e);
      return e;
    };

    // Wires first (under the nodes): an S-curve per parent → child, stroked with a
    // gradient blending the two nodes' colours.
    let gradN = 0;
    const link = (t: TN) => {
      for (const k of t.kids) {
        const x1 = cx(t), y1 = cy(t) + (t.note ? R : CR), x2 = cx(k), y2 = cy(k) - R, my = (y1 + y2) / 2;
        const id = `mt-grad-${gradN++}`;
        const grad = el("linearGradient", { id, gradientUnits: "userSpaceOnUse", x1, y1, x2, y2 }, defs);
        el("stop", { offset: 0, "stop-color": t.color }, grad);
        el("stop", { offset: 1, "stop-color": k.color }, grad);
        el("path", {
          d: `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`,
          class: "melody-tree-link" + (k.ctx === cur ? "" : " dim"),
          stroke: `url(#${id})`,
        }, svg);
        link(k);
      }
    };
    link(rootT);

    // Leave the tree for an editor: land on `path`'s context, optionally with a note's
    // settings popup open (render() rebuilds the popup from melodyNoteEdit).
    const jump = (path: MelodyNote[], note: MelodyNote | null) => {
      overlay.remove();
      this.view = "melody";
      this.melodyPath = path;
      this.melodyNoteEdit = note;
      this.render();
    };

    const drawNote = (t: TN) => {
      const note = t.note!;
      const x = cx(t), y = cy(t);
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "melody-tree-node" + (t.ctx === cur ? "" : " dim"));
      g.style.setProperty("--nc", t.color);
      el("circle", { cx: x, cy: y, r: R + 5, class: "nd-halo" }, g);
      el("circle", { cx: x, cy: y, r: R, class: "nd-body" }, g);
      const lbl = el("text", { x, y, dy: "0.36em", class: "melody-tree-lbl" + (t.label.length > 2 ? " small" : "") }, g);
      lbl.textContent = t.label;
      g.onclick = () => jump(t.ctxPath, note);
      svg.append(g);

      if (!note.branch) {
        // ⊕ port: grow a branch (sub-phrase) off this note, straight from the tree.
        const py = y + R + 16;
        const add = document.createElementNS(NS, "g");
        add.setAttribute("class", "melody-tree-add");
        add.style.setProperty("--nc", t.color);
        el("line", { x1: x, y1: y + R + 2, x2: x, y2: py - 9, class: "add-stub" }, add);
        el("circle", { cx: x, cy: py, r: 13, class: "add-hit" }, add);
        el("circle", { cx: x, cy: py, r: 8, class: "add-ring" }, add);
        el("line", { x1: x - 3.5, y1: py, x2: x + 3.5, y2: py, class: "add-plus" }, add);
        el("line", { x1: x, y1: py - 3.5, x2: x, y2: py + 3.5, class: "add-plus" }, add);
        el("title", {}, add).textContent = "Branch a sub-phrase off this note";
        add.onclick = (e) => {
          e.stopPropagation();
          note.branch = newBranch(t.ctx);
          this.melodyChanged();            // recompile + re-render the page underneath
          this.openMelodyTree(item, note); // rebuild the tree, centred on this note
        };
        svg.append(add);
      }
      t.kids.forEach(drawNote);
    };

    // The clock: the pulse source every first-level note hangs off. Always bright.
    {
      const x = cx(rootT), y = cy(rootT);
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "melody-tree-clock");
      el("circle", { cx: x, cy: y, r: CR, class: "clk-pulse" }, g);
      el("circle", { cx: x, cy: y, r: CR, class: "clk-pulse p2" }, g);
      el("circle", { cx: x, cy: y, r: CR, class: "clk-body" }, g);
      el("path", {
        d: `M ${x - 9} ${y} H ${x - 4} L ${x - 2} ${y - 6} L ${x + 2} ${y + 6} L ${x + 4} ${y} H ${x + 9}`,
        class: "clk-wave",
      }, g);
      el("title", {}, g).textContent = "Clock — the melody starts here";
      g.onclick = () => jump([], null);
      svg.append(g);
    }
    rootT.kids.forEach(drawNote);

    const scroll = document.createElement("div");
    scroll.className = "melody-tree-scroll";
    scroll.append(svg);
    card.append(scroll);

    const foot = document.createElement("div");
    foot.className = "melody-tree-foot";
    const hint = document.createElement("p");
    hint.className = "melody-tree-hint";
    hint.textContent = item.node.notes.length === 0
      ? "No notes yet — add or generate some first."
      : "Tap a note to edit it · ⊕ grows a branch off it";
    const close = document.createElement("button");
    close.className = "tr-cancel";
    close.textContent = "Close";
    close.onclick = () => overlay.remove();
    foot.append(hint, close);
    card.append(foot);
    overlay.append(card);
    this.root.append(overlay);

    // Centre the viewport on the focused note (after a branch add) or on the clock.
    const find = (t: TN): TN | null =>
      t.note === focusNote ? t : t.kids.reduce<TN | null>((f, k) => f ?? find(k), null);
    const hit = focusNote ? find(rootT) : null;
    const fx = hit ? cx(hit) : cx(rootT), fy = hit ? cy(hit) : 0;
    scroll.scrollLeft = Math.max(0, fx - scroll.clientWidth / 2);
    scroll.scrollTop = Math.max(0, fy - scroll.clientHeight / 2);
  }

  /** Scale / root / octave pickers for a melody context, laid out as one COMPACT row
      (each a small labelled field) instead of three tall rows — saves vertical space on
      a phone so the notes + instrument stay in reach. */
  private melodyScaleControls(node: MelodyNode): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "melody-scale-compact";
    wrap.style.setProperty("--vc", VOICE_COLORS[MELODY_COLOR_INDEX]);

    const field = (label: string, control: HTMLElement, cls = ""): HTMLElement => {
      const f = document.createElement("div");
      f.className = "melody-field" + (cls ? " " + cls : "");
      const l = document.createElement("span");
      l.className = "melody-field-lbl";
      l.textContent = label;
      f.append(l, control);
      return f;
    };
    const mkSelect = (options: readonly string[], index: number, onChange: (i: number) => void): HTMLSelectElement => {
      const s = document.createElement("select");
      s.className = "melody-select compact";
      options.forEach((o, i) => {
        const opt = document.createElement("option");
        opt.value = String(i); opt.textContent = o;
        if (i === index) opt.selected = true;
        s.append(opt);
      });
      s.onchange = () => onChange(parseInt(s.value, 10));
      return s;
    };

    const oct = document.createElement("div");
    oct.className = "stepper compact";
    const mkStep = (text: string, disabled: boolean, to: number) => {
      const b = document.createElement("button");
      b.className = "tr-step"; b.textContent = text; b.disabled = disabled;
      b.onclick = () => { node.octave = to; this.melodyChanged(); };
      return b;
    };
    const oval = document.createElement("span");
    oval.className = "stepper-val";
    oval.textContent = node.octave > 0 ? `+${node.octave}` : `${node.octave}`;
    oct.append(mkStep("−", node.octave <= -3, Math.max(-3, node.octave - 1)), oval, mkStep("+", node.octave >= 3, Math.min(3, node.octave + 1)));

    wrap.append(
      field("Scale", mkSelect(ALL_SCALES, node.scale, (i) => { node.scale = i; this.melodyChanged(); }), "grow"),
      field("Root", mkSelect(ALL_ROOTS, node.root, (i) => { node.root = i; this.melodyChanged(); })),
      field("Octave", oct, "oct"),
    );
    return wrap;
  }

  /** A stable colour for a pitch class (semitone mod 12): a hue around the wheel, so each
      note reads as its own colour and repeats of the same pitch match across the UI. */
  private pcColor(semitone: number): string {
    const pc = ((Math.round(semitone) % 12) + 12) % 12;
    return `hsl(${Math.round((pc / 12) * 360)}, 70%, 62%)`;
  }
  /** The colour of a note in its context (by its scale degree's pitch class). */
  private noteColor(node: MelodyNode, note: MelodyNote): string {
    return this.pcColor(semitoneForDegree(note.degree, node.scale) + node.root);
  }
  /** The colour of an emitted pitch (Hz → pitch class), matching noteColor. */
  private hzColor(hz: number): string {
    return this.pcColor(12 * Math.log2(hz / 440));
  }

  /** A mini PIANO ROLL — time →, pitch ↑, each note a coloured bar (colour = pitch class,
      matching the note squares). `events` are {start,len,hz} in 16th steps over `total`
      steps. Returns null when empty. */
  private pianoRollSvg(events: { start: number; len: number; hz: number }[], total: number): HTMLElement | null {
    if (!events.length) return null;
    total = Math.max(1, total);
    const semis = events.map((e) => Math.round(12 * Math.log2(e.hz / 440)));
    const maxS = Math.max(...semis), minS = Math.min(...semis);
    const rows = Math.max(1, maxS - minS + 1);

    const wrap = document.createElement("div");
    wrap.className = "melody-seq";
    wrap.style.setProperty("--vc", VOICE_COLORS[MELODY_COLOR_INDEX]);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "melody-seq-svg");
    svg.setAttribute("viewBox", `0 0 ${total} ${rows}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("height", String(Math.min(120, Math.max(46, rows * 11))));
    events.forEach((e, i) => {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", String(e.start));
      r.setAttribute("y", String(maxS - semis[i] + 0.12));
      r.setAttribute("width", String(Math.max(0.5, e.len - 0.12)));
      r.setAttribute("height", "0.76");
      r.setAttribute("fill", this.hzColor(e.hz));
      svg.append(r);
    });
    wrap.append(svg);
    return wrap;
  }

  /** A piano roll of ONE item's generated phrase (`bars` long). */
  private melodySequenceView(node: MelodyNode, bars: number): HTMLElement | null {
    const seq = generateMelody(node, bars);
    const events: { start: number; len: number; hz: number }[] = [];
    let cursor = 0;
    for (const e of seq) {
      cursor += Math.max(0, e.restSteps);
      const len = Math.max(1, e.lengthSteps);
      events.push({ start: cursor, len, hz: e.hz });
      cursor += len;
    }
    return this.pianoRollSvg(events, cursor);
  }

  /** A piano roll of the WHOLE melody row: every compiled melody lane placed across the
      track, so the list preview shows all melodies with their real placement. */
  private melodyLanesPreview(): HTMLElement | null {
    const total = Math.max(1, this.track.barLimit) * STEPS_PER_BAR;
    const events: { start: number; len: number; hz: number }[] = [];
    for (const lane of this.arr.lines) {
      if (lane.color !== MELODY_COLOR_INDEX) continue;
      let cursor = 0;
      for (const nd of lane.nodes) {
        const unit = nd.steps >= 1 ? nd.steps : STEPS_PER_BAR;
        const len = Math.max(1, nd.reps | 0) * unit;
        if (nd.soundId >= 0 && nd.pitchHz && nd.pitchHz > 0) events.push({ start: cursor, len, hz: nd.pitchHz });
        cursor += len;
      }
    }
    return this.pianoRollSvg(events, total);
  }

  /** Bar-resolution coverage of the compiled melody lane: 1 where a note sounds. */
  private melodyLaneCells(): number[] {
    const bars = Math.max(1, this.track.barLimit);
    const cells = new Array(bars).fill(0);
    const lane = this.arr.lines.find((l) => l.color === MELODY_COLOR_INDEX);
    if (!lane) return cells;
    let bar = 0;
    for (const n of lane.nodes) {
      const span = (n.reps * (n.steps >= 1 ? n.steps : STEPS_PER_BAR)) / STEPS_PER_BAR;
      if (n.soundId >= 0) for (let b = Math.floor(bar); b < Math.min(bars, Math.ceil(bar + span)); b++) cells[b] = 1;
      bar += span;
    }
    return cells;
  }

  /** The melody lane as a lit/empty timeline strip, wrapped every BARS_PER_ROW bars. */
  private melodyStrip(collect: HTMLElement[] | null): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "color-preview melody-preview";
    wrap.style.setProperty("--vc", VOICE_COLORS[MELODY_COLOR_INDEX]);
    const cells = this.melodyLaneCells();
    const barLimit = Math.max(1, this.track.barLimit);
    const segCount = Math.max(1, Math.ceil(barLimit / BARS_PER_ROW));
    const rowBars = segCount > 1 ? BARS_PER_ROW : barLimit;
    for (let s = 0; s < segCount; s++) {
      const rowEl = document.createElement("div");
      rowEl.className = "color-preview-lane";
      for (let i = 0; i < rowBars; i++) {
        const bar = s * rowBars + i;
        const cell = document.createElement("span");
        const on = bar < barLimit && cells[bar] > 0;
        cell.className = "color-preview-cell" + (on ? " on" : bar >= barLimit ? " pad" : "");
        if (on) cell.style.background = VOICE_COLORS[MELODY_COLOR_INDEX];
        rowEl.append(cell);
      }
      rowEl.dataset.seg = String(s);
      collect?.push(rowEl);
      wrap.append(rowEl);
    }
    return wrap;
  }

  /** One note of a context: degree (note name) + weight + length + pre-note rest, plus a
      Branch button that drills into (or creates) its sequential sub-phrase. */
  private melodyNoteRow(node: MelodyNode, note: MelodyNote, i: number): HTMLElement {
    const len = degreesPerOctave(node.scale);
    const card = document.createElement("div");
    card.className = "melody-note";
    card.style.setProperty("--vc", VOICE_COLORS[MELODY_COLOR_INDEX]);

    const hd = document.createElement("div");
    hd.className = "melody-note-head";
    hd.append(this.stepperRow("Note", note.degree, 0, len * 3 - 1,
      (n) => { note.degree = n; this.melodyChanged(); },
      (deg) => this.noteLabelFor(node, { ...note, degree: deg })));
    const rm = document.createElement("button");
    rm.className = "loop-remove";
    rm.textContent = "×";
    rm.title = "Remove this note";
    rm.onclick = () => { node.notes.splice(i, 1); this.melodyChanged(); };
    hd.append(rm);
    card.append(hd);

    // Weight (dice faces 1..6).
    const wRow = document.createElement("div");
    wRow.className = "placement-row";
    const wLbl = document.createElement("span");
    wLbl.className = "placement-lbl";
    wLbl.textContent = "Weight";
    const faces = document.createElement("div");
    faces.className = "dice-faces";
    const FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
    for (let d = 1; d <= 6; d++) {
      const b = document.createElement("button");
      b.className = "dice-face" + (note.weight === d ? " on" : "");
      b.textContent = FACES[d - 1];
      b.onclick = () => { note.weight = d; this.melodyChanged(); };
      faces.append(b);
    }
    wRow.append(wLbl, faces);
    card.append(wRow);

    card.append(this.numRow("Length", () => note.lengthSteps,
      (n) => { note.lengthSteps = Math.max(1, Math.round(n)); this.recompile(); },
      () => this.render(), () => this.stepLabel(note.lengthSteps)));
    card.append(this.numRow("Rest before", () => note.restSteps,
      (n) => { note.restSteps = Math.max(0, Math.round(n)); this.recompile(); },
      () => this.render(), () => (note.restSteps === 0 ? "none" : this.stepLabel(note.restSteps))));

    // Branch: a sequential sub-phrase that plays after this note, then returns.
    const branchRow = document.createElement("div");
    branchRow.className = "placement-row melody-branch-row";
    const bLbl = document.createElement("span");
    bLbl.className = "placement-lbl";
    bLbl.textContent = "Branch";
    const bBtns = document.createElement("div");
    bBtns.className = "melody-branch-btns";
    const open = document.createElement("button");
    open.className = "seg-btn melody-branch-open";
    if (note.branch) {
      open.classList.add("on");
      open.textContent = `${countNotes(note.branch)} note${countNotes(note.branch) === 1 ? "" : "s"} ›`;
      const del = document.createElement("button");
      del.className = "loop-remove melody-branch-del";
      del.textContent = "×";
      del.title = "Remove this branch";
      del.onclick = () => { note.branch = undefined; this.melodyChanged(); };
      open.onclick = () => { this.melodyPath = [...this.melodyPath, note]; this.render(); };
      bBtns.append(open, del);
    } else {
      open.textContent = "＋ Add branch";
      open.onclick = () => {
        note.branch = newBranch(node);
        this.melodyPath = [...this.melodyPath, note];
        this.melodyChanged();
      };
      bBtns.append(open);
    }
    branchRow.append(bLbl, bBtns);
    card.append(branchRow);
    return card;
  }

  /** A labelled −/+ stepper row (integers within [min,max]); `fmt` renders the value. */
  private stepperRow(label: string, value: number, min: number, max: number, onChange: (n: number) => void, fmt: (n: number) => string): HTMLElement {
    const row = document.createElement("div");
    row.className = "placement-row";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = label;
    const grp = document.createElement("div");
    grp.className = "stepper";
    const minus = document.createElement("button");
    minus.className = "tr-step";
    minus.textContent = "−";
    minus.disabled = value <= min;
    minus.onclick = () => onChange(Math.max(min, value - 1));
    const val = document.createElement("span");
    val.className = "stepper-val";
    val.textContent = fmt(value);
    const plus = document.createElement("button");
    plus.className = "tr-step";
    plus.textContent = "+";
    plus.disabled = value >= max;
    plus.onclick = () => onChange(Math.min(max, value + 1));
    grp.append(minus, val, plus);
    row.append(lbl, grp);
    return row;
  }

  /** A 16th-step count as a musical note value where it maps cleanly (else "N steps"). */
  private stepLabel(steps: number): string {
    const map: Record<number, string> = {
      1: "1/16", 2: "1/8", 3: "dotted 1/8", 4: "1/4", 6: "dotted 1/4",
      8: "1/2", 12: "dotted 1/2", 16: "1 bar",
    };
    return map[steps] ? `${steps} · ${map[steps]}` : `${steps} steps`;
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
    head.append(back, title, this.mixerOpenBtn("color"));
    v.append(head);

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

    // Overarching FX sweep across the whole row over a bar range.
    if (loops.some((l) => l.soundId >= 0)) v.append(this.rowSweepControls(c));
  }

  /** The row transition: an overarching FX sweep across the whole colour over a bar range
      (see RowSweep / the engine's line sweeps). On/off, the bar window, a style, its
      direction into/out of the effect, and the ramp curve. */
  private rowSweepControls(c: number): HTMLElement {
    const ct = this.track.colors[c];
    const wrap = document.createElement("div");
    wrap.className = "placement-controls transition-controls row-sweep";
    wrap.style.setProperty("--vc", VOICE_COLORS[c]);
    const head = document.createElement("span");
    head.className = "placement-lbl transition-head";
    head.textContent = "Row transition";
    wrap.append(head);

    const on = !!ct.sweep?.on;
    const rerender = () => this.render();
    const toggleRow = document.createElement("div");
    toggleRow.className = "placement-row fade-row";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = "Sweep";
    const controls = document.createElement("div");
    controls.className = "fade-controls";
    const toggle = document.createElement("button");
    toggle.className = "seg-btn fade-toggle" + (on ? " on" : "");
    toggle.textContent = on ? "On" : "Off";
    toggle.onclick = () => {
      if (!ct.sweep) ct.sweep = defaultRowSweep();
      ct.sweep.on = !on;
      this.recompile();
      rerender();
    };
    controls.append(toggle);
    if (!on) {
      const hint = document.createElement("p");
      hint.className = "sing-hint";
      hint.textContent = "An FX sweep across the whole row over a bar range — the filter opens, reverb wells up, drive bites… spanning every loop on the row.";
      controls.append(hint);
    }
    toggleRow.append(lbl, controls);
    wrap.append(toggleRow);

    const sweep = ct.sweep;
    if (!on || !sweep) return wrap;

    wrap.append(this.numRow("From bar", () => sweep.fromBar, (n) => {
      sweep.fromBar = Math.max(1, Math.min(this.track.barLimit, Math.round(n)));
      if (sweep.toBar < sweep.fromBar) sweep.toBar = sweep.fromBar;
      this.recompile();
    }, rerender, () => `bar ${sweep.fromBar}`));
    wrap.append(this.numRow("To bar", () => sweep.toBar, (n) => {
      sweep.toBar = Math.max(sweep.fromBar, Math.min(this.track.barLimit, Math.round(n)));
      this.recompile();
    }, rerender, () => `bar ${sweep.toBar}`));

    const styleRow = document.createElement("div");
    styleRow.className = "placement-row fade-row";
    const sLbl = document.createElement("span");
    sLbl.className = "placement-lbl";
    sLbl.textContent = "Style";
    const styles = document.createElement("div");
    styles.className = "placement-seg fade-modes";
    const SWEEP_STYLES: TransitionMode[] = ["fade", "filter", "wash", "thin", "drive", "crush", "echo"];
    for (const m of SWEEP_STYLES) {
      const b = document.createElement("button");
      b.className = "seg-btn" + (sweep.mode === m ? " on" : "");
      b.textContent = this.fadeModeLabel(m, sweep.side === "out" ? "outro" : "intro");
      b.onclick = () => { sweep.mode = m; this.recompile(); rerender(); };
      styles.append(b);
    }
    styleRow.append(sLbl, styles);
    wrap.append(styleRow);

    const dirRow = document.createElement("div");
    dirRow.className = "placement-row fade-row";
    const dLbl = document.createElement("span");
    dLbl.className = "placement-lbl";
    dLbl.textContent = "Direction";
    const dirSeg = document.createElement("div");
    dirSeg.className = "placement-seg fade-modes";
    const mkSide = (s: "out" | "in", text: string) => {
      const b = document.createElement("button");
      b.className = "seg-btn" + (sweep.side === s ? " on" : "");
      b.textContent = text;
      b.onclick = () => { sweep.side = s; this.recompile(); rerender(); };
      return b;
    };
    dirSeg.append(mkSide("out", "Into effect"), mkSide("in", "Out of effect"));
    dirRow.append(dLbl, dirSeg);
    wrap.append(dirRow);

    wrap.append(this.numRow("Curve", () => Math.round((sweep.curve ?? 0) * 100), (n) => {
      sweep.curve = Math.max(0, Math.min(1, Math.round(n) / 100));
      this.recompile();
    }, rerender, () => `${Math.round((sweep.curve ?? 0) * 100)}%`));

    // Ease direction of the curve (toward the window's start or end).
    const easeRow = document.createElement("div");
    easeRow.className = "placement-row fade-row";
    const eLbl = document.createElement("span");
    eLbl.className = "placement-lbl";
    eLbl.textContent = "Ease";
    const easeSeg = document.createElement("div");
    easeSeg.className = "placement-seg fade-modes";
    const mkEase = (d: "out" | "in", text: string) => {
      const b = document.createElement("button");
      b.className = "seg-btn" + ((sweep.dir ?? "out") === d ? " on" : "");
      b.textContent = text;
      b.onclick = () => { sweep.dir = d; this.recompile(); rerender(); };
      return b;
    };
    easeSeg.append(mkEase("out", "Ease out"), mkEase("in", "Ease in"));
    easeRow.append(eLbl, easeSeg);
    wrap.append(easeRow);

    // Live preview of the sweep's blend curve.
    wrap.append(this.rowSweepCurveViz(sweep));
    return wrap;
  }

  /** One row in a colour's loop list: priority reorder (solo), name + rule summary,
      remove. Tapping the row opens the placement popup. */
  private loopRow(loop: Loop, i: number): HTMLElement {
    const c = this.openColor;
    const loops = this.track.colors[c].loops;
    const row = document.createElement("div");
    row.className = "loop-row";
    row.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#4a5064");

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
    nm.textContent = loop.name || (loop.soundId >= 0 ? `Loop ${i + 1}` : "Empty loop");
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

    row.append(order, body, rm);
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

  /** A row of timeline cells for one lane segment. Cell value: -1 = pad (off the track),
      0 = empty bar, >0 = a loop number — filled with that loop's own shade of the colour
      (spread across the colour's loops) so same-row loops read apart even when tiny. */
  private laneCells(cells: number[], c: number): HTMLElement {
    const total = this.track.colors[c].loops.length;
    const row = document.createElement("div");
    row.className = "color-preview-lane";
    for (let b = 0; b < cells.length; b++) {
      const cell = document.createElement("span");
      const num = cells[b];
      cell.className = "color-preview-cell" + (num > 0 ? " on" : num < 0 ? " pad" : "");
      if (num > 0) {
        const t = total > 1 ? (num - 1) / (total - 1) : 0.5;
        const bg = this.shade(VOICE_COLORS[c], t);
        cell.style.background = bg;
        // Dark text on light shades, light text on dark shades.
        const lum = 0.299 * parseInt(bg.slice(1, 3), 16) + 0.587 * parseInt(bg.slice(3, 5), 16) + 0.114 * parseInt(bg.slice(5, 7), 16);
        cell.style.color = lum > 150 ? "rgba(0,0,0,0.8)" : "#fff";
        cell.textContent = String(num);
      }
      row.append(cell);
    }
    return row;
  }

  /** Append a colour's lanes to `parent` as timeline rows, wrapping every BARS_PER_ROW
      bars into stacked "line" sub-rows (each tagged data-seg). When `collect` is given,
      each sub-row is pushed onto it (so the playhead can highlight the active line). */
  private appendLanes(parent: HTMLElement, lanes: number[][], c: number, collect: HTMLElement[] | null): void {
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
        const rowEl = this.laneCells(segCells, c);
        rowEl.dataset.seg = String(s);
        collect?.push(rowEl);
        parent.append(rowEl);
      }
    }
  }

  /** A read-only timeline of one colour's compiled lanes (used on the colour panel). */
  private colorPreview(c: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "color-preview";
    wrap.style.setProperty("--vc", VOICE_COLORS[c]);
    this.appendLanes(wrap, this.colorLaneNumbers(c), c, null);
    return wrap;
  }

  /** A bar-number ruler `width` cells wide, aligned with the timeline cells (labels every
      4 bars). Numbers are the bar position WITHIN a line (1, 5, 9…) since lines wrap. */
  private barRuler(width: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "bar-ruler";
    for (let b = 0; b < width; b++) {
      const cell = document.createElement("span");
      cell.className = "bar-ruler-tick";
      if (b % 4 === 0) cell.textContent = String(b + 1);
      row.append(cell);
    }
    return row;
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
    return `${every} · for ${forB} · ${r.mode}${r.retrigger ? " · re-fade" : ""}`;
  }

  private addLoop(c: number): void {
    const loop = emptyLoop(c, -1);
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
    if (removed) this.voiceEditors.delete(removed);
    if (this.editLoop === removed) this.editLoop = null;
    this.pushSounds();
    this.recompile();
    this.render();
  }

  // --- placement popup --------------------------------------------------
  private closePlacement(): void {
    document.querySelector(".placement-overlay")?.remove();
    this.editLoop = null;
    this.render();
  }

  /** The placement popup for `loop`: a Sound / Loop / Transition tab nav over its sub-pages —
      Loop = the Repeat-every rule + Accents & Ghosts + rhythm circles; Transition = the
      intro/outro fades; Sound = the shuffle menu. Rebuilt in place on any change (it's
      appended to the root, so it survives a panel re-render). */
  private openPlacement(loop: Loop): void {
    document.querySelector(".placement-overlay")?.remove();
    const fresh = this.editLoop !== loop;
    if (fresh) this.placementTab = "loop"; // fresh open starts on the Loop tab
    this.editLoop = loop;
    const rerender = () => this.openPlacement(loop);

    const overlay = document.createElement("div");
    // .sheet-enter animates the card in — only on a fresh open, not in-place rebuilds.
    overlay.className = "placement-overlay voice-sheet-overlay" + (fresh ? " sheet-enter" : "");
    overlay.onclick = (e) => { if (e.target === overlay) this.closePlacement(); };

    const sheet = document.createElement("div");
    sheet.className = "voice-sheet placement-sheet";
    sheet.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#4a5064");

    const head = document.createElement("div");
    head.className = "voice-sheet-head";
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = "‹ Loops";
    back.onclick = () => this.closePlacement();
    const title = document.createElement("h2");
    title.className = "voice-sheet-title";
    title.textContent = loop.name || "Loop";
    head.append(back, title);
    sheet.append(head);

    // Tab nav across the three sub-pages.
    const nav = document.createElement("div");
    nav.className = "placement-seg placement-nav";
    const mkTab = (tab: "sound" | "loop" | "transition", text: string) => {
      const b = document.createElement("button");
      b.className = "seg-btn" + (this.placementTab === tab ? " on" : "");
      b.textContent = text;
      b.onclick = () => { if (this.placementTab !== tab) { this.placementTab = tab; rerender(); } };
      return b;
    };
    nav.append(mkTab("sound", "Sound"), mkTab("loop", "Loop"), mkTab("transition", "Transition"));
    sheet.append(nav);

    if (this.placementTab === "sound") {
      this.appendSoundTab(loop, sheet);
    } else if (this.placementTab === "transition") {
      sheet.append(this.transitionControls(loop, rerender));
    } else {
      sheet.append(this.placementControls(loop, rerender));
      sheet.append(this.lifeControls(loop, rerender));
      const detail = document.createElement("div");
      detail.className = "euclid-detail";
      detail.append(this.rhythmCircles(loop, rerender));
      sheet.append(detail);

      // Copy this whole loop (sound + rhythm + rule) onto another coloured row.
      const copy = document.createElement("button");
      copy.className = "loop-add copy-loop-btn";
      copy.textContent = "⧉ Copy to another row";
      copy.onclick = () => this.openCopyLoopMenu(loop);
      sheet.append(copy);
    }

    overlay.append(sheet);
    this.root.append(overlay);
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

    // Only loop-holding rows (the last colour is the melody, which has no loops).
    for (let c = 0; c < MELODY_COLOR_INDEX; c++) {
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

  /** The Sound tab: the loop's shuffle menu (its sound params), appended under the shared
      tab nav so it has full scroll room. */
  private appendSoundTab(loop: Loop, sheet: HTMLElement): void {
    const menu = buildVoiceShuffleMenu(this.voiceEditorFor(loop), REF_DRUM, {
      onChange: async () => { await this.writeAndNormalizeLoop(loop); },
      audition: () => this.auditionLoop(loop),
      onFullParams: () => {
        this.soundLoop = loop;
        this.soundReturn = "color";
        this.view = "sound";
        document.querySelector(".placement-overlay")?.remove();
        this.render();
      },
      context: () => this.shuffleContext(),
      mates: () => this.breedMatesFor(loop),
      report: (kind) => this.reportLoopSound(loop, kind),
    });
    sheet.append(menu);
  }

  /** The rule editor block: Repeat-every (three-way), For-n-bars, overlap/solo. */
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
      // Manual bar list: a read-only field that opens the custom list numpad (the native
      // numeric keyboard has no comma, so multi-bar entry needs our own pad).
      const row = document.createElement("div");
      row.className = "placement-row placement-atbars";
      const lbl = document.createElement("span");
      lbl.className = "placement-lbl";
      lbl.textContent = "Bars";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.readOnly = true;
      inp.inputMode = "none";
      inp.placeholder = "tap to set — e.g. 1, 5, 9";
      const shown = () => (r.every as { bars: number[] }).bars.join(", ");
      inp.value = shown();
      inp.onclick = () => this.openNumpad({
        title: "At bars",
        value: shown() || "—",
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
    } else if (r.every.kind === "fill") {
      const hint = document.createElement("p");
      hint.className = "hint placement-hint";
      hint.textContent = "Fills every bar. Order it below other solo loops (▼) so they win and it fills only the gaps.";
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

    // Overlap / Solo.
    const modeRow = document.createElement("div");
    modeRow.className = "placement-row";
    const modeLbl = document.createElement("span");
    modeLbl.className = "placement-lbl";
    modeLbl.textContent = "When it clashes";
    const modeSeg = document.createElement("div");
    modeSeg.className = "placement-seg";
    const mkMode = (m: "solo" | "overlap", text: string) => {
      const b = document.createElement("button");
      b.className = "seg-btn" + (r.mode === m ? " on" : "");
      b.textContent = text;
      b.onclick = () => { if (r.mode !== m) { r.mode = m; this.recompile(); rerender(); } };
      return b;
    };
    modeSeg.append(mkMode("solo", "Solo"), mkMode("overlap", "Overlap"));
    modeRow.append(modeLbl, modeSeg);
    wrap.append(modeRow);
    return wrap;
  }

  /** Fade in / fade out for a loop, folded into its own window as intro/outro envelopes
      (see lines.ts — they add no length, covering the loop's first/last reps). Each side:
      an On/Off toggle, a fade-style picker, and a length in reps capped so the two never
      overrun a single placement. */
  private transitionControls(loop: Loop, rerender: () => void, opts?: { unit: "bar" }): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "placement-controls transition-controls";
    const head = document.createElement("span");
    head.className = "placement-lbl transition-head";
    head.textContent = "Transitions";
    wrap.append(head);

    const forBars = Math.max(1, Math.round(loop.rule.forBars));
    if (opts?.unit === "bar") {
      // Melody instrument: no pattern reps, so the fade length is measured in BARS, capped
      // to the phrase length. Realised as per-placement row sweeps (see melodyLanes).
      const hint = document.createElement("p");
      hint.className = "sing-hint";
      hint.textContent = "Fade each placement of this melody in and/or out — the chosen style sweeps across the fade length (in bars).";
      wrap.append(hint);
      wrap.append(this.fadeRow(loop, "intro", forBars, rerender, "bar"));
      wrap.append(this.fadeRow(loop, "outro", forBars, rerender, "bar"));
      return wrap;
    }

    // Repeat the fade on every placement (see PlacementRule.retrigger / buildLane).
    wrap.append(this.retriggerRow(loop, rerender));
    // Reps a single placement spans (pattern cycles per forBars) — the fade budget.
    const unit = loop.steps >= 1 ? loop.steps : STEPS_PER_BAR;
    const maxReps = Math.max(1, Math.floor((forBars * STEPS_PER_BAR) / unit));
    wrap.append(this.fadeRow(loop, "intro", maxReps, rerender));
    wrap.append(this.fadeRow(loop, "outro", maxReps, rerender));
    return wrap;
  }

  /** The "Repeat each placement" toggle: when on, a merged run of contiguous placements
      re-fades every placement instead of once across the whole block (see buildLane). */
  private retriggerRow(loop: Loop, rerender: () => void): HTMLElement {
    const row = document.createElement("div");
    row.className = "placement-row fade-row";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = "Repeat each";
    const controls = document.createElement("div");
    controls.className = "fade-controls";
    const toggle = document.createElement("button");
    const on = !!loop.rule.retrigger;
    toggle.className = "seg-btn fade-toggle" + (on ? " on" : "");
    toggle.textContent = on ? "On" : "Off";
    toggle.title = "Repeat the fade on every placement (e.g. re-fade each 4 bars) instead of once across a merged run";
    toggle.onclick = () => { loop.rule.retrigger = on ? undefined : true; this.recompile(); rerender(); };
    controls.append(toggle);
    const hint = document.createElement("p");
    hint.className = "sing-hint";
    hint.textContent = on
      ? "The fade repeats on every placement."
      : "The fade runs once across a merged run of placements. Turn on to re-fade each one.";
    controls.append(hint);
    row.append(lbl, controls);
    return row;
  }

  /** One fade side (intro/outro) of a loop: toggle + style + length. `unit` "bar" (melody)
      measures the length in bars instead of pattern reps. */
  private fadeRow(loop: Loop, side: "intro" | "outro", maxReps: number, rerender: () => void, unit: "rep" | "bar" = "rep"): HTMLElement {
    const row = document.createElement("div");
    row.className = "placement-row fade-row";
    const lbl = document.createElement("span");
    lbl.className = "placement-lbl";
    lbl.textContent = side === "intro" ? "Fade in" : "Fade out";

    const env = side === "intro" ? loop.intro : loop.outro;
    const other = side === "intro" ? loop.outro : loop.intro;
    const cap = Math.max(1, maxReps - (other ? other.reps : 0));

    const controls = document.createElement("div");
    controls.className = "fade-controls";

    const toggle = document.createElement("button");
    toggle.className = "seg-btn fade-toggle" + (env ? " on" : "");
    toggle.textContent = env ? "On" : "Off";
    toggle.onclick = () => {
      if (env) {
        if (side === "intro") loop.intro = undefined; else loop.outro = undefined;
      } else {
        const reps = Math.min(2, cap);
        if (side === "intro") loop.intro = { reps, mode: FADE_MODES[0], fromId: -1 };
        else loop.outro = { reps, mode: FADE_MODES[0], toId: -1 };
      }
      this.recompile();
      rerender();
    };
    controls.append(toggle);

    if (env) {
      const modes = document.createElement("div");
      modes.className = "placement-seg fade-modes";
      // Melody fades are realised as row sweeps (no per-node speed warp), so drop "speed".
      const modeList = unit === "bar" ? FADE_MODES.filter((m) => m !== "speed") : FADE_MODES;
      for (const m of modeList) {
        const b = document.createElement("button");
        b.className = "seg-btn" + (env.mode === m ? " on" : "");
        b.textContent = this.fadeModeLabel(m, side);
        b.onclick = () => {
          env.mode = m;
          // Speed carries a far-end rate + glide curve; seed sensible defaults on switch.
          if (m === "speed") { if (env.rate === undefined) env.rate = 2; if (env.curve === undefined) env.curve = 0; }
          this.recompile();
          rerender();
        };
        modes.append(b);
      }
      controls.append(modes);
      controls.append(this.numRow("Length", () => env.reps, (n) => {
        env.reps = Math.max(1, Math.min(cap, Math.round(n)));
        this.recompile();
      }, rerender, () => unit === "bar"
        ? `${env.reps} bar${env.reps === 1 ? "" : "s"}`
        : `${env.reps} rep${env.reps === 1 ? "" : "s"}`));

      if (env.mode === "speed") {
        // Speed is timing, not a swept param: the far end's hit rate (× tempo).
        controls.append(this.numRow("Rate", () => Math.round((env.rate ?? 2) * 100), (n) => {
          env.rate = Math.max(0.25, Math.min(4, Math.round(n) / 100));
          this.recompile();
        }, rerender, () => `${(env.rate ?? 2).toFixed(2)}×`));
      } else {
        // Every other style sweeps ONE parameter From → To (see TRANSITION_SWEEP). From
        // defaults to the sound's own value, To to the style's built-in extreme.
        const spec = TRANSITION_SWEEP[env.mode];
        if (spec) {
          controls.append(this.sweepRow(loop, env, "from", rerender));
          controls.append(this.sweepRow(loop, env, "to", rerender));
        }
      }

      // Curve (all styles) + its ease direction (snapshot styles only — Speed's glide is
      // oriented by the intro/outro side itself).
      controls.append(this.numRow("Curve", () => Math.round((env.curve ?? 0) * 100), (n) => {
        env.curve = Math.max(0, Math.min(1, Math.round(n) / 100));
        this.recompile();
      }, rerender, () => `${Math.round((env.curve ?? 0) * 100)}%`));
      if (env.mode !== "speed") {
        const dirSeg = document.createElement("div");
        dirSeg.className = "placement-seg fade-modes";
        const mkDir = (d: "out" | "in", text: string) => {
          const b = document.createElement("button");
          b.className = "seg-btn" + ((env.dir ?? "out") === d ? " on" : "");
          b.textContent = text;
          b.onclick = () => { env.dir = d; this.recompile(); rerender(); };
          return b;
        };
        dirSeg.append(mkDir("out", "Ease out"), mkDir("in", "Ease in"));
        controls.append(dirSeg);
      }
      controls.append(this.curveViz(loop, env, side));
    }
    row.append(lbl, controls);
    return row;
  }

  /** One From/To endpoint row for a transition's swept parameter. Percent-style params
      (range ≤ 2) scrub as a percentage; wider ranges (filter Hz) scrub in native units at
      the spec's step so the drag stays usable, and the numpad still takes exact values. */
  private sweepRow(loop: Loop, env: TransitionShape & { mode: TransitionMode }, key: "from" | "to", rerender: () => void): HTMLElement {
    const spec = TRANSITION_SWEEP[env.mode]!;
    const snap = loop.snapshot;
    const def = key === "from" ? (snap[spec.paramId] ?? 0) : spec.farDefault(snap);
    const val = () => env[key] ?? def;
    const set = (native: number) => { env[key] = Math.max(spec.min, Math.min(spec.max, native)); this.recompile(); };
    const label = key === "from" ? "From" : "To";
    const show = () => spec.format(val());
    if (spec.max <= 2) {
      return this.numRow(label, () => Math.round(val() * 100), (n) => set(n / 100), rerender, show);
    }
    return this.numRow(label, () => Math.round(val()), (n) => set(Math.round(n)), rerender, show, spec.step);
  }

  /** A little graph of a transition's blend curve: the swept value's path across the span,
      bent by Curve/dir (mirrors bendT in engine.js), labelled with its start/end values. */
  private curveViz(loop: Loop, env: TransitionShape & { mode: TransitionMode }, side: "intro" | "outro"): HTMLElement {
    const spec = TRANSITION_SWEEP[env.mode];
    // Start/end labels for the span (left = span start, right = span end). An intro rises
    // from the far end into the near sound; an outro leaves the near sound for the far end.
    let startLabel: string, endLabel: string;
    if (env.mode === "speed") {
      const rate = (env.rate ?? 2).toFixed(2) + "×";
      [startLabel, endLabel] = side === "intro" ? [rate, "1×"] : ["1×", rate];
    } else if (spec) {
      const snap = loop.snapshot;
      const from = spec.format(env.from ?? (snap[spec.paramId] ?? 0));
      const to = spec.format(env.to ?? spec.farDefault(snap));
      [startLabel, endLabel] = side === "intro" ? [to, from] : [from, to];
    } else {
      [startLabel, endLabel] = ["", ""];
    }
    return this.curveVizBox(env.curve ?? 0, env.dir ?? "out", startLabel, endLabel);
  }

  /** The blend-curve graph for a ROW SWEEP: it applies to every loop on the row (no single
      snapshot), so the ends are labelled generically — the clean "sound" vs the effect (or
      the From/To overrides when set). Left = window start, right = window end. */
  private rowSweepCurveViz(sweep: RowSweep): HTMLElement {
    const spec = TRANSITION_SWEEP[sweep.mode];
    const near = spec && sweep.from !== undefined ? spec.format(sweep.from) : "sound";
    const far = spec
      ? (sweep.to !== undefined ? spec.format(sweep.to) : this.fadeModeLabel(sweep.mode, "outro"))
      : "";
    const [startLabel, endLabel] = sweep.side === "in" ? [far, near] : [near, far];
    return this.curveVizBox(sweep.curve ?? 0, sweep.dir ?? "out", startLabel, endLabel);
  }

  /** Draw a bend curve (0 linear .. 1 exponential, eased by `dir`; mirrors bendT) into a
      little SVG box, with left/right end labels. Shared by the loop and row-sweep editors. */
  private curveVizBox(curve: number, dir: "in" | "out", startLabel: string, endLabel: string): HTMLElement {
    const W = 200, H = 56;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "curve-viz");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    let d = "";
    const N = 32;
    for (let i = 0; i <= N; i++) {
      const x = i / N;
      const y = bend(x, curve, dir);
      const px = x * W, py = H - 3 - y * (H - 6);
      d += (i === 0 ? "M" : "L") + px.toFixed(1) + " " + py.toFixed(1) + " ";
    }
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d.trim());
    path.setAttribute("class", "curve-viz-line");
    svg.append(path);
    const mkText = (x: number, anchor: string, text: string) => {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(x));
      t.setAttribute("y", String(H - 4));
      t.setAttribute("text-anchor", anchor);
      t.setAttribute("class", "curve-viz-lbl");
      t.textContent = text;
      svg.append(t);
    };
    if (startLabel) mkText(4, "start", startLabel);
    if (endLabel) mkText(W - 4, "end", endLabel);

    const box = document.createElement("div");
    box.className = "curve-viz-box";
    box.append(svg);
    return box;
  }

  /** User-facing name for a silence-fade style (a couple depend on the direction). */
  private fadeModeLabel(m: TransitionMode, side: "intro" | "outro"): string {
    switch (m) {
      case "filter": return "Filter";
      case "wash": return "Wash";
      case "thin": return side === "outro" ? "Thin out" : "Fill in";
      case "drive": return "Drive";
      case "crush": return "Crush";
      case "echo": return "Echo";
      case "speed": return side === "outro" ? "Slow" : "Rush";
      default: return "Fade";
    }
  }

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
    vals.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#4a5064");
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
    if (field === "steps") loop.steps = clampSteps(n);
    else if (field === "hits") loop.hits = Math.max(0, Math.min(MAX_STEPS, Math.round(n)));
    else if (field === "rotation") loop.rotation = Math.round(n);
    else loop.split = Math.max(1, Math.min(maxSplitGap(loop.hits, loop.steps), Math.round(n)));
    if (loop.steps >= 1 && loop.hits > loop.steps) loop.hits = loop.steps;
    this.recompile();
  }

  // --- loop sound editing (shuffle menu + sound view) -------------------
  private voiceEditorFor(loop: Loop): VoiceEditor {
    let ed = this.voiceEditors.get(loop);
    if (ed) return ed;
    const kit = new DrumKit([REF_DRUM]);
    const p = kit.get(REF_DRUM);
    p.applyPreset(FULL_RANGE_PRESET);
    if (loop.preset) kit.adoptPresetByName(REF_DRUM, loop.preset);
    if (loop.ranges) p.restoreRanges(loop.ranges.lo, loop.ranges.hi);
    if (loop.snapshot.length) p.restore(loop.snapshot);
    ed = { kit, ...defaultShuffleSettings() };
    this.voiceEditors.set(loop, ed);
    return ed;
  }

  /** Write a loop's editor state back into the loop, resend the sound table, persist. */
  private writeLoopFromEditor(loop: Loop): void {
    const ed = this.voiceEditorFor(loop);
    const p = ed.kit.get(REF_DRUM);
    if (loop.soundId < 0) {
      loop.soundId = this.nextSoundId++;
      loop.color = VOICE_COLORS[this.colorOf(loop) % VOICE_COLORS.length];
      if (loop.steps < 1) { loop.steps = 16; loop.hits = 1; loop.rotation = 0; }
    }
    loop.snapshot = p.capture();
    loop.name = p.describe().join(" · ");
    const pr = ed.kit.pitchRange(REF_DRUM);
    loop.pitch = [pr[0], pr[1]];
    loop.preset = p.presetName();
    loop.ranges = p.captureRanges();
    this.pushSounds();
    this.recompile();
    if (!this.playing) this.refreshRings();
  }

  private colorOf(loop: Loop): number {
    if (this.track.melodies.some((m) => m.inst === loop)) return MELODY_COLOR_INDEX;
    for (let c = 0; c < this.track.colors.length; c++) {
      if (this.track.colors[c].loops.includes(loop)) return c;
    }
    return this.openColor;
  }

  private auditionLoop(loop: Loop): void {
    const p = this.voiceEditorFor(loop).kit.get(REF_DRUM);
    const snap = p.capture();
    if (loop.gain && loop.gain !== 1) snap[ParamId.Volume] = (snap[ParamId.Volume] ?? 0.85) * loop.gain;
    this.engine.audition(snap, Math.round(this.engine.sampleRate * 0.4), estimateLength(snap, this.tempo));
  }

  /** Closed-loop loudness pass for a loop: render one hit offline, measure it, and store
      the makeup gain that lands it at the reference loudness (best-effort). */
  private async normalizeLoop(loop: Loop): Promise<void> {
    if (loop.soundId < 0 || !loop.snapshot.length) return;
    const token = loop.snapshot;
    const meas = loop.snapshot.slice();
    meas[ParamId.Volume] = 1;
    meas[ParamId.HitChance] = 1;
    meas[ParamId.Ratchet] = 0;
    meas[ParamId.Humanize] = 0;
    try {
      const tail = Math.min(1.6, Math.max(0.4, estimateLength(meas, this.tempo)));
      const buffer = await this.engine.renderToBuffer({
        lines: [{ nodes: [{ soundId: 0, steps: 1, lenSteps: STEPS_PER_BAR, waitSteps: 0, pattern: [1] }] }],
        sounds: [{ id: 0, snap: meas, lo: loop.pitch[0], hi: loop.pitch[1], tail: 0 }],
        tempo: this.tempo,
        maxSteps: 1,
        tailSec: tail,
      });
      if (loop.snapshot !== token) return;
      loop.gain = makeupGain(measureLoudness(buffer));
      this.pushSounds();
      this.persist();
    } catch { /* keep previous gain */ }
  }

  private async writeAndNormalizeLoop(loop: Loop): Promise<void> {
    this.writeLoopFromEditor(loop);
    await this.normalizeLoop(loop);
  }

  /** Mint an audible sound for a fresh loop by shuffling a new editor and writing it. */
  private mintLoopSound(loop: Loop): void {
    const ed = this.voiceEditorFor(loop);
    ed.kit.shuffleAll(REF_DRUM, shuffleOptions(ed, this.shuffleContext(), randomSeed()));
    this.writeLoopFromEditor(loop);
    void this.normalizeLoop(loop);
  }

  private reportLoopSound(loop: Loop, kind: ReportKind): void {
    if (loop.soundId < 0 || !loop.snapshot.length) return;
    const ed = this.voiceEditors.get(loop);
    const n = addReport(kind, {
      at: new Date().toISOString(),
      name: loop.name,
      preset: loop.preset,
      seed: ed?.lastSeed || undefined,
      tempo: this.tempo,
      gain: loop.gain,
      pitch: [loop.pitch[0], loop.pitch[1]],
      snapshot: loop.snapshot.slice(),
    });
    this.toast(kind === "high" ? `▲ Logged as too screechy (${n})` : `▼ Logged as too quiet (${n})`);
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

  /** Crossbreed partners: every OTHER loop across the track that carries a sound. */
  private breedMatesFor(loop: Loop): { name: string; color: string; snapshot: number[] }[] {
    const out: { name: string; color: string; snapshot: number[] }[] = [];
    this.track.colors.forEach((c, ci) => {
      c.loops.forEach((l, i) => {
        if (l === loop || l.soundId < 0 || !l.snapshot.length) return;
        out.push({ name: l.name || `Voice ${ci + 1} loop ${i + 1}`, color: l.color, snapshot: l.snapshot.slice() });
      });
    });
    return out;
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

  /** The custom on-screen numpad. Single-value by default (`onSubmit` gets the integer);
      pass `list: true` for a comma-separated list (a comma key appears and `onSubmitList`
      gets the raw string). A Clear (C) key wipes the buffer like a calculator. */
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
    const maxLen = list ? 60 : 3;
    let buf = "";
    const overlay = document.createElement("div");
    overlay.className = "numpad-overlay";
    const pad = document.createElement("div");
    pad.className = "numpad";
    if (opts.color) pad.style.setProperty("--vc", opts.color);

    const head = document.createElement("div");
    head.className = "numpad-head";
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

    const close = () => { document.removeEventListener("keydown", onKey, true); overlay.remove(); };
    const submit = () => {
      if (list) opts.onSubmitList?.(buf);
      else if (buf !== "") opts.onSubmit?.(parseInt(buf, 10));
      close();
    };
    const press = (d: string) => { if (buf.length < maxLen) { buf += d; refresh(); } };
    const comma = () => {
      // No leading comma, no doubling; a single ", " separator.
      if (buf === "" || buf.endsWith(",") || buf.endsWith(", ")) return;
      if (buf.length < maxLen) { buf += ", "; refresh(); }
    };
    const backspace = () => { buf = buf.replace(/, $|.$/, ""); refresh(); };
    const clear = () => { buf = ""; refresh(); };

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
    if (list) grid.append(key(",", "comma", comma), key("✓", "enter wide2", submit));
    else grid.append(key("✓", "enter wide3", submit));

    const onKey = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") press(e.key);
      else if (list && (e.key === "," || e.key === " ")) comma();
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

    const active = this.track.colors.map((_, i) => i).filter((i) => this.track.colors[i].loops.some((l) => l.soundId >= 0));
    const melodySounds = this.track.melodies.map((m) => m.inst).filter((l) => l.soundId >= 0);
    if (active.length === 0 && melodySounds.length === 0) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "No loops yet. Add loops to the colours, then mix them here.";
      v.append(hint);
      return;
    }
    const list = document.createElement("div");
    list.className = "mixer-list";
    active.forEach((c) => list.append(this.mixerStrip(c)));
    // The melody row is a strip too — its faders move every melody instrument together,
    // mute/solo via the melody colour (honoured by colorAudible / buildSounds).
    if (melodySounds.length) {
      const c = MELODY_COLOR_INDEX;
      list.append(this.buildMixStrip("Melody", VOICE_COLORS[c], this.track.colors[c], melodySounds));
    }
    v.append(list);
  }

  /** A single mixer strip for one colour (all its loops move together). */
  private mixerStrip(c: number): HTMLElement {
    const ct = this.track.colors[c];
    const sounds = ct.loops.filter((l) => l.soundId >= 0);
    return this.buildMixStrip(`Voice ${c + 1}`, VOICE_COLORS[c], ct, sounds);
  }

  /** Build a mixer strip: LED + name + mute/solo (on `ct`) + Vol/Verb/Pan faders that move
      every sound in `sounds` together. Shared by the colour strips and the melody row. */
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

  // --- sound view (full per-parameter editor for one loop, live) -------
  private renderSound(): void {
    const v = this.viewRoot;
    const loop = this.soundLoop;
    if (!loop) { this.view = "track"; this.renderTrackPanel(); return; }

    const head = document.createElement("div");
    head.className = "mixer-head";
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = this.soundReturn === "color" ? "‹ Loops" : "‹ Track";
    // Returning to "color" with an editLoop set reopens the placement popup via render().
    back.onclick = () => { this.view = this.soundReturn; this.render(); };
    const title = document.createElement("h2");
    title.className = "mixer-title";
    title.textContent = loop.name || "Loop";
    head.append(back, title);
    v.append(head);

    const editor = this.voiceEditorFor(loop);
    const sound = new SoundView(editor.kit, REF_DRUM, {
      onChange: () => this.writeLoopFromEditor(loop),
      onRangeChange: () => this.writeLoopFromEditor(loop),
      onAudition: () => this.auditionLoop(loop),
      context: () => this.shuffleContext(),
    });
    v.append(sound.el);
  }
}
