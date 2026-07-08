// App shell: owns the engine + arrangement + UI state, and switches between the
// full-screen views. The arrangement is 6 voice LINES, each a chain of NODES
// (sound + Euclidean rhythm + bars) that play in order and loop independently —
// long-form polymeter with no global pattern switch (see src/model/lines.ts).
//
//   Loop view (the landing view) — the arrangement as a paged 8-bar × 6-voice bar
//     grid (node width = length in bars) with a sweeping playhead that follows the
//     playing window, the rings above as a live visualizer of what's sounding, and
//     the loop info below; tap a node to open its editing sheet (Transitions menu,
//     value circles, shuffle).
//   Sequencer view — the rings + one row per line. A row shows its line's node
//     being edited; tap it to expand the Hits/Steps/Start/Split/Reps/Bar circles, and
//     step along the chain with the —• (next/new node) and •— (previous node)
//     buttons. Tap the title of the expanded row to open its shuffle menu.
//   Mixer — one strip per line (mute/solo/faders act on the whole chain).
//   Sound view — the deep per-parameter editor for one node.

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
  LineArrangement, VoiceNode, TransitionMode, IntroEnv, OutroEnv, emptyNode,
  nodeLen, nodeBars, waitLen, clampEnvelopes, introKind, outroKind, PAIR_MODES, FADE_MODES,
  NUM_LINES, STEPS_PER_BAR, MAX_REPS, VOICE_COLORS,
} from "../model/lines";
import { clampSteps, MAX_STEPS, evenGap, maxSplitGap, voicePattern } from "../model/euclid";
import { EuclidView, RingState } from "./euclidView";
import { SoundView, CURVE_OPTIONS, MAXLEN_OPTIONS, SNAP_OPTIONS, randomSeed } from "./soundView";
import { buildVoiceShuffleMenu, VoiceEditor } from "./voiceShuffleMenu";
import { logoLetters } from "./logo";

const PROJECT_KEY = "msq010.project";

// Every node's inline shuffle editor drives a single-drum DrumKit; the reference drum
// only picks parameter specs — Full Range opens all ranges so any character is reachable.
const REF_DRUM = DrumType.Kick;

// Loop view: the arrangement grid is this many bars wide and pages by this much.
const LOOP_PAGE_BARS = 8;

type View = "seq" | "loop" | "sound" | "mixer";

// The editable numeric fields of a node (its scrubbable number circles). "wait" is
// STORED as lead-in bars but shown/edited as the absolute start BAR (see nodeStartBar).
type NodeField = "hits" | "steps" | "rotation" | "split" | "reps" | "wait";

export class App {
  private engine = new EngineHost();
  private arr = new LineArrangement();
  private kit = new DrumKit(DRUMS.map((d) => d.type)); // background editor kit (serialised)
  private drumTypes = DRUMS.map((d) => d.type);
  private saveTimer = 0;

  private view: View = "loop"; // the loop (bar-grid) view is the landing view
  private soundLine = 0;      // which line the full-parameters (sound) view is editing
  private selectedDrum: DrumType = DrumType.Kick; // background kit slot (see applyRandomDefault)
  private soundName = "";     // last used sound name (prefills the Save dialog)
  private playing = false;
  private tempo = 120;

  // Per-line editing state: which node of each chain the sequencer row shows, and
  // which row is expanded (accordion — one at a time; -1 = all collapsed).
  private editNode: number[] = new Array(NUM_LINES).fill(0);
  private expanded = -1;
  private nextSoundId = 0; // monotonic id for assigned node sounds
  private loopPage = 0;             // loop view: which 8-bar window (page) is on screen
  private loopZoomOut = false;      // loop view: one page showing the whole loop
  private playPageOnly = false;     // loop view: loop just the 8 bars on screen, not the whole track
  private sheetLine = -1;           // loop view: voice whose editing sheet is open (-1 = none)
  private gridDragBusy = false;     // a grid press-drag (add/resize/move) is live — hold page-follow
  private voiceClip: VoiceNode | null = null; // clipboard: a voice copied via its hold menu, to paste
  private soundReturn: View = "seq"; // where the deep sound view's Back button returns to
  private mixerReturn: View = "seq"; // where the mixer's Back button returns to

  // Per-node inline shuffle editors, keyed by `${line}:${nodeIndex}`. Lazily created
  // when a node's shuffle menu first opens; cleared on new/load/node-removal
  // (rebuilt from the node's saved snapshot/ranges/preset).
  private voiceEditors = new Map<string, VoiceEditor>();

  private root: HTMLElement;
  private viewRoot!: HTMLElement;
  private euclidView = new EuclidView();
  private loopTimeEl: HTMLElement | null = null;
  // Loop view: per line, per node, the block elements (one per rendered band — the
  // zoomed-out view stacks two bands) for the playing-node highlight.
  private nodeDotEls: HTMLElement[][][] | null = null;
  // Loop view: the bar-grid band elements (each carries its own --ph playhead var; one
  // band normally, two when zoomed out) and the last window the playhead was in.
  private barGridEls: HTMLElement[] = [];
  private phPage = -1;
  // Channel -> flash LED, populated while the Mixer view is shown.
  private mixerLeds: Map<number, HTMLElement> | null = null;
  // Sound id -> voice title button, for the colour flash when its node fires.
  private voiceBtns: Map<number, HTMLElement> | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.engine.onPlayhead = (p) => this.handlePlayhead(p);
    // Resume audio after iOS/tab interruptions.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.engine.resume();
    });
    this.renderStart();
  }

  /** The node a line's sequencer row is currently editing. */
  private node(li: number): VoiceNode {
    const nodes = this.arr.lines[li].nodes;
    const k = Math.min(this.editNode[li], nodes.length - 1);
    this.editNode[li] = k;
    return nodes[k];
  }

  /** Bars occupied by the chain BEFORE line `li`'s edited node (may be fractional). */
  private barsBefore(li: number): number {
    const nodes = this.arr.lines[li].nodes;
    const k = Math.min(this.editNode[li], nodes.length - 1);
    let b = 0;
    for (let i = 0; i < k; i++) b += nodeBars(nodes[i]);
    return b;
  }

  /** The 1-indexed bar the edited node's SOUND starts on: the bars before it in the
      chain plus its own lead-in wait. This is what the "Bar" circle shows/edits — the
      wait is derived from it, so a voice can enter anywhere, not just at bar 1. */
  private nodeStartBar(li: number): number {
    return this.barsBefore(li) + Math.max(0, this.node(li).wait ?? 0) + 1;
  }

  /** A sounding (non-rest) node — the kind a transition can blend. */
  private isSounding(n: VoiceNode | undefined): boolean {
    return !!n && n.soundId >= 0;
  }

  /** Bars per loop-view page: 8 normally; zoomed out, the whole loop in ONE page
      (rounded up to 8s, plus a spare 8 bars to arrange into). */
  private pageBars(): number {
    if (!this.loopZoomOut) return LOOP_PAGE_BARS;
    const loopBars = this.arr.loopSteps() / STEPS_PER_BAR;
    return Math.max(2 * LOOP_PAGE_BARS, (Math.ceil(loopBars / LOOP_PAGE_BARS) + 1) * LOOP_PAGE_BARS);
  }

  // --- playhead ----------------------------------------------------------
  private handlePlayhead(p: Playhead): void {
    if (!p.lines) {
      this.refreshRings(); // stopped: rings back to the edited nodes
      if (this.nodeDotEls) this.nodeDotEls.forEach((line) => line.forEach((blocks) => blocks.forEach((el) => el.classList.remove("playing"))));
      this.phPage = -1;
      this.barGridEls.forEach((g) => g.classList.remove("ph-live")); // hide the bar-grid playhead
      return;
    }
    // Rings show ONLY what's audibly playing: a line's live node while its pattern
    // sounds. A resting line (past its chain), a lead-in wait (step -1), and a
    // muted / soloed-out line all leave just the empty guide ring.
    const states: RingState[] = this.arr.lines.map((ln, i) => {
      const st = p.lines![i];
      if (st && st.node >= 0 && st.step >= 0 && this.lineAudible(i)) {
        return { node: ln.nodes[st.node] ?? null, step: st.step };
      }
      return { node: null, step: -1 };
    });
    this.euclidView.setRings(states);
    this.euclidView.pulse(p.fired);
    // Loop view: highlight each line's playing node, sweep the bar-grid playhead, and
    // follow the playing 8-bar window.
    if (this.nodeDotEls) {
      this.nodeDotEls.forEach((line, li) => {
        const st = p.lines![li];
        line.forEach((blocks, k) => blocks.forEach((el) => el.classList.toggle("playing", !!st && st.node === k)));
      });
    }
    if (this.view === "loop") this.updateLoopPlayhead(p.pos);
    if (this.mixerLeds) {
      for (const ch of p.fired) {
        const led = this.mixerLeds.get(ch);
        if (!led) continue;
        led.classList.remove("flash");
        void led.offsetWidth; // restart the fade animation on a repeat trigger
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

  /** Loop view, while playing: sweep the playhead line across the bar grid (a CSS var
      every track's ::after reads) and FOLLOW the music — when playback crosses into a
      new 8-bar window, page the grid to it, so the view always shows the bars being
      played. Following holds off while the user is mid-edit (voice sheet, numpad or
      transition dialog open, or a loop-view mode armed) so the page isn't yanked away;
      the line simply hides while the playhead is off-screen and the next boundary
      crossing re-syncs. `pos` is the global loop position in 16th steps. */
  private updateLoopPlayhead(pos: number): void {
    const bpp = this.pageBars();
    const bar = pos / STEPS_PER_BAR;
    const page = Math.floor(bar / bpp);
    if (page !== this.phPage) {
      this.phPage = page;
      const busy = this.sheetLine >= 0 || this.gridDragBusy
        || !!document.querySelector(".numpad-overlay, .tr-overlay");
      if (!busy && page !== this.loopPage) {
        this.loopPage = page;
        this.render(); // rebuilds the grid bands on the new page
      }
    }
    // Light the band the playhead is in and hide the line on the other: one band spans
    // the whole window normally; zoomed out, two stacked bands split the loop in half.
    const bands = this.barGridEls;
    if (bands.length === 0) return;
    const bandBars = this.loopZoomOut ? bpp / 2 : bpp;
    const base = this.loopZoomOut ? 0 : this.loopPage * bpp;
    bands.forEach((g, b) => {
      const rel = (bar - (base + b * bandBars)) / bandBars; // 0..1 across this band
      const visible = rel >= 0 && rel < 1;
      g.classList.toggle("ph-live", visible);
      if (visible) g.style.setProperty("--ph", `${(rel * 100).toFixed(3)}%`);
    });
  }

  /** Point the rings at each line's EDITED node (the stopped/editing display). */
  private refreshRings(): void {
    const states: RingState[] = this.arr.lines.map((_, i) => ({ node: this.node(i), step: -1 }));
    this.euclidView.setRings(states);
  }

  // --- engine sync ------------------------------------------------------
  private pushAll(): void {
    this.pushSounds();
    this.syncLines();
    this.engine.setTempo(this.tempo);
  }

  /** The engine sound table: every assigned node across every line, as a stable id +
      snapshot + Pitch range + estimated tail (for channel stealing). Nodes on muted /
      soloed-out LINES get Volume zeroed (mute/solo act per line); a node's measured
      loudness makeup rides on Volume here (the snapshot itself keeps the mixer's
      value — see normalizeVoice). */
  private buildSounds(): EngineSound[] {
    const sounds: EngineSound[] = [];
    this.arr.lines.forEach((ln, li) => {
      const audible = this.lineAudible(li);
      for (const n of ln.nodes) {
        // Rests have no sound to push; a sounding node ships its snapshot even when it
        // carries intro/outro fades (the engine morphs against it in place).
        if (n.soundId < 0) continue;
        const snap = n.snapshot.slice();
        if (!audible) snap[ParamId.Volume] = 0;
        else if (n.gain && n.gain !== 1) snap[ParamId.Volume] = (snap[ParamId.Volume] ?? 0.85) * n.gain;
        sounds.push({ id: n.soundId, snap, lo: n.pitch[0], hi: n.pitch[1], tail: estimateLength(snap, this.tempo) });
      }
    });
    return sounds;
  }

  /** Push the sound table to the (live) engine. The engine binds ids to channels. */
  private pushSounds(): void {
    this.engine.setSounds(this.buildSounds());
  }

  /** True while at least one line is soloed (so the rest are silenced). */
  private anySolo(): boolean {
    return this.arr.lines.some((l) => l.solo);
  }

  /** A line is heard unless it's muted or another line has stolen solo. */
  private lineAudible(li: number): boolean {
    const l = this.arr.lines[li];
    return !l.mute && (!this.anySolo() || !!l.solo);
  }

  /** Resend the lines. While playing the engine stages this and applies it at the
      next bar boundary, so the current bar plays unchanged. */
  private syncLines(restart = false): void {
    this.engine.setLines(this.arr.linesMessage(), restart);
    this.updateLoopTime();
    this.persist();
  }

  private updateLoopTime(): void {
    if (!this.loopTimeEl) return;
    const steps = this.arr.loopSteps();
    const sec = (steps * 60) / Math.max(1, this.tempo) / 4; // 16th notes
    // Compact for the top-left button: seconds only (one decimal under 10s).
    this.loopTimeEl.textContent = steps > 0 ? `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s` : "—";
  }

  // --- persistence ------------------------------------------------------
  private persist(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        const json = serialize(this.arr, this.kit, this.tempo, this.drumTypes, this.soundName);
        localStorage.setItem(PROJECT_KEY, JSON.stringify(json));
      } catch {
        /* ignore quota errors */
      }
    }, 300);
  }

  private loadFromStorage(): boolean {
    try {
      const raw = localStorage.getItem(PROJECT_KEY);
      if (!raw) return false;
      const json = JSON.parse(raw) as ProjectJSON;
      this.tempo = deserialize(json, this.arr, this.kit, this.drumTypes);
      this.soundName = json.soundName ?? this.soundName;
      this.resetIds();
      return true;
    } catch {
      return false; // ignore corrupt storage
    }
  }

  private saveToFile(): void {
    const json = serialize(this.arr, this.kit, this.tempo, this.drumTypes, this.soundName);
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "msq010-project.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Ask how many loop passes to render, then export (offline) to a downloadable WAV. */
  private promptExportWav(): void {
    const answer = prompt("Export the loop as a WAV — how many times should it repeat?", "1");
    if (answer === null) return;
    const loops = Math.max(1, Math.floor(Number(answer)) || 1);
    this.exportWav(loops).catch((e) => {
      console.error(e);
      alert("Sorry — the export failed.");
    });
  }

  /** Render `loops` passes of the full loop (the point where every line realigns) to
      a WAV and download it. Renders offline (faster than realtime) and appends a tail
      sized to the longest sound so reverb/echo rings out cleanly. */
  private async exportWav(loops: number): Promise<void> {
    const loopLen = this.arr.loopSteps();
    if (loopLen <= 0) { alert("Nothing to export yet — give some voices a sound first."); return; }
    const sounds = this.buildSounds();
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
        this.tempo = deserialize(json, this.arr, this.kit, this.drumTypes);
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
    this.arr = new LineArrangement();
    this.kit = new DrumKit(this.drumTypes);
    this.applyRandomDefault(); // default editor sound: random Full Range
    this.tempo = 120;
    this.voiceEditors.clear();
    this.nextSoundId = 0;
    this.editNode.fill(0);
    this.expanded = -1;
    this.afterProjectChange();
  }

  /** After load/new: bump the id counter past every loaded sound id so new sounds
      never collide, and pull the per-line edit cursors back into range. */
  private resetIds(): void {
    this.voiceEditors.clear(); // rebuilt lazily from each node's saved snapshot/ranges
    let maxId = -1;
    for (const ln of this.arr.lines) {
      for (const n of ln.nodes) if (n.soundId > maxId) maxId = n.soundId;
    }
    this.nextSoundId = maxId + 1;
    this.editNode.fill(0);
    this.expanded = -1;
  }

  private afterProjectChange(): void {
    if (this.playing) { this.playing = false; this.engine.stop(); }
    this.pushAll();
    this.render();
  }

  /** Seed the (background) editor kit with a fresh random Full Range sound. Kept so
      new/loaded projects still serialise a valid drum kit + preset. */
  private applyRandomDefault(): void {
    this.kit.applyPreset(this.selectedDrum, FULL_RANGE_PRESET);
    this.kit.shuffleAll(this.selectedDrum, { randomness: 1.0 }); // uniform over the full range
    this.soundName = "";
  }

  // --- start gate -------------------------------------------------------
  private renderStart(): void {
    this.root.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "start-screen";
    // The logo bounces in letter by letter, each drawn from the sequencer's own
    // dots-and-lines in its voice colour — six letters, six voices, one language.
    const h = document.createElement("h1");
    h.className = "logo";
    h.append(...logoLetters(46, true));
    const btn = document.createElement("button");
    btn.id = "start";
    btn.textContent = "▶ Start";
    btn.onclick = async () => {
      await this.engine.start();
      // Fresh session (no saved project): start on a random Full Range sound.
      if (!this.loadFromStorage()) this.applyRandomDefault();
      this.pushAll();
      this.render();
    };
    wrap.append(h, btn);
    this.root.append(wrap);
  }

  // --- main render ------------------------------------------------------
  private render(): void {
    this.root.innerHTML = "";
    this.loopTimeEl = null;
    this.nodeDotEls = null;
    this.barGridEls = [];
    this.mixerLeds = null;
    this.voiceBtns = null;

    const bar = document.createElement("header");
    bar.className = "topbar";
    bar.append(this.topLeftControl(), this.transport(), this.menu());
    this.root.append(bar);

    this.viewRoot = document.createElement("main");
    this.viewRoot.className = "viewroot";
    this.root.append(this.viewRoot);

    if (this.view === "seq") this.renderSeq();
    else if (this.view === "loop") this.renderLoop();
    else if (this.view === "mixer") this.renderMixer();
    else this.renderSound();

    // Loop view: a tapped voice's editing sheet floats above the grid (in front of
    // everything, appended to the root — not the view — so the topbar is covered too).
    if (this.view === "loop" && this.sheetLine >= 0) this.renderVoiceSheet();

    // Keep the section loop in step with what's on screen (the edit target).
    this.syncSection();
  }

  /** The node currently being edited (its shuffle menu / values are the focus): the
      expanded sequencer row, or the node the deep sound editor is on. null otherwise. */
  private currentEditTarget(): { line: number; node: number } | null {
    if (this.view === "sound") return { line: this.soundLine, node: this.editNode[this.soundLine] };
    if (this.view === "seq" && this.expanded >= 0) return { line: this.expanded, node: this.editNode[this.expanded] };
    if (this.view === "loop" && this.sheetLine >= 0) return { line: this.sheetLine, node: this.editNode[this.sheetLine] };
    return null;
  }

  /** While playing with an edit target, loop just that node's window of the loop so
      the edit is auditioned in context; otherwise play the whole loop. The loop view's
      "these 8 bars" toggle takes precedence — it loops just the visible page. */
  private syncSection(): void {
    if (this.view === "loop" && this.playPageOnly && this.playing) {
      const bpp = this.pageBars();
      this.engine.setSection(this.loopPage * bpp * STEPS_PER_BAR, bpp * STEPS_PER_BAR);
      return;
    }
    const t = this.currentEditTarget();
    if (!this.playing || !t) { this.engine.setSection(0, 0); return; }
    const nodes = this.arr.lines[t.line].nodes;
    let start = 0;
    for (let k = 0; k < t.node && k < nodes.length; k++) start += nodeLen(nodes[k]);
    const len = t.node < nodes.length ? nodeLen(nodes[t.node]) : 0;
    this.engine.setSection(start, len);
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
    // Feedback logs (swipe the shuffle recap row): export each as its own JSON
    // file, or clear both once handed over. Labels carry the live counts.
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
      expHigh,
      expLow,
      clearLogs,
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
    // While playing the button turns accent and pulses once per beat (see .playing
    // in style.css; --beat is the beat length so the pulse tracks the tempo).
    const syncPlay = () => {
      play.textContent = this.playing ? "■" : "▶";
      play.classList.toggle("playing", this.playing);
      play.style.setProperty("--beat", `${(60 / this.tempo).toFixed(4)}s`);
    };
    syncPlay();
    play.onclick = async () => {
      if (!this.playing) {
        // Coming back from the background (iOS home-screen app) can leave the audio
        // context suspended or dead — re-arm it from THIS tap. A rebuilt engine is
        // blank, so push the sounds/lines/tempo back in before playing.
        try {
          if (await this.engine.ensureRunning()) this.pushAll();
        } catch {
          this.toast("Audio couldn't restart — try again");
          return;
        }
        this.playing = true;
        this.engine.play();
        this.syncSection();
      } else {
        this.playing = false;
        this.engine.stop();
        this.refreshRings();
      }
      syncPlay();
    };

    const tempo = document.createElement("input");
    tempo.type = "range";
    tempo.min = "60";
    tempo.max = "200";
    tempo.value = String(this.tempo);
    tempo.className = "tempo";
    // Editable BPM: type a value or drag the slider; the two stay in sync. The box allows
    // a wider range than the slider (which clamps its own thumb to 60–200).
    const label = document.createElement("input");
    label.type = "number";
    label.className = "tempo-label";
    label.min = "20";
    label.max = "300";
    label.step = "1";
    label.value = String(this.tempo);
    const applyTempo = (bpm: number) => {
      bpm = Math.round(bpm);
      if (Number.isNaN(bpm)) bpm = this.tempo;
      bpm = Math.max(20, Math.min(300, bpm));
      this.tempo = bpm;
      this.engine.setTempo(this.tempo);
      tempo.value = String(Math.max(60, Math.min(200, bpm))); // slider thumb range
      label.value = String(bpm);
      this.updateLoopTime();
      this.persist();
    };
    tempo.oninput = () => applyTempo(Number(tempo.value));
    label.onfocus = () => label.select();
    label.onchange = () => applyTempo(Number(label.value));

    t.append(play, tempo, label);
    return t;
  }

  /** The line-with-three-dots glyph (the node chain / whole loop), drawn in currentColor
      so CSS colours it. Shared by the loop opener and the loop-scope toggle. */
  private chainIcon(): SVGSVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 10");
    svg.setAttribute("width", "22");
    svg.setAttribute("height", "10");
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", "2"); line.setAttribute("x2", "22");
    line.setAttribute("y1", "5"); line.setAttribute("y2", "5");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "2"); line.setAttribute("stroke-linecap", "round");
    svg.append(line);
    for (const cx of [5, 12, 19]) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", String(cx)); c.setAttribute("cy", "5"); c.setAttribute("r", "2.6");
      c.setAttribute("fill", "currentColor");
      svg.append(c);
    }
    return svg;
  }

  /** Top-left control: on the loop homepage it's the whole-loop / page scope toggle; on
      the other views it's the button that opens the loop view. */
  private topLeftControl(): HTMLElement {
    return this.view === "loop" ? this.scopeToggle() : this.loopButton();
  }

  /** Opens the Loop view (shown top-left on every view except the loop view itself). */
  private loopButton(): HTMLElement {
    const b = document.createElement("button");
    b.className = "loop-view-btn";
    b.title = "Loop — the node chains";
    b.setAttribute("aria-label", "Loop");
    b.append(this.chainIcon());
    b.onclick = () => { this.view = "loop"; this.render(); };
    return b;
  }

  /** Loop view, top-left: shows the loop length in seconds and toggles whether playback
      loops the WHOLE track or just the bars on screen. Lit ("on") = the whole loop; tap
      to constrain it to the page (goes green). */
  private scopeToggle(): HTMLElement {
    const n = this.pageBars();
    const b = document.createElement("button");
    b.className = "loop-view-btn scope-toggle loop-time-btn" + (this.playPageOnly ? "" : " on");
    b.title = this.playPageOnly
      ? `Looping these ${n} bars — tap to loop the whole track`
      : `Looping the whole track — tap to loop just these ${n} bars`;
    b.setAttribute("aria-label", "Loop length / scope");
    this.loopTimeEl = document.createElement("span");
    this.loopTimeEl.className = "loop-time-btn-val";
    b.append(this.loopTimeEl);
    b.onclick = () => { this.playPageOnly = !this.playPageOnly; this.render(); };
    return b;
  }

  /** The 🎚 Mixer opener, placed at the top-right of a rings visualiser. `from` is the
      view its Back button should return to (so it comes back to wherever it was opened). */
  private mixerOpenBtn(from: View): HTMLElement {
    const mix = document.createElement("button");
    mix.className = "mixer-open-btn";
    mix.textContent = "🎚";
    mix.title = "Mixer";
    mix.setAttribute("aria-label", "Mixer");
    mix.onclick = () => { this.mixerReturn = from; this.view = "mixer"; this.render(); };
    return mix;
  }

  // --- sequencer view ----------------------------------------------------
  private renderSeq(): void {
    const v = this.viewRoot;

    const wrap = document.createElement("div");
    wrap.className = "euclid-wrap";
    // Mixer button at the top-right of the steps visualiser.
    wrap.append(this.mixerOpenBtn("seq"), this.euclidView.canvas);
    v.append(wrap);
    v.append(this.linesMenu());
    if (!this.playing) this.refreshRings();
    // viewRoot is already in the DOM, so size synchronously (reads real width),
    // and again on the next frame as a fallback for first-paint width.
    this.euclidView.layout();
    requestAnimationFrame(() => this.euclidView.layout());
  }

  /** A tiny dot-and-line SVG for the node navigation buttons: `dotAtEnd` gives
      "—•" (next/new node); otherwise "•—" (previous node). Drawn in currentColor
      so CSS colours it per row. */
  private nodeNavIcon(dotAtEnd: boolean): SVGSVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 22 10");
    svg.setAttribute("width", "22");
    svg.setAttribute("height", "10");
    const line = document.createElementNS(NS, "line");
    line.setAttribute("y1", "5");
    line.setAttribute("y2", "5");
    line.setAttribute("x1", dotAtEnd ? "1" : "8");
    line.setAttribute("x2", dotAtEnd ? "14" : "21");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-linecap", "round");
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", dotAtEnd ? "17.5" : "4.5");
    dot.setAttribute("cy", "5");
    dot.setAttribute("r", "4");
    dot.setAttribute("fill", "currentColor");
    svg.append(line, dot);
    return svg;
  }

  /** The Hits/Steps/Start/Split/Reps/Bar circles for line `li`'s edited node, drawn as
      voice-coloured dots on a connecting line. Each taps to the numpad or click-drags to
      scrub. Shared by the sequencer's expanded row and the loop-view voice sheet. */
  private nodeValueCircles(li: number): HTMLElement {
    const node = this.node(li);
    const mkNum = (label: string, value: number, field: NodeField, disabled = false) => {
      const cell = document.createElement("div");
      cell.className = "euclid-num";
      const lab = document.createElement("span");
      lab.textContent = label;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = String(value);
      inp.readOnly = true;        // custom numpad handles entry (no native keyboard)
      inp.inputMode = "none";
      inp.disabled = disabled;
      if (!disabled) {
        // A plain tap opens the numpad (see attachDragScrub); click-hold + drag scrubs.
        this.attachDragScrub(inp, li, field, label);
      }
      cell.append(lab, inp);
      return cell;
    };

    const hits = mkNum("Hits", node.hits, "hits");
    const steps = mkNum("Steps", node.steps, "steps");
    const start = mkNum("Start", node.rotation, "rotation");
    // Split: the primary gap between hits (even spread by default). Disabled unless
    // there are 2+ hits AND room to vary the gap.
    const splitLocked = node.hits < 2 || maxSplitGap(node.hits, node.steps) <= 1;
    const split = mkNum("Split", node.split ?? evenGap(node.hits, node.steps), "split", splitLocked);
    split.title = `Hit split: ${this.splitLabel(node.hits, node.steps, node.rotation, node.split)}`;
    // Reps: how many times the pattern repeats before the next node takes over
    // (length = reps × steps). The loop view shows the resulting length in bars.
    const reps = mkNum("Reps", node.reps, "reps");
    // Bar: the bar this node's sound STARTS on. Setting it later than the earliest
    // possible bar becomes quiet lead-in (the stored wait), so a voice doesn't have
    // to enter on bar 1.
    const bar = mkNum("Bar", +this.nodeStartBar(li).toFixed(2), "wait");
    bar.title = "The bar this sound starts on — set it later to delay the entry";

    const vals = document.createElement("div");
    vals.className = "euclid-vals";
    vals.style.setProperty("--vc", node.soundId >= 0 ? node.color : "#4a4e58");
    vals.append(hits, steps, start, split, reps, bar);
    return vals;
  }

  /** The 6-line menu: one row per voice line showing its edited node. Collapsed rows
      are just the title + node navigation; tapping a row expands its value circles
      (accordion). Tapping the title of the EXPANDED row opens the shuffle menu. */
  private linesMenu(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "euclid-menu";
    this.voiceBtns = new Map();

    for (let i = 0; i < NUM_LINES; i++) {
      const nodes = this.arr.lines[i].nodes;
      const node = this.node(i);
      const isOpen = this.expanded === i;
      const r = document.createElement("div");
      r.className = "euclid-row" + (isOpen ? " open" : "");

      // Title: the node's sound (voice-coloured pill) or a wiggling die inviting a first
      // shuffle. Tap = expand the row; tap again (expanded, sounding node) = shuffle menu.
      const k = this.editNode[i];
      const sound = document.createElement("button");
      if (node.soundId >= 0) {
        sound.className = "euclid-sound has-sound";
        sound.style.background = node.color;
        sound.style.borderColor = node.color;
        sound.style.color = "#15161a"; // dark text for contrast on the light voice hues
        sound.style.setProperty("--vc", node.color); // hit-flash glow colour
        sound.textContent = node.name || `Voice ${i + 1}`;
        this.voiceBtns.set(node.soundId, sound);
      } else {
        sound.className = "euclid-sound";
        const dice = document.createElement("span");
        dice.className = "dice";
        dice.textContent = "🎲";
        sound.append(dice, ` Voice ${i + 1}`);
      }
      // Node position within the chain, when the chain has grown.
      if (nodes.length > 1) {
        const pos = document.createElement("span");
        pos.className = "node-pos";
        pos.textContent = `${k + 1}/${nodes.length}`;
        sound.append(pos);
      }
      sound.onclick = () => {
        if (this.expanded !== i) { this.expanded = i; this.render(); }
        else this.openVoiceShuffleMenu(sound, i);
      };

      // Previous-node button on the LEFT of the voice — •— steps back through the
      // chain. An empty slot keeps rows aligned when there's no earlier node.
      const left = document.createElement("div");
      left.className = "node-nav";
      left.style.setProperty("--vc", node.soundId >= 0 ? node.color : "#9aa0aa");
      if (this.editNode[i] > 0) {
        const prev = document.createElement("button");
        prev.className = "node-nav-btn";
        prev.title = "Previous node";
        prev.append(this.nodeNavIcon(false));
        prev.onclick = () => { this.editNode[i]--; this.expanded = i; this.render(); };
        left.append(prev);
      }
      r.append(left, sound);

      if (isOpen) {
        // The hits/steps/start/split/reps/wait circles (shared with the loop-view sheet).
        const vals = this.nodeValueCircles(i);

        // ×: remove this node from the chain (or clear the sound when it's the only one).
        const rm = document.createElement("button");
        rm.className = "euclid-remove";
        rm.textContent = "×";
        rm.title = nodes.length > 1 ? "Remove this node" : "Clear this voice's sound";
        rm.onclick = () => this.removeNode(i);

        // The expanded detail wraps onto its own row under the title + nav.
        const detail = document.createElement("div");
        detail.className = "euclid-detail";
        detail.append(vals, rm);
        r.append(detail);

        // A sound carrying intro/outro fades gets a style toggle per envelope so the
        // blend can be changed after it's created.
        if (node.intro) r.append(this.envModeToggle(node, "intro", true));
        if (node.outro) r.append(this.envModeToggle(node, "outro", true));
      }

      // Next-node button on the RIGHT of the voice — —• steps forward, or grows the
      // chain with a new node when already at the end.
      const right = document.createElement("div");
      right.className = "node-nav";
      right.style.setProperty("--vc", node.soundId >= 0 ? node.color : "#9aa0aa");
      const next = document.createElement("button");
      next.className = "node-nav-btn";
      next.title = this.editNode[i] < nodes.length - 1 ? "Next node" : "New node";
      next.append(this.nodeNavIcon(true));
      next.onclick = () => {
        if (this.editNode[i] < nodes.length - 1) {
          this.editNode[i]++;
        } else {
          nodes.push(emptyNode());
          this.editNode[i] = nodes.length - 1;
          this.syncLines(); // the line's chain just grew
        }
        this.expanded = i;
        this.render();
      };
      right.append(next);
      r.append(right);

      wrap.append(r);
    }
    return wrap;
  }

  /** Apply a typed hits/steps/start/split/reps value: update the node, then re-render
      so the inputs show the clamped result. */
  private setNodeNum(li: number, field: NodeField, n: number): void {
    this.applyNodeNum(li, field, n);
    this.render(); // reflect clamped values in the inputs
  }

  /** Core node number update (clamped) + resync + redraw, with NO full render — so
      drag-scrub can update live without tearing down the input mid-drag. The section
      loop is resynced too (steps/reps change the edited node's window). */
  private applyNodeNum(li: number, field: NodeField, n: number): void {
    const v = this.node(li);
    if (Number.isNaN(n)) n = 0;
    if (field === "steps") v.steps = clampSteps(n);
    else if (field === "hits") v.hits = Math.max(0, Math.min(MAX_STEPS, Math.round(n)));
    else if (field === "rotation") v.rotation = Math.round(n);
    else if (field === "reps") v.reps = Math.max(1, Math.min(MAX_REPS, Math.round(n)));
    else if (field === "wait") {
      // The "Bar" circle: n is the 1-indexed bar the sound should start on; whatever
      // lies between the previous node's end and that bar becomes lead-in wait. Clamped
      // to the earliest possible bar (right after the previous node) and MAX_REPS bars.
      const w = Math.round(n - 1 - this.barsBefore(li));
      v.wait = w > 0 ? Math.min(MAX_REPS, w) : undefined;
    }
    else v.split = Math.max(1, Math.min(maxSplitGap(v.hits, v.steps), Math.round(n))); // primary gap
    // Cap hits at steps only once steps is set (a blank node defaults to 0 steps and
    // shouldn't swallow a hits value the user types first).
    if (v.steps >= 1 && v.hits > v.steps) v.hits = v.steps;
    clampEnvelopes(v); // a shorter loop can't hold a longer fade
    this.syncLines();
    this.syncSection(); // the edited node's window may have changed length
    if (!this.playing) this.refreshRings();
    this.updateLoopTime();
  }

  /** Human-readable gap composition of the node's actual pattern, e.g. "6·6·4" — the
      spacing between consecutive hits (wrapping the last gap back to the first hit). */
  private splitLabel(hits: number, steps: number, rotation: number, split?: number): string {
    const pat = voicePattern(hits, steps, rotation, split);
    const idx: number[] = [];
    for (let i = 0; i < pat.length; i++) if (pat[i]) idx.push(i);
    if (idx.length < 2) return "even spread";
    const gaps = idx.map((at, j) => {
      const next = idx[(j + 1) % idx.length];
      const g = next - at;
      return g > 0 ? g : g + pat.length; // wrap the final gap
    });
    return gaps.join("·");
  }

  /** Make a number input scrub: click-hold and drag up to increase, down to decrease.
      A plain tap (no drag) opens the custom numpad for the field. */
  private attachDragScrub(input: HTMLInputElement, li: number, field: NodeField, label: string): void {
    const PX_PER_STEP = 7; // vertical pixels per ±1
    let startY = 0, startVal = 0, dragging = false, moved = false;

    input.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      startY = e.clientY;
      startVal = Number(input.value) || 0;
      dragging = true;
      moved = false;
      input.setPointerCapture(e.pointerId);
    });
    input.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const delta = Math.round((startY - e.clientY) / PX_PER_STEP);
      if (delta === 0 && !moved) return;
      if (!moved) { moved = true; input.blur(); } // it's a drag, not a tap — don't type
      e.preventDefault();
      this.applyNodeNum(li, field, startVal + delta);
      const v = this.node(li);
      const shown = field === "steps" ? v.steps : field === "hits" ? v.hits
        : field === "rotation" ? v.rotation : field === "reps" ? v.reps
        : field === "wait" ? +this.nodeStartBar(li).toFixed(2) // the Bar circle shows the start bar
        : (v.split ?? evenGap(v.hits, v.steps));
      input.value = String(shown);
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { input.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (moved) { this.render(); return; } // a drag: rebuild so rows reflect clamped values
      // A plain tap: open the numpad, seeded with this field's value + voice colour.
      const node = this.node(li);
      this.openNumpad({
        title: label,
        value: startVal,
        color: node.soundId >= 0 ? node.color : undefined,
        onSubmit: (n) => this.setNodeNum(li, field, n),
      });
    };
    input.addEventListener("pointerup", end);
    input.addEventListener("pointercancel", end);
  }

  /** A custom on-screen number pad shown as a fixed overlay — the page behind does NOT
      move (unlike a focused native input). Opens blank (the old value is only a hint);
      ✓ or Enter submits the typed number, ⌫/Backspace deletes, and Esc or a tap outside
      cancels (leaving the value unchanged). Integers only, up to 3 digits. */
  private openNumpad(opts: { title: string; value: number; color?: string; onSubmit: (n: number) => void }): void {
    document.querySelector(".numpad-overlay")?.remove(); // only one at a time
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

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
    display.className = "numpad-display";
    const refresh = () => {
      display.textContent = buf === "" ? String(opts.value) : buf;
      display.classList.toggle("empty", buf === "");
    };
    refresh();

    const close = () => { document.removeEventListener("keydown", onKey, true); overlay.remove(); };
    const submit = () => { if (buf !== "") opts.onSubmit(parseInt(buf, 10)); close(); };
    const press = (d: string) => { if (buf.length < 3) { buf += d; refresh(); } };
    const backspace = () => { buf = buf.slice(0, -1); refresh(); };

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
    grid.append(key("⌫", "back", backspace), key("0", "", () => press("0")), key("✓", "enter", submit));

    const onKey = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") press(e.key);
      else if (e.key === "Backspace") backspace();
      else if (e.key === "Enter") submit();
      else if (e.key === "Escape") close();
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey, true);
    overlay.onclick = (e) => { if (e.target === overlay) close(); }; // tap outside = cancel

    pad.append(head, display, grid);
    overlay.append(pad);
    this.root.append(overlay);
  }

  // --- node sound editing (shuffle menu + sound view) ---------------------
  /** The live editor for one line's edited node, created lazily. Rebuilt from the
      node's saved snapshot/ranges/preset so a reloaded project keeps shuffling from
      where it left. */
  private voiceEditorFor(li: number): VoiceEditor {
    const key = `${li}:${this.editNode[li]}`;
    let ed = this.voiceEditors.get(key);
    if (ed) return ed;
    const kit = new DrumKit([REF_DRUM]);
    const p = kit.get(REF_DRUM);
    p.applyPreset(FULL_RANGE_PRESET); // default window (no undo entry)
    const v = this.node(li);
    if (v.preset) kit.adoptPresetByName(REF_DRUM, v.preset); // Reset target after reload
    if (v.ranges) p.restoreRanges(v.ranges.lo, v.ranges.hi);
    if (v.snapshot.length) p.restore(v.snapshot);
    ed = { kit, randomness: 1.0, curveIdx: 1, maxLenIdx: 0, snapIdx: 0, seedText: "", lastSeed: "" };
    this.voiceEditors.set(key, ed);
    return ed;
  }

  /** Write the node's editor state back into the node, swap it into the engine (takes
      effect on its next "on" step), persist, and redraw the rings. */
  private writeVoiceFromEditor(li: number): void {
    const ed = this.voiceEditorFor(li);
    const p = ed.kit.get(REF_DRUM);
    const v = this.node(li);
    if (v.soundId < 0) {
      v.soundId = this.nextSoundId++;
      v.color = VOICE_COLORS[li % VOICE_COLORS.length];
      // Give a fresh node an audible default pattern so the shuffle can be heard:
      // 4 bars of 1 hit over 16 steps (the grid-add default).
      if (v.steps < 1) { v.steps = 16; v.hits = 1; v.rotation = 0; v.reps = Math.max(v.reps, 4); }
    }
    v.snapshot = p.capture();
    v.name = p.describe().join(" · ");
    const pr = ed.kit.pitchRange(REF_DRUM);
    v.pitch = [pr[0], pr[1]];
    v.preset = p.presetName();
    v.ranges = p.captureRanges();
    this.pushSounds();
    this.syncLines();
    if (!this.playing) this.refreshRings();
  }

  /** Preview one node's current editor sound once (on the reserved audition channel),
      at the node's measured loudness (its makeup gain rides on Volume, as in the
      pattern) so what you audition is what the loop will play. */
  private auditionVoice(li: number): void {
    const node = this.node(li);
    const p = this.voiceEditorFor(li).kit.get(REF_DRUM);
    const snap = p.capture();
    if (node.gain && node.gain !== 1) snap[ParamId.Volume] = (snap[ParamId.Volume] ?? 0.85) * node.gain;
    this.engine.audition(snap, Math.round(this.engine.sampleRate * 0.4), estimateLength(snap, this.tempo));
  }

  /** Closed-loop loudness pass for line `li`'s edited node: render ONE hit of its
      sound offline, measure it, and store the makeup gain that lands it at the
      reference loudness. The gain is applied to Volume in the engine message and
      the audition — the snapshot itself is untouched, so the mixer fader keeps its
      meaning. Per-hit randomness (ghosts/ratchets/humanize) is zeroed for the
      measurement so a missed hit can't masquerade as a quiet sound; a result that
      arrives after the node was reshuffled or cleared is dropped. Best-effort: on
      any render failure the previous gain stands. */
  private async normalizeVoice(li: number): Promise<void> {
    const v = this.node(li);
    if (v.soundId < 0 || !v.snapshot.length) return;
    const token = v.snapshot; // writeVoiceFromEditor replaces the array on every write
    const meas = v.snapshot.slice();
    meas[ParamId.Volume] = 1;    // measure at unit volume; the gain rides on top
    meas[ParamId.HitChance] = 1; // the measured hit must actually play…
    meas[ParamId.Ratchet] = 0;   // …once, cleanly…
    meas[ParamId.Humanize] = 0;  // …without level jitter
    try {
      const tail = Math.min(1.6, Math.max(0.4, estimateLength(meas, this.tempo)));
      const buffer = await this.engine.renderToBuffer({
        lines: [{ nodes: [{ soundId: 0, steps: 1, lenSteps: STEPS_PER_BAR, waitSteps: 0, pattern: [1] }] }],
        sounds: [{ id: 0, snap: meas, lo: v.pitch[0], hi: v.pitch[1], tail: 0 }],
        tempo: this.tempo,
        maxSteps: 1,
        tailSec: tail,
      });
      if (v.snapshot !== token) return; // stale: the sound changed mid-render
      v.gain = makeupGain(measureLoudness(buffer));
      this.pushSounds();
      this.persist();
    } catch {
      /* keep the previous gain — normalization is best-effort */
    }
  }

  /** Generative write (shuffle/breed/preset/mint): push the editor's sound into the
      node, then re-level it from the offline measurement. Await it so the audition
      that follows plays at the corrected loudness. Manual slider edits go through
      writeVoiceFromEditor directly and are never re-levelled. */
  private async writeAndNormalizeVoice(li: number): Promise<void> {
    this.writeVoiceFromEditor(li);
    await this.normalizeVoice(li);
  }

  /** File the line's current sound in a feedback log — "high" = too screechy (the
      recap row swiped right), "low" = too quiet (swiped left) — with everything
      needed to reproduce it offline. The two logs export from the ≡ menu as two
      JSON files (see model/soundReports.ts). */
  private reportVoiceSound(li: number, kind: ReportKind): void {
    const v = this.node(li);
    if (v.soundId < 0 || !v.snapshot.length) return;
    const ed = this.voiceEditors.get(`${li}:${this.editNode[li]}`);
    const n = addReport(kind, {
      at: new Date().toISOString(),
      name: v.name,
      preset: v.preset,
      seed: ed?.lastSeed || undefined,
      tempo: this.tempo,
      gain: v.gain,
      pitch: [v.pitch[0], v.pitch[1]],
      snapshot: v.snapshot.slice(),
    });
    this.toast(kind === "high" ? `▲ Logged as too screechy (${n})` : `▼ Logged as too quiet (${n})`);
  }

  /** A small transient confirmation pill above everything (auto-removes). */
  private toast(text: string): void {
    document.querySelector(".toast")?.remove();
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    this.root.append(t);
    setTimeout(() => t.remove(), 1700);
  }

  /** Key + tempo context passed to the shuffle UIs (Key snap + synced-echo lengths). */
  private shuffleContext(): { root: number; scale: number; bpm: number } {
    return { root: this.arr.root, scale: this.arr.scale, bpm: this.tempo };
  }

  /** Crossbreed partners: the edited nodes of the OTHER lines that carry sounds. */
  private breedMates(li: number): { name: string; color: string; snapshot: number[] }[] {
    const out: { name: string; color: string; snapshot: number[] }[] = [];
    for (let i = 0; i < NUM_LINES; i++) {
      if (i === li) continue;
      const v = this.node(i);
      if (v.soundId < 0 || !v.snapshot.length) continue;
      out.push({ name: v.name || `Voice ${i + 1}`, color: v.color, snapshot: v.snapshot.slice() });
    }
    return out;
  }

  /** Inline shuffle menu for one line's edited node: generate/replace its sound live
      (a rest shuffles into its first sound). */
  private openVoiceShuffleMenu(anchor: HTMLElement, li: number): void {
    const existing = this.viewRoot.querySelector(".voice-shuffle");
    if (existing) { existing.remove(); return; }
    const editor = this.voiceEditorFor(li);
    const openFull = () => {
      panel.remove();
      document.removeEventListener("pointerdown", close, true);
      this.soundLine = li;
      this.soundReturn = "seq"; // opened from the sequencer — Back returns there
      this.view = "sound";
      this.render();
    };
    const panel = buildVoiceShuffleMenu(editor, REF_DRUM, {
      onChange: () => this.writeAndNormalizeVoice(li),
      audition: () => this.auditionVoice(li),
      onFullParams: openFull,
      context: () => this.shuffleContext(),
      mates: () => this.breedMates(li),
      report: (kind) => this.reportVoiceSound(li, kind),
    });
    anchor.parentElement?.append(panel);
    const close = (ev: PointerEvent) => {
      if (!panel.contains(ev.target as Node) && ev.target !== anchor) {
        panel.remove();
        document.removeEventListener("pointerdown", close, true);
        this.render(); // refresh the row's name/colour now the menu is closing
      }
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  }

  /** Remove the edited node from a line's chain — or, when it's the only node, just
      clear its sound and rhythm (a line always keeps at least one node). Keeps `reps`
      on a clear so the line's timing holds. A fade on a sibling that morphed from/into
      the removed sound is dropped (it has nothing left to blend). */
  private removeNode(li: number): void {
    const nodes = this.arr.lines[li].nodes;
    const k = this.editNode[li];
    if (nodes.length > 1) {
      const removedId = nodes[k].soundId;
      // The node's whole-bar span — the node that FOLLOWS it inherits this as extra
      // lead-in so every LATER voice keeps its place in time instead of sliding earlier.
      const cutSteps = nodeLen(nodes[k]);
      nodes.splice(k, 1);
      const follow = nodes[k]; // the first surviving node past the removed one
      if (follow) {
        const addBars = Math.round(cutSteps / STEPS_PER_BAR);
        if (addBars > 0) follow.wait = Math.min(MAX_REPS, Math.max(0, follow.wait ?? 0) + addBars);
      }
      // A neighbour that morphed from/into the removed sound now has nothing to blend.
      if (removedId >= 0) {
        for (const n of nodes) {
          if (n.intro && n.intro.fromId === removedId) n.intro = undefined;
          if (n.outro && n.outro.toId === removedId) n.outro = undefined;
        }
      }
      if (nodes.length === 0) nodes.push(emptyNode());
      this.editNode[li] = Math.min(k, nodes.length - 1);
      // Node indices shifted — this line's cached editors are stale.
      for (const key of [...this.voiceEditors.keys()]) {
        if (key.startsWith(`${li}:`)) this.voiceEditors.delete(key);
      }
    } else {
      const v = nodes[0];
      if (v.soundId < 0 && !v.intro && !v.outro) return;
      const reps = v.reps;
      nodes[0] = emptyNode();
      nodes[0].reps = reps;
      this.voiceEditors.delete(`${li}:0`);
    }
    this.pushSounds(); // drop removed sounds from the engine table
    this.syncLines();
    if (!this.playing) this.refreshRings();
    this.render();
  }

  /** Set an intro/outro fade on node `k` of line `li` and clamp it into the node's own
      reps (so the loop's total length never changes). `side` decides which end; the
      envelope carries its `reps`, blend `mode`, and its non-silence endpoint id. */
  private setEnvelope(li: number, k: number, side: "intro" | "outro", env: IntroEnv | OutroEnv): void {
    const node = this.arr.lines[li].nodes[k];
    if (!node || node.soundId < 0) return;
    if (side === "intro") node.intro = env as IntroEnv;
    else node.outro = env as OutroEnv;
    clampEnvelopes(node, side);
    this.editNode[li] = k;
    this.syncLines();
    if (!this.playing) this.refreshRings();
    this.render();
  }

  /** Remove one fade from node `k` — the sound keeps its full length. */
  private clearEnvelope(li: number, k: number, side: "intro" | "outro"): void {
    const node = this.arr.lines[li].nodes[k];
    if (!node) return;
    if (side === "intro") node.intro = undefined;
    else node.outro = undefined;
    this.syncLines();
    if (!this.playing) this.refreshRings();
    this.render();
  }

  /** The voice sheet's Transitions menu for node `k` of line `li`: pick WHERE this
      sound's fade goes — its start (an intro) or end (an outro). At the start it can
      rise from silence (fade in) or morph from the previous sound; at the end it can
      fall to silence (fade out) or morph into the next sound (or a freshly minted one
      when it's the chain's tail). Picking a side that's already set just replaces it. */
  private openTransitionMenu(li: number, k: number): void {
    const nodes = this.arr.lines[li].nodes;
    const node = nodes[k];
    const prev = nodes[k - 1];
    const next = nodes[k + 1];

    const overlay = document.createElement("div");
    overlay.className = "tr-overlay";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    const dialog = document.createElement("div");
    dialog.className = "tr-dialog";

    const title = document.createElement("h3");
    title.className = "tr-title";
    title.textContent = "Transition";
    const sub = document.createElement("p");
    sub.className = "hint";
    sub.textContent = "Fade this sound — it stays part of one loop.";
    dialog.append(title, sub);

    const choice = (main: string, note: string, pick: () => void) => {
      const b = document.createElement("button");
      b.className = "tr-place";
      const m = document.createElement("span");
      m.textContent = main;
      const s = document.createElement("small");
      s.textContent = note;
      b.append(m, s);
      b.onclick = () => { overlay.remove(); pick(); };
      return b;
    };

    // Start of this sound → an INTRO. Morph from the previous sound if one plays before
    // it; otherwise (or as well) rise from silence.
    if (this.isSounding(prev)) {
      dialog.append(choice(
        "At the start — from the previous sound",
        node.intro ? "replaces the fade at the start" : "the previous sound blends into this one",
        () => this.editEnvelope(li, k, "intro", prev!.soundId),
      ));
    }
    dialog.append(choice(
      "At the start — fade in",
      node.intro ? "replaces the fade at the start"
        : this.isSounding(prev) ? "rises out of silence into this sound instead"
        : "the voice's entry rises out of silence",
      () => this.editEnvelope(li, k, "intro", -1),
    ));

    // End of this sound → an OUTRO. Morph into the next sound if one follows; always
    // offer a plain fade out. With no next node, offer to mint a sound to blend into.
    if (next && this.isSounding(next)) {
      dialog.append(choice(
        "At the end — into the next sound",
        node.outro ? "replaces the fade at the end" : "this sound blends into the next one",
        () => this.editEnvelope(li, k, "outro", next!.soundId),
      ));
    }
    dialog.append(choice(
      "At the end — fade out",
      node.outro ? "replaces the fade at the end"
        : next ? "dies away into silence" : "the loop's tail — dies away to silence",
      () => this.editEnvelope(li, k, "outro", -1),
    ));
    if (!next) {
      dialog.append(choice(
        "＋ At the end, into a new sound",
        "adds a shuffled sound after this one and blends into it",
        () => {
          nodes.push(emptyNode());
          this.giveNodeSound(li, k + 1); // mints the sound in place + renders
          const made = this.arr.lines[li].nodes[k + 1];
          if (made && made.soundId >= 0) this.editEnvelope(li, k, "outro", made.soundId);
        },
      ));
    }

    const cancel = document.createElement("button");
    cancel.className = "tr-cancel";
    cancel.textContent = "Cancel";
    cancel.onclick = () => overlay.remove();
    const btns = document.createElement("div");
    btns.className = "tr-btns";
    btns.append(cancel);
    dialog.append(btns);

    overlay.append(dialog);
    this.root.append(overlay);
  }

  /** User-facing name for a transition mode (a couple depend on the direction). */
  private transitionModeLabel(m: TransitionMode, kind: "pair" | "in" | "out"): string {
    switch (m) {
      case "morph": return "Morph";
      case "crossfade": return "Crossfade";
      case "alternate": return "Trade";
      case "filter": return "Filter";
      case "fade": return "Fade";
      case "wash": return "Wash";
      case "thin": return kind === "out" ? "Thin out" : "Fill in";
    }
  }

  /** One-line explanation of a transition mode, per direction. */
  private transitionModeTitle(m: TransitionMode, kind: "pair" | "in" | "out"): string {
    if (kind === "pair") {
      switch (m) {
        case "morph": return "One sound's parameters mutate into the other";
        case "crossfade": return "Both sounds play, one fading out as the other fades in";
        case "alternate": return "The two sounds trade hits, the new one gradually taking over";
        default: return "Both play while one filter closes and the other opens — a spectral crossfade";
      }
    }
    const rising = kind === "in";
    switch (m) {
      case "filter": return rising ? "Opens up out of a closed filter" : "Closes down into a shut filter";
      case "wash": return rising ? "Condenses out of a distant reverb cloud" : "Dissolves away into a reverb cloud";
      case "thin": return rising ? "Hits appear one by one until the pattern is whole" : "Hits drop away until nothing is left";
      default: return rising ? "A pure volume rise from silence" : "A pure volume fall to silence";
    }
  }

  /** Style buttons for one of a node's EXISTING fades (the pair modes or the fade
      styles, by its kind) — shared by the sequencer's expanded row and the voice
      sheet, so a blend can be re-styled after it's created. */
  private envModeToggle(node: VoiceNode, side: "intro" | "outro", inline = false): HTMLElement {
    const env = side === "intro" ? node.intro! : node.outro!;
    const otherId = side === "intro" ? (env as IntroEnv).fromId : (env as OutroEnv).toId;
    const kind = side === "intro" ? introKind(otherId) : outroKind(otherId);
    const choices = kind === "pair" ? PAIR_MODES : FADE_MODES;
    const wrap = document.createElement("div");
    wrap.className = "tr-modes" + (inline ? " inline" : "");
    for (const m of choices) {
      const b = document.createElement("button");
      b.className = "tr-mode" + (env.mode === m ? " on" : "");
      b.textContent = this.transitionModeLabel(m, kind);
      b.title = this.transitionModeTitle(m, kind);
      b.onclick = () => { env.mode = m; this.syncLines(); this.render(); };
      wrap.append(b);
    }
    return wrap;
  }

  /** Popup for a chosen fade on node `k`: pick the blend style + length, then apply.
      `side` = intro (start) or outro (end); `otherId` = the endpoint it blends against
      (-1 = silence, a plain fade; else a neighbour sound's id, a morph). The length is
      measured in THIS node's reps and capped so it never overruns the loop (leaving room
      for a fade already on the other end) — the loop's stated length never changes. */
  private editEnvelope(li: number, k: number, side: "intro" | "outro", otherId: number): void {
    const node = this.arr.lines[li].nodes[k];
    if (!node || node.soundId < 0) return;
    const kind = side === "intro" ? introKind(otherId) : outroKind(otherId);

    const overlay = document.createElement("div");
    overlay.className = "tr-overlay";
    const dialog = document.createElement("div");
    dialog.className = "tr-dialog";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const title = document.createElement("h3");
    title.className = "tr-title";
    title.textContent = kind === "in" ? "Fade in" : kind === "out" ? "Fade out" : "Transition";
    dialog.append(title);

    // Style picker: how the blend travels (pair modes, or the fade styles).
    const choices = kind === "pair" ? PAIR_MODES : FADE_MODES;
    const existing = side === "intro" ? node.intro : node.outro;
    let mode: TransitionMode = existing && choices.includes(existing.mode) ? existing.mode : choices[0];
    const modeRow = document.createElement("div");
    modeRow.className = "tr-modes";
    const modeBtns = choices.map((m) => {
      const b = document.createElement("button");
      b.textContent = this.transitionModeLabel(m, kind);
      b.title = this.transitionModeTitle(m, kind);
      b.onclick = () => { mode = m; syncMode(); };
      return b;
    });
    const syncMode = () => {
      modeBtns.forEach((b, i) => { b.className = "tr-mode" + (choices[i] === mode ? " on" : ""); });
    };
    syncMode();
    modeRow.append(...modeBtns);
    dialog.append(modeRow);

    // Length stepper, in this node's own reps. Cap = the node's reps minus whatever a
    // fade on the OTHER end already claims, so the two can't overlap and the loop can be
    // covered end-to-end (a 4-bar fade on a 4-bar loop is allowed).
    const unit = node.steps >= 1 ? node.steps : STEPS_PER_BAR;
    const other = side === "intro" ? node.outro : node.intro;
    const maxReps = Math.max(1, node.reps - (other ? other.reps : 0));
    let reps = Math.min(Math.max(1, existing?.reps ?? 2), maxReps);
    const lenRow = document.createElement("div");
    lenRow.className = "tr-len";
    const lbl = document.createElement("span");
    lbl.textContent = "Length";
    const minus = document.createElement("button");
    minus.className = "tr-step";
    minus.textContent = "−";
    const val = document.createElement("span");
    val.className = "tr-len-val";
    const plus = document.createElement("button");
    plus.className = "tr-step";
    plus.textContent = "+";
    const syncLen = () => {
      const bars = (reps * unit) / STEPS_PER_BAR;
      val.textContent = `${reps} rep${reps === 1 ? "" : "s"} · ${Number.isInteger(bars) ? bars : +bars.toFixed(2)} bar${bars === 1 ? "" : "s"}`;
    };
    minus.onclick = () => { reps = Math.max(1, reps - 1); syncLen(); };
    plus.onclick = () => { reps = Math.min(maxReps, reps + 1); syncLen(); };
    syncLen();
    lenRow.append(lbl, minus, val, plus);
    dialog.append(lenRow);

    // Reassure that the fade lives INSIDE the loop, not on top of it.
    const foldHint = document.createElement("p");
    foldHint.className = "hint";
    foldHint.textContent = side === "intro"
      ? "Covers the start of this loop — its length doesn't change."
      : "Covers the end of this loop — its length doesn't change.";
    dialog.append(foldHint);

    const cancel = document.createElement("button");
    cancel.className = "tr-cancel";
    cancel.textContent = "Cancel";
    cancel.onclick = () => overlay.remove();
    const add = document.createElement("button");
    add.className = "tr-add";
    add.textContent = kind === "in" ? "Add fade-in" : kind === "out" ? "Add fade-out" : "Add transition";
    add.onclick = () => {
      overlay.remove();
      const env: IntroEnv | OutroEnv = side === "intro"
        ? { reps, mode, fromId: otherId }
        : { reps, mode, toId: otherId };
      this.setEnvelope(li, k, side, env);
    };
    const btns = document.createElement("div");
    btns.className = "tr-btns";
    btns.append(cancel, add);
    dialog.append(btns);

    overlay.append(dialog);
    this.root.append(overlay);
  }

  // --- loop view (the arrangement timeline — the app's homepage) -----------
  // The 6 voice lines drawn as a bar grid: 6 rows tall, 8 bars wide (or the whole loop
  // when zoomed out), paged 8 bars at a time. Each node fills a slice of its row from
  // where its SOUND starts (lead-in Wait is just empty track) to its end. The rings
  // visualizer sits on top; a compact pager + zoom flank the grid; the loop length +
  // hint sit below it. Tap a node to edit it (its sheet holds Add-transition + the
  // value circles + shuffle). Empty space: press-drag sketches a new sound's span,
  // a tap drops the 4-bar default, a hold pastes a copied voice. Hold a voice to copy it.
  // Every node has a right-edge grip to resize it; a voice ending on an earlier page
  // gets a page-edge grip to drag it into the viewed bars.
  private renderLoop(): void {
    const v = this.viewRoot;
    // Per line, per node: an array of block elements (one per rendered band) for the glow.
    this.nodeDotEls = this.arr.lines.map((ln) => ln.nodes.map(() => [] as HTMLElement[]));

    // The visible window. Normally 8 bars, paged — pages cover the content plus one
    // empty page past the end so there's always room to arrange further out. Zoomed
    // out there's a single page holding the whole loop.
    const BARS_PER_PAGE = this.pageBars();
    const loopBars = this.arr.loopSteps() / STEPS_PER_BAR;
    const maxPage = this.loopZoomOut
      ? 0
      : Math.max(0, Math.ceil(Math.max(loopBars, 0.001) / BARS_PER_PAGE) - 1) + 1;
    this.loopPage = Math.max(0, Math.min(this.loopPage, maxPage));
    const page = this.loopPage;
    const winStart = page * BARS_PER_PAGE; // window's first bar (0-indexed)
    const winEnd = winStart + BARS_PER_PAGE;

    // Zoom toggle (whole loop ↔ 8-bar pages). Zoomed in it tucks into the TOP-LEFT of the
    // rings visualiser (mirroring the mixer opener); zoomed out — the rings are gone — it
    // rides in the pager instead so you can always get back.
    const zoom = document.createElement("button");
    zoom.className = "bar-pager-btn bar-zoom-btn";
    zoom.textContent = this.loopZoomOut ? "⊕" : "⊖";
    zoom.title = this.loopZoomOut ? "Zoom in — 8 bars per page" : "Zoom out — see the whole loop";
    zoom.setAttribute("aria-label", "Zoom");
    zoom.onclick = () => {
      this.loopZoomOut = !this.loopZoomOut;
      if (!this.loopZoomOut) this.loopPage = 0;
      this.render();
    };

    // The rings visualizer (the Euclidean sequencer animation) sits ON TOP as a live view
    // of the voices — but only in the 8-bar view. Zoomed out we ditch it so the grid gets
    // the whole height (two stacked bands below).
    if (!this.loopZoomOut) {
      const rings = document.createElement("div");
      rings.className = "loop-rings";
      // Zoom at the top-left corner, mixer opener at the top-right (over empty ring space).
      rings.append(this.euclidView.canvas, zoom, this.mixerOpenBtn("loop"));
      v.append(rings);
    }

    // Compact pager: step the visible window 8 bars at a time (‹ / › buttons). Zoomed out
    // there's one page, so the arrows give way to the zoom-in + mixer buttons.
    const pager = document.createElement("div");
    pager.className = "bar-pager";
    const prev = document.createElement("button");
    prev.className = "bar-pager-btn";
    prev.textContent = "‹";
    prev.title = "Previous 8 bars";
    prev.disabled = page <= 0;
    prev.onclick = () => { this.loopPage = Math.max(0, this.loopPage - 1); this.render(); };
    const pLabel = document.createElement("span");
    pLabel.className = "bar-pager-label";
    pLabel.textContent = this.loopZoomOut ? `Bars ${winStart + 1}–${winEnd} · all` : `Bars ${winStart + 1}–${winEnd}`;
    const next = document.createElement("button");
    next.className = "bar-pager-btn";
    next.textContent = "›";
    next.title = "Next 8 bars";
    next.disabled = page >= maxPage;
    next.onclick = () => { this.loopPage = this.loopPage + 1; this.render(); };
    if (this.loopZoomOut) pager.append(zoom, pLabel, this.mixerOpenBtn("loop"));
    else pager.append(prev, pLabel, next);
    v.append(pager);

    // Trim a bars quantity for labels (28 steps = 1.75 bars).
    const fmt = (b: number): string => (Number.isInteger(b) ? String(b) : String(+b.toFixed(2)));
    const barsLabel = (n: VoiceNode): string => fmt(nodeBars(n) - waitLen(n) / STEPS_PER_BAR);

    // Build one band: a 6-row bar grid spanning [bandStart, bandStart + bandBars). One
    // band covers the whole window normally; zoomed out, two of them stack to split the
    // loop across two rows (double the bar width). Every node registers its block in
    // nodeDotEls[li][k] (one per band) for the playing glow.
    const buildBand = (bandStart: number, bandBars: number): HTMLElement => {
      const bandEnd = bandStart + bandBars;
      const pct = (bars: number): number => (bars / bandBars) * 100; // bars → % of the band
      const grid = document.createElement("div");
      grid.className = "bar-grid";
      grid.style.setProperty("--bars", String(bandBars)); // bar dividers (see .bar-track)
      for (let li = 0; li < NUM_LINES; li++) {
        const nodes = this.arr.lines[li].nodes;
        const row = document.createElement("div");
        row.className = "bar-row";
        row.style.setProperty("--vc", VOICE_COLORS[li]);

        const track = document.createElement("div");
        track.className = "bar-track";
        const contentEnd = this.arr.lineSteps(li) / STEPS_PER_BAR; // this line's end, in bars

        // Empty-space affordance over [loBar, hiBar): press-drag sketches a new sound's
        // span, a tap drops the 4-bar default, a press-and-hold pastes a copied voice or
        // adds a sound. One covers the tail past the line's content; one covers every lead-in
        // gap (a node's Wait — silent bars are just empty track now).
        const addZone = (loBar: number, hiBar: number) => {
          const l = Math.max(loBar, bandStart), r = Math.min(hiBar, bandEnd);
          if (r - l < 0.05) return;
          const zone = document.createElement("button");
          zone.className = "bar-add";
          zone.style.left = `${pct(l - bandStart)}%`;
          zone.style.width = `${pct(r - l)}%`;
          zone.title = "Tap for a 4-bar sound · press and drag to size it · hold to paste / add";
          if (r - l > 0.6) {
            const plus = document.createElement("span");
            plus.className = "bar-add-plus";
            plus.textContent = "＋";
            zone.append(plus);
          }
          this.wireAddZone(zone, track, li, loBar, hiBar, bandStart, bandBars);
          track.append(zone);
        };
        addZone(contentEnd, bandEnd);

        // Node blocks, positioned by cumulative bars — each starts where its SOUND does
        // (after any lead-in Wait) and ends with its window. Blocks outside the band
        // are clipped by the track's overflow; every node still pushes a block so
        // nodeDotEls indices stay aligned for the playing glow.
        const dots: HTMLElement[] = [];
        let startBar = 0;
        nodes.forEach((n, k) => {
          const len = nodeBars(n);
          const s = startBar;
          startBar += len;
          const wb = waitLen(n) / STEPS_PER_BAR; // lead-in bars: empty track + an add zone
          if (wb >= 1) addZone(s, s + wb);

          const isSound = n.soundId >= 0;
          const block = document.createElement("button");
          block.className = "bar-node"
            + (isSound ? " has-sound" : " rest")
            + (isSound && n.intro ? " has-in" : "")
            + (isSound && n.outro ? " has-out" : "")
            + (k === this.editNode[li] ? " editing" : "");
          block.style.left = `${pct(s + wb - bandStart)}%`;
          block.style.width = `${pct(len - wb)}%`;

          // Intro/outro fades live INSIDE this one block: paint their regions fading
          // toward transparent (over the first `intro.reps` / last `outro.reps` of the
          // node), so the fade shows without splitting the sound into a second block.
          if (isSound && (n.intro || n.outro)) {
            const base = VOICE_COLORS[li];
            const reps = Math.max(1, n.reps | 0);
            const inFrac = n.intro ? Math.min(100, (n.intro.reps / reps) * 100) : 0;
            const outFrac = n.outro ? Math.min(100, (n.outro.reps / reps) * 100) : 0;
            const inEdge = n.intro ? "transparent" : base;
            const outEdge = n.outro ? "transparent" : base;
            block.style.background =
              `linear-gradient(90deg, ${inEdge} 0%, ${base} ${inFrac}%, ${base} ${100 - outFrac}%, ${outEdge} 100%)`;
          }

          // Label: the sound's generated name (its identity, matching the mixer/sequencer);
          // a rest shows its length. The name ellipsis-truncates on narrow blocks — the
          // full name + bars (+ any fades) live in the tooltip.
          const label = document.createElement("span");
          label.className = "bar-node-label";
          if (isSound) {
            label.textContent = n.name || barsLabel(n);
            const fades: string[] = [];
            if (n.intro) fades.push(introKind(n.intro.fromId) === "in" ? "fade in" : "blend in");
            if (n.outro) fades.push(outroKind(n.outro.toId) === "out" ? "fade out" : "blend out");
            const fadeStr = fades.length ? ` · ${fades.join(" + ")}` : "";
            block.title = `${n.name || "node"} · ${barsLabel(n)} bars${fadeStr} · tap to edit, hold to copy`;
          } else {
            label.textContent = barsLabel(n);
            block.title = `rest — tap to add a sound · ${barsLabel(n)} bars`;
          }
          block.append(label);

          if (isSound) {
            // A sounding block: press-drag it left/right to move it in time (a plain tap
            // opens its editing sheet). Its slot bounds keep it from overlapping neighbours.
            this.attachMove(block, track, li, k, s + wb, bandStart, bandBars);
          } else {
            block.onclick = () => this.giveNodeSound(li, k); // a rest → sound in place
          }
          // Right-edge grip: press-drag the node's end to resize it (reps in its own unit).
          const grip = document.createElement("span");
          grip.className = "bar-node-grip";
          this.attachResize(grip, block, track, n, s + wb, bandStart, bandBars);
          block.append(grip);
          dots.push(block);
          this.nodeDotEls![li][k].push(block);
          track.append(block);
        });

        // A voice that ends before this band: a grab-tab at the band's left edge press-drags
        // its last node's end rightward, extending it from the edge into the viewed bars.
        if (contentEnd > 0 && contentEnd <= bandStart + 0.001) {
          const lastK = nodes.length - 1;
          const lastN = nodes[lastK];
          if (lastN.soundId >= 0) {
            const tab = document.createElement("button");
            tab.className = "bar-edge-grip";
            tab.textContent = "›";
            tab.title = "This voice ends on an earlier page — drag to extend it into these bars";
            const bodyStart = contentEnd - nodeBars(lastN) + waitLen(lastN) / STEPS_PER_BAR;
            this.attachResize(tab, dots[lastK], track, lastN, bodyStart, bandStart, bandBars);
            track.append(tab);
          }
        }

        row.append(track);
        grid.append(row);
      }
      return grid;
    };

    // One band across the page normally; zoomed out, two stacked bands split the loop in
    // half (top = first half of the bars, bottom = second) so each bar is twice as wide.
    if (this.loopZoomOut) {
      const half = BARS_PER_PAGE / 2;
      this.barGridEls = [buildBand(0, half), buildBand(half, half)];
    } else {
      this.barGridEls = [buildBand(winStart, BARS_PER_PAGE)];
    }
    this.barGridEls.forEach((g) => v.append(g)); // the playhead sweeps each via its --ph var

    this.updateLoopTime(); // loop length now lives on the top-left button

    if (!this.playing) this.refreshRings();
    // Size the rings only when shown (zoomed out drops them); sync now (viewRoot is in the
    // DOM) and again next frame for first paint.
    if (!this.loopZoomOut) {
      this.euclidView.layout();
      requestAnimationFrame(() => this.euclidView.layout());
    }
  }

  /** Place a new EMPTY node on line `li` so its sound will START at (whole) bar `bar`.
      Past the line's end it appends (bridging the gap with lead-in Wait, reusing a
      trailing empty rest); inside an existing node's lead-in gap it SPLITS the silence
      (the new node takes the head, the shifted node keeps enough Wait that its entry
      holds). `fill` writes the node's rhythm/sound given the whole bars the spot can
      take (at least 1, at most `wantBars`). Returns false when the spot can't take a
      node (inside sounding content, or a sub-bar gap). Caller resyncs + renders. */
  private placeNodeAt(
    li: number, bar: number, wantBars: number,
    fill: (node: VoiceNode, grantBars: number) => void,
  ): boolean {
    const nodes = this.arr.lines[li].nodes;
    const targetBar = Math.max(0, Math.round(bar));
    const want = Math.max(1, Math.round(wantBars));

    // Inside an existing lead-in gap? Split it: [remaining wait][new node][kept entry].
    let w = 0; // window-start bars of the node being examined
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const waitB = waitLen(n) / STEPS_PER_BAR;
      const audibleStart = w + waitB;
      if (targetBar < audibleStart - 0.001) {
        if (targetBar < w - 0.001) return false; // inside the PREVIOUS node's sound
        const newWait = Math.max(0, Math.round(targetBar - w));
        const avail = Math.round(waitB - newWait); // whole gap bars from the start on
        if (avail < 1) return false;
        const node = emptyNode();
        node.wait = newWait > 0 ? newWait : undefined;
        fill(node, Math.min(want, avail));
        // Whatever gap the new node didn't use stays as the shifted node's Wait, so
        // its sound still enters on the same bar.
        const rest = Math.max(0, Math.round(audibleStart - (w + nodeBars(node))));
        n.wait = rest > 0 ? Math.min(MAX_REPS, rest) : undefined;
        nodes.splice(i, 0, node);
        this.editNode[li] = i;
        // Node indices shifted — this line's cached editors are stale.
        for (const key of [...this.voiceEditors.keys()]) {
          if (key.startsWith(`${li}:`)) this.voiceEditors.delete(key);
        }
        return true;
      }
      w += nodeBars(n);
    }

    // Past the line's end: append (or reuse a trailing empty rest), bridging with Wait.
    const last = nodes[nodes.length - 1];
    const reuse = last.soundId < 0; // a trailing empty rest slot
    const slot = reuse ? nodes.length - 1 : nodes.length;
    let base = 0; // bars occupied by the nodes before this slot
    for (let k = 0; k < slot; k++) base += nodeBars(nodes[k]);
    const node = reuse ? last : emptyNode();
    if (!reuse) nodes.push(node);
    const gap = Math.max(0, Math.round(targetBar - base));
    node.wait = gap > 0 ? Math.min(MAX_REPS, gap) : undefined;
    node.split = undefined;
    fill(node, want);
    this.editNode[li] = slot;
    this.voiceEditors.delete(`${li}:${slot}`); // any editor cached at this index is stale
    return true;
  }

  /** Grid add: drop a fresh sounding node whose sound starts at bar `bar`, `bars`
      bars long — the default groove is 1 hit per bar of 16 steps, so a tap gives
      4 bars and a drag gives exactly the sketched span. */
  private addSoundAt(li: number, bar: number, bars = 4): void {
    const ok = this.placeNodeAt(li, bar, bars, (node, grant) => {
      node.steps = 16; node.hits = 1; node.rotation = 0; node.split = undefined;
      node.reps = Math.max(1, Math.min(MAX_REPS, grant));
    });
    if (!ok) { this.toast("No room for a sound there"); return; }
    this.expanded = li;
    this.mintNodeSound(li); // give it an audible, shuffled sound
    this.render();
  }

  /** A detached copy of a node's sound for the clipboard: fresh arrays so the original
      isn't shared. Fades are dropped — they'd reference neighbours that don't exist at
      the paste spot, and the copied sound arrives clean, ready to shape again. */
  private copyNode(n: VoiceNode): VoiceNode {
    return {
      ...n,
      snapshot: n.snapshot.slice(),
      pitch: [n.pitch[0], n.pitch[1]],
      ranges: n.ranges ? { lo: n.ranges.lo.slice(), hi: n.ranges.hi.slice() } : undefined,
      intro: undefined,
      outro: undefined,
    };
  }

  /** Place a copy of source node `s` (its sound + rhythm + length) as a NEW node whose
      sound starts at bar `bar` on line `li`: a fresh sound id, the DESTINATION line's
      colour (so a cross-line paste stays visually coherent), the source's length unless
      the spot is too tight. Returns false when the spot can't take it (caller toasts).
      Shared by paste-here and duplicate. */
  private pasteSourceAt(li: number, bar: number, s: VoiceNode): boolean {
    const unit = s.steps >= 1 ? s.steps : STEPS_PER_BAR;
    const activeBars = Math.max(1, Math.round((Math.max(1, s.reps) * unit) / STEPS_PER_BAR));
    const ok = this.placeNodeAt(li, bar, activeBars, (node, grant) => {
      node.soundId = this.nextSoundId++;
      node.snapshot = s.snapshot.slice();
      node.color = VOICE_COLORS[li % VOICE_COLORS.length];
      node.name = s.name;
      node.pitch = [s.pitch[0], s.pitch[1]];
      node.hits = s.hits; node.steps = s.steps; node.rotation = s.rotation; node.split = s.split;
      node.gain = s.gain;
      node.preset = s.preset;
      node.ranges = s.ranges ? { lo: s.ranges.lo.slice(), hi: s.ranges.hi.slice() } : undefined;
      // Keep the source's exact length unless the gap can't take it.
      node.reps = grant >= activeBars
        ? s.reps
        : Math.max(1, Math.min(MAX_REPS, Math.floor((grant * STEPS_PER_BAR) / unit)));
    });
    if (!ok) return false;
    this.pushSounds();
    this.syncLines();
    if (!this.playing) this.refreshRings();
    this.render();
    return true;
  }

  /** Wire an empty-track zone: press-drag sketches a new sound's span (a ghost block
      previews it, snapped to whole bars) and releasing places it; a plain tap places
      the 4-bar default; a press-and-hold (without moving) opens the paste / add menu
      for the pressed bar. `loBar..hiBar` bound the zone in absolute bars. */
  private wireAddZone(
    zone: HTMLElement, track: HTMLElement, li: number,
    loBar: number, hiBar: number, winStart: number, bpp: number,
  ): void {
    const lo = Math.ceil(loBar - 0.001); // first whole bar inside the zone
    const barAt = (clientX: number): number => {
      const r = track.getBoundingClientRect();
      return winStart + ((clientX - r.left) / Math.max(1, r.width)) * bpp;
    };
    let startX = 0, startY = 0, startBar = 0, dragging = false, held = false, holdTimer = 0;
    let ghost: HTMLElement | null = null;
    let ghostSpan: [number, number] = [0, 0];
    const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; } };

    zone.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      startX = e.clientX; startY = e.clientY;
      startBar = Math.max(lo, Math.min(Math.floor(hiBar - 0.999), Math.floor(barAt(e.clientX) + 0.001)));
      dragging = true;
      held = false;
      this.gridDragBusy = true; // hold the page-follow while sketching
      try { zone.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      // Press and HOLD without moving opens the paste / add menu at this bar.
      clearHold();
      holdTimer = window.setTimeout(() => {
        holdTimer = 0;
        held = true;      // swallow the pending tap/drag — the menu owns this press now
        dragging = false;
        this.gridDragBusy = false;
        ghost?.remove(); ghost = null;
        try { zone.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        this.openGridAddMenu(li, startBar, e.clientX, e.clientY);
      }, 420);
    });
    zone.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (Math.abs(e.clientX - startX) >= 7 || Math.abs(e.clientY - startY) >= 7) clearHold(); // any drag cancels the hold
      if (!ghost && Math.abs(e.clientX - startX) < 7) return; // not a drag yet
      e.preventDefault();
      if (!ghost) {
        ghost = document.createElement("span");
        ghost.className = "bar-drag-ghost";
        track.append(ghost);
      }
      // Snap the sketch to whole bars, growing from the pressed bar either way.
      const cur = Math.max(lo, Math.min(hiBar, barAt(e.clientX)));
      const a = Math.min(startBar, Math.floor(cur));
      const b = Math.max(startBar + 1, Math.min(hiBar, Math.ceil(cur)));
      ghostSpan = [a, b];
      ghost.style.left = `${((a - winStart) / bpp) * 100}%`;
      ghost.style.width = `${((b - a) / bpp) * 100}%`;
    });
    const end = (e: PointerEvent, cancelled: boolean) => {
      if (held) return; // the hold menu already took over this press
      if (!dragging) return;
      dragging = false;
      this.gridDragBusy = false;
      clearHold();
      try { zone.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (ghost) {
        const [a, b] = ghostSpan;
        ghost.remove();
        ghost = null;
        if (!cancelled && b > a) this.addSoundAt(li, a, b - a);
        return;
      }
      if (cancelled) return;
      // A plain tap drops the default 4-bar groove (copy now lives in the hold menu).
      this.addSoundAt(li, startBar);
    };
    zone.addEventListener("pointerup", (e) => end(e, false));
    zone.addEventListener("pointercancel", (e) => end(e, true));
  }

  /** A small press-and-hold popup (the app's context-menu style): a card of labelled
      actions anchored at the press point `px,py`, clamped into the viewport (flips above
      the finger when it would run off the bottom). Closes on an outside tap. */
  private openHoldMenu(
    px: number, py: number, vc: string,
    items: { glyph: string; main: string; note: string; fn: () => void; disabled?: boolean }[],
  ): void {
    document.querySelector(".grid-menu-overlay")?.remove(); // only one at a time
    const overlay = document.createElement("div");
    overlay.className = "grid-menu-overlay";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const menu = document.createElement("div");
    menu.className = "grid-menu";
    menu.style.setProperty("--vc", vc);

    for (const it of items) {
      const b = document.createElement("button");
      b.className = "grid-menu-item";
      b.disabled = !!it.disabled;
      const g = document.createElement("span");
      g.className = "grid-menu-glyph";
      g.textContent = it.glyph;
      const tx = document.createElement("span");
      tx.className = "grid-menu-text";
      const m = document.createElement("span");
      m.className = "grid-menu-main";
      m.textContent = it.main;
      const s = document.createElement("small");
      s.textContent = it.note;
      tx.append(m, s);
      b.append(g, tx);
      b.onclick = () => { overlay.remove(); it.fn(); };
      menu.append(b);
    }

    overlay.append(menu);
    this.root.append(overlay);

    menu.style.left = `${Math.round(px)}px`;
    menu.style.top = `${Math.round(py + 8)}px`;
    requestAnimationFrame(() => {
      const m = menu.getBoundingClientRect();
      const pad = 8;
      const left = Math.max(pad + m.width / 2, Math.min(px, window.innerWidth - pad - m.width / 2));
      menu.style.left = `${Math.round(left)}px`;
      if (py + 8 + m.height > window.innerHeight - pad) {
        menu.style.top = `${Math.round(Math.max(pad, py - m.height - 8))}px`;
      }
    });
  }

  /** The hold menu over an EMPTY grid zone: paste the copied voice at the pressed bar,
      or drop a fresh shuffled groove. Pasting is disabled (with a hint) until a voice
      has been copied via its own hold menu. */
  private openGridAddMenu(li: number, bar: number, px: number, py: number): void {
    const clip = this.voiceClip;
    this.openHoldMenu(px, py, VOICE_COLORS[li], [
      {
        glyph: "📋", main: "Paste here",
        note: clip ? (clip.name || "the copied sound") : "hold a voice to copy it first",
        disabled: !clip,
        fn: () => {
          if (!clip) return;
          if (this.pasteSourceAt(li, bar, clip)) this.toast(`📋 Pasted ${clip.name || "sound"}`);
          else this.toast("No room to paste there");
        },
      },
      {
        glyph: "＋", main: "New sound", note: "a fresh shuffled 4-bar groove",
        fn: () => this.addSoundAt(li, bar),
      },
    ]);
  }

  /** The hold menu over a SOUNDING voice block: copy it to the clipboard (to paste
      elsewhere by holding an empty spot), or duplicate it straight after itself. */
  private openVoiceCopyMenu(li: number, k: number, px: number, py: number): void {
    const nodes = this.arr.lines[li].nodes;
    const node = nodes[k];
    if (!node || !this.isSounding(node) || !node.snapshot.length) return;
    const label = node.name || `voice ${li + 1}`;
    // The node's audible end bar (its start + active length) — where a duplicate lands.
    let startBar = 0;
    for (let i = 0; i < k; i++) startBar += nodeBars(nodes[i]);
    const endBar = Math.round(startBar + nodeBars(node));
    this.openHoldMenu(px, py, node.color, [
      {
        glyph: "⧉", main: "Copy",
        note: "copy this sound — hold an empty spot to paste",
        fn: () => { this.voiceClip = this.copyNode(node); this.toast(`⧉ Copied ${label}`); },
      },
      {
        glyph: "⧉", main: "Duplicate",
        note: "drop a copy right after this one",
        fn: () => {
          if (this.pasteSourceAt(li, endBar, node)) this.toast(`⧉ Duplicated ${label}`);
          else this.toast("No room to duplicate here");
        },
      },
    ]);
  }

  /** A right-edge grip that press-drags a node's END to resize it — reps in the
      node's own step unit, snapped, previewed live on its block and committed on
      release. Also drives the page-edge tab (same math; the block just starts
      off-screen). `bodyStartBar` is the node's audible start in absolute bars. */
  private attachResize(
    grip: HTMLElement, block: HTMLElement, track: HTMLElement,
    node: VoiceNode, bodyStartBar: number, winStart: number, bpp: number,
  ): void {
    const unit = node.steps >= 1 ? node.steps : STEPS_PER_BAR;
    const barAt = (clientX: number): number => {
      const r = track.getBoundingClientRect();
      return winStart + ((clientX - r.left) / Math.max(1, r.width)) * bpp;
    };
    let dragging = false, moved = false, lastReps = node.reps;
    grip.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.stopPropagation();
      dragging = true;
      moved = false;
      lastReps = node.reps;
      this.gridDragBusy = true;
      try { grip.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    });
    grip.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      e.preventDefault();
      moved = true;
      const endBar = barAt(e.clientX);
      const reps = Math.round(((endBar - bodyStartBar) * STEPS_PER_BAR) / unit);
      lastReps = Math.max(1, Math.min(MAX_REPS, reps));
      block.style.width = `${(((lastReps * unit) / STEPS_PER_BAR) / bpp) * 100}%`;
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      this.gridDragBusy = false;
      try { grip.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (!moved) return;
      if (lastReps !== node.reps) {
        node.reps = lastReps;
        clampEnvelopes(node); // a shorter loop can't hold a longer fade
        this.syncLines();
        this.syncSection(); // the resized node may be the section window
        if (!this.playing) this.refreshRings();
      }
      this.render(); // reflect the committed (or reverted) width
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    grip.addEventListener("click", (e) => e.stopPropagation()); // don't open the sheet
  }

  /** Press-drag a sounding node block left/right to move it in time, snapped to whole
      bars and previewed live. The move TRANSFERS lead-in bars between this node and the
      gap after it, so the node slides within its own free space (its lead-in plus the
      following gap) and every OTHER block stays put — never overlapping a neighbour. A
      plain tap (no drag) opens the node's editing sheet; a press-and-hold opens its
      copy / duplicate menu. `bodyStartBar` is the node's audible start in absolute bars. */
  private attachMove(
    block: HTMLElement, track: HTMLElement, li: number, k: number,
    bodyStartBar: number, winStart: number, bpp: number,
  ): void {
    let dragging = false, moved = false, held = false, downX = 0, downY = 0, delta = 0, lo = 0, hi = 0, holdTimer = 0;
    const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; } };
    block.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const nodes = this.arr.lines[li].nodes;
      const node = nodes[k];
      if (!node || node.soundId < 0) return; // only real sounds move
      const next = nodes[k + 1];
      const wait = Math.max(0, node.wait ?? 0);
      lo = -wait;                                                     // earliest: fill its own lead-in
      hi = next ? Math.max(0, next.wait ?? 0)                         // latest: eat the following gap
                : Math.max(0, MAX_REPS - wait);                       // last node: slide out freely
      dragging = true; moved = false; held = false; downX = e.clientX; downY = e.clientY; delta = 0;
      this.gridDragBusy = true;
      try { block.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      // Press and HOLD still (no drag) opens this voice's copy / duplicate menu.
      clearHold();
      holdTimer = window.setTimeout(() => {
        holdTimer = 0; held = true; dragging = false; this.gridDragBusy = false;
        try { block.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        this.openVoiceCopyMenu(li, k, e.clientX, e.clientY);
      }, 420);
    });
    block.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (Math.abs(e.clientX - downX) >= 6 || Math.abs(e.clientY - downY) >= 6) clearHold(); // a drag, not a hold
      if (!moved && Math.abs(e.clientX - downX) < 6) return; // still a tap, not a drag
      moved = true;
      e.preventDefault();
      const bars = ((e.clientX - downX) / Math.max(1, track.getBoundingClientRect().width)) * bpp;
      delta = Math.max(lo, Math.min(hi, Math.round(bars)));
      block.style.left = `${((bodyStartBar + delta - winStart) / bpp) * 100}%`;
    });
    const end = (e: PointerEvent) => {
      if (held) return; // the copy menu took over this press
      if (!dragging) return;
      dragging = false;
      this.gridDragBusy = false;
      clearHold();
      try { block.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (!moved) { this.openVoiceSheet(li, k); return; } // a plain tap edits the voice
      if (delta !== 0) {
        const nodes = this.arr.lines[li].nodes;
        const node = nodes[k];
        const next = nodes[k + 1];
        const w = Math.max(0, node.wait ?? 0) + delta;
        node.wait = w > 0 ? Math.min(MAX_REPS, w) : undefined;
        if (next) {
          const wn = Math.max(0, next.wait ?? 0) - delta; // the gap absorbs the opposite
          next.wait = wn > 0 ? Math.min(MAX_REPS, wn) : undefined;
        }
        this.syncLines();
        this.syncSection(); // the moved node may be the section window
        if (!this.playing) this.refreshRings();
      }
      this.render(); // reflect the committed (or reverted) position
    };
    block.addEventListener("pointerup", end);
    block.addEventListener("pointercancel", end);
  }

  /** Turn an existing rest node into a sounding one in place (keeping its position and
      lead-in Wait) — used when a rest block on the grid is tapped. */
  private giveNodeSound(li: number, k: number): void {
    const node = this.arr.lines[li].nodes[k];
    if (!node || node.soundId >= 0) return;
    if (node.steps < 1) { node.steps = 16; node.hits = 1; node.rotation = 0; }
    this.editNode[li] = k;
    this.expanded = li;
    this.voiceEditors.delete(`${li}:${k}`);
    this.mintNodeSound(li);
    this.render();
  }

  /** Mint an audible sound for the line's current edit node by shuffling a fresh editor
      and writing it back, so a grid-added node arrives with character, ready to refine. */
  private mintNodeSound(li: number): void {
    const ed = this.voiceEditorFor(li);
    const ctx = this.shuffleContext();
    ed.kit.shuffleAll(REF_DRUM, {
      randomness: ed.randomness,
      curve: CURVE_OPTIONS[ed.curveIdx].curve,
      maxLen: MAXLEN_OPTIONS[ed.maxLenIdx].seconds,
      bpm: ctx.bpm,
      snap: SNAP_OPTIONS[ed.snapIdx].snap,
      root: ctx.root,
      scale: ctx.scale,
      seed: randomSeed(),
    });
    this.writeVoiceFromEditor(li); // mints the sound id, captures the snapshot, resends, persists
    void this.normalizeVoice(li);  // re-level async; the pattern picks it up on the next trigger
  }

  /** Open the editing sheet for a voice (node k on line li) as a modal over the grid. */
  private openVoiceSheet(li: number, k: number): void {
    this.editNode[li] = Math.max(0, Math.min(k, this.arr.lines[li].nodes.length - 1));
    this.expanded = li; // keep the sequencer accordion in step if the user switches views
    this.sheetLine = li;
    this.render();
  }

  private closeVoiceSheet(): void {
    this.sheetLine = -1;
    this.render();
  }

  /** The voice sheet: a modal card in front of everything holding the tapped node's
      editor — a Transitions menu, its value circles, a Remove, any intro/outro fade
      editors, and the shuffle menu. Back returns to the grid. Appended to the root. */
  private renderVoiceSheet(): void {
    const li = this.sheetLine;
    const nodes = this.arr.lines[li].nodes;
    const node = this.node(li);

    const overlay = document.createElement("div");
    overlay.className = "voice-sheet-overlay";
    overlay.onclick = (e) => { if (e.target === overlay) this.closeVoiceSheet(); }; // tap backdrop = back

    const sheet = document.createElement("div");
    sheet.className = "voice-sheet";
    sheet.style.setProperty("--vc", node.soundId >= 0 ? node.color : "#4a4e58");

    // Header: Back to grid + the voice's generated name.
    const head = document.createElement("div");
    head.className = "voice-sheet-head";
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = "‹ Grid";
    back.onclick = () => this.closeVoiceSheet();
    const title = document.createElement("h2");
    title.className = "voice-sheet-title";
    title.textContent = node.name || `Voice ${li + 1}`;
    head.append(back, title);
    sheet.append(head);

    // Transitions (near the top): opens the placement menu — fade this sound at its
    // start (from the previous sound / silence) or its end (into the next / silence).
    const k = this.editNode[li];
    if (node.soundId >= 0) {
      const addTr = document.createElement("button");
      addTr.className = "sheet-add-transition";
      addTr.textContent = "✛ Transitions…";
      addTr.title = "Fade this sound in or out, or blend it with a neighbour";
      addTr.onclick = () => this.openTransitionMenu(li, k);
      sheet.append(addTr);
    }

    // Value circles (Hits/Steps/Start/Split/Reps/Bar) + Remove — right above the shuffle.
    const detail = document.createElement("div");
    detail.className = "euclid-detail";
    const rm = document.createElement("button");
    rm.className = "euclid-remove";
    rm.textContent = "×";
    rm.title = nodes.length > 1 ? "Remove this node" : "Clear this voice's sound";
    rm.onclick = () => { this.sheetLine = -1; this.removeNode(li); }; // removeNode re-renders
    detail.append(this.nodeValueCircles(li), rm);
    sheet.append(detail);

    // Existing fades: a labelled row per envelope with its style toggle and a Remove
    // (dropping a fade leaves the sound at its full length).
    const envRow = (side: "intro" | "outro") => {
      const env = side === "intro" ? node.intro : node.outro;
      if (!env) return;
      const kind = side === "intro" ? introKind((env as IntroEnv).fromId) : outroKind((env as OutroEnv).toId);
      const row = document.createElement("div");
      row.className = "sheet-env";
      const lbl = document.createElement("span");
      lbl.className = "sheet-env-label";
      lbl.textContent = kind === "in" ? "↗ Fade in" : kind === "out" ? "↘ Fade out"
        : side === "intro" ? "→ Blend in" : "→ Blend out";
      const del = document.createElement("button");
      del.className = "sheet-env-remove";
      del.textContent = "Remove";
      del.onclick = () => this.clearEnvelope(li, k, side);
      row.append(lbl, this.envModeToggle(node, side, true), del);
      sheet.append(row);
    };
    envRow("intro");
    envRow("outro");

    // The full shuffle menu, live. Keep the header name current as it shuffles
    // (writeVoiceFromEditor renames the node but doesn't re-render the sheet).
    const menu = buildVoiceShuffleMenu(this.voiceEditorFor(li), REF_DRUM, {
      onChange: async () => {
        await this.writeAndNormalizeVoice(li);
        title.textContent = this.node(li).name || `Voice ${li + 1}`;
      },
      audition: () => this.auditionVoice(li),
      onFullParams: () => { this.soundReturn = "loop"; this.soundLine = li; this.view = "sound"; this.render(); },
      context: () => this.shuffleContext(),
      mates: () => this.breedMates(li),
      report: (kind) => this.reportVoiceSound(li, kind),
    });
    sheet.append(menu);

    overlay.append(sheet);
    this.root.append(overlay);
  }

  // --- mixer view -------------------------------------------------------
  // One strip per LINE (whole node chain): a colour LED that flashes when any of
  // its nodes trigger, Mute/Solo for the line, and Volume/Reverb/Pan faders that
  // write into EVERY node's snapshot (so the chain moves as one instrument).
  private renderMixer(): void {
    const v = this.viewRoot;
    this.mixerLeds = new Map();

    const head = document.createElement("div");
    head.className = "mixer-head";
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = this.mixerReturn === "loop" ? "‹ Grid" : "‹ Sequencer";
    back.onclick = () => { this.view = this.mixerReturn; this.render(); };
    const title = document.createElement("h2");
    title.className = "mixer-title";
    title.textContent = "Mixer";
    head.append(back, title);
    v.append(head);

    const active = this.arr.lines.map((_, i) => i).filter((i) => this.arr.lines[i].nodes.some((n) => n.soundId >= 0));
    if (active.length === 0) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "No voices yet. Give the circles sounds in the sequencer, then mix them here.";
      v.append(hint);
      return;
    }

    const list = document.createElement("div");
    list.className = "mixer-list";
    active.forEach((li) => list.append(this.mixerStrip(li)));
    v.append(list);
  }

  /** A single mixer strip for one voice line. */
  private mixerStrip(li: number): HTMLElement {
    const line = this.arr.lines[li];
    const firstSound = line.nodes.find((n) => n.soundId >= 0);

    const strip = document.createElement("div");
    strip.className = "mix-strip";
    strip.style.setProperty("--lane", VOICE_COLORS[li]);

    // Header: flashing LED + name (any node of the line lights the LED).
    const hd = document.createElement("div");
    hd.className = "mix-strip-head";
    const led = document.createElement("span");
    led.className = "mix-led";
    for (const n of line.nodes) if (n.soundId >= 0) this.mixerLeds!.set(n.soundId, led);
    const name = document.createElement("span");
    name.className = "mix-name";
    name.textContent = firstSound?.name || `Voice ${li + 1}`;

    const toggles = document.createElement("div");
    toggles.className = "mix-toggles";
    const mute = document.createElement("button");
    mute.className = "mix-toggle mute" + (line.mute ? " on" : "");
    mute.textContent = "M";
    mute.title = "Mute this line";
    const solo = document.createElement("button");
    solo.className = "mix-toggle solo" + (line.solo ? " on" : "");
    solo.textContent = "S";
    solo.title = "Solo this line";
    mute.onclick = () => {
      line.mute = !line.mute;
      mute.classList.toggle("on", !!line.mute);
      this.pushSounds(); // mute/solo affect every line's audibility
      this.persist();
    };
    solo.onclick = () => {
      line.solo = !line.solo;
      solo.classList.toggle("on", !!line.solo);
      this.pushSounds();
      this.persist();
    };
    toggles.append(mute, solo);
    hd.append(led, name, toggles);
    strip.append(hd);

    // Faders: Volume + Reverb send (0..1) + Pan (-1..1) written into every node.
    strip.append(this.mixFader("Vol", li, ParamId.Volume));
    strip.append(this.mixFader("Verb", li, ParamId.ReverbMix));
    strip.append(this.mixFader("Pan", li, ParamId.Pan, -1, 1));
    return strip;
  }

  /** A labelled fader bound to one snapshot index of every node in a line. Shows the
      first assigned node's value; writing sets ALL nodes (padding short snapshots
      with param defaults first so no null "holes" get persisted). */
  private mixFader(label: string, li: number, id: ParamId, min = 0, max = 1): HTMLElement {
    const line = this.arr.lines[li];
    const first = line.nodes.find((n) => n.soundId >= 0);
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
    const show = (x: number) => {
      if (min >= 0) return `${Math.round(x * 100)}`;
      if (Math.abs(x) < 0.01) return "C";
      return `${x < 0 ? "L" : "R"}${Math.round(Math.abs(x) * 100)}`;
    };
    val.textContent = show(Number(slider.value));
    slider.oninput = () => {
      const x = Number(slider.value);
      for (const n of line.nodes) {
        if (n.soundId < 0) continue; // rests have no snapshot to move
        for (let i = n.snapshot.length; i < NUM_PARAMS; i++) n.snapshot[i] = baseSpec(i as ParamId).def;
        n.snapshot[id] = x;
      }
      val.textContent = show(x);
      this.pushSounds();
      this.persist();
    };
    row.append(lbl, slider, val);
    return row;
  }

  // --- sound view (full per-parameter editor for one node, live) -------
  private renderSound(): void {
    const v = this.viewRoot;
    const li = this.soundLine;
    const node = this.node(li);

    // Header: Back to wherever this editor was opened from (the sequencer, or the loop
    // view's voice sheet) + the node's current (auto-generated) name.
    const head = document.createElement("div");
    head.className = "mixer-head";
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = this.soundReturn === "loop" ? "‹ Grid" : "‹ Sequencer";
    back.onclick = () => { this.view = this.soundReturn; this.render(); };
    const title = document.createElement("h2");
    title.className = "mixer-title";
    title.textContent = node.name || `Voice ${li + 1}`;
    head.append(back, title);
    v.append(head);

    // The editor drives this node's own kit, so every change is live: writing it back
    // resends the sound table and the engine swaps it in on the node's next "on" step.
    const editor = this.voiceEditorFor(li);
    const sound = new SoundView(editor.kit, REF_DRUM, {
      onChange: () => this.writeVoiceFromEditor(li),
      onRangeChange: () => this.writeVoiceFromEditor(li),
      onAudition: () => this.auditionVoice(li),
      context: () => this.shuffleContext(),
    });
    v.append(sound.el);
  }
}
