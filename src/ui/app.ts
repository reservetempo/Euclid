// App shell: owns the engine + arrangement + UI state, and switches between the
// full-screen views. The arrangement is 6 voice LINES, each a chain of NODES
// (sound + Euclidean rhythm + bars) that play in order and loop independently —
// long-form polymeter with no global pattern switch (see src/model/lines.ts).
//
//   Sequencer view — the rings + one row per line. A row shows its line's node
//     being edited; tap it to expand the Hits/Steps/Start/Split/Bars circles, and
//     step along the chain with the —• (next/new node) and •— (previous node)
//     buttons. Tap the title of the expanded row to open its shuffle menu.
//   Loop view — the 6 node chains drawn as coloured lines of numbered circles
//     (the number = bars); tap a node to edit it in the sequencer.
//   Mixer — one strip per line (mute/solo/faders act on the whole chain).
//   Sound view — the deep per-parameter editor for one node.

import { EngineHost, EngineSound, Playhead } from "../audio/engineHost";
import { encodeWavFromBuffer } from "../audio/wav";
import { DRUMS, DrumType } from "../model/drums";
import { ParamId, NUM_PARAMS } from "../model/params";
import { baseSpec } from "../model/paramSpec";
import { DrumKit, estimateLength } from "../model/drumKit";
import { FULL_RANGE_PRESET } from "../model/presets";
import { serialize, deserialize, ProjectJSON } from "../model/project";
import {
  LineArrangement, VoiceNode, emptyNode, nodeLen, nodeBars,
  NUM_LINES, STEPS_PER_BAR, MAX_REPS, VOICE_COLORS,
} from "../model/lines";
import { clampSteps, MAX_STEPS, evenGap, maxSplitGap, voicePattern } from "../model/euclid";
import { EuclidView, RingState } from "./euclidView";
import { SoundView } from "./soundView";
import { buildVoiceShuffleMenu, VoiceEditor } from "./voiceShuffleMenu";
import { logoLetters } from "./logo";

const PROJECT_KEY = "msq010.project";

// Every node's inline shuffle editor drives a single-drum DrumKit; the reference drum
// only picks parameter specs — Full Range opens all ranges so any character is reachable.
const REF_DRUM = DrumType.Kick;

type View = "seq" | "loop" | "sound" | "mixer";

// The editable numeric fields of a node (its scrubbable number circles).
type NodeField = "hits" | "steps" | "rotation" | "split" | "reps";

export class App {
  private engine = new EngineHost();
  private arr = new LineArrangement();
  private kit = new DrumKit(DRUMS.map((d) => d.type)); // background editor kit (serialised)
  private drumTypes = DRUMS.map((d) => d.type);
  private saveTimer = 0;

  private view: View = "seq"; // the sequencer is the landing view
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
  private addingTransition = false; // loop view: picking a gap to insert a transition

  // Per-node inline shuffle editors, keyed by `${line}:${nodeIndex}`. Lazily created
  // when a node's shuffle menu first opens; cleared on new/load/node-removal
  // (rebuilt from the node's saved snapshot/ranges/preset).
  private voiceEditors = new Map<string, VoiceEditor>();

  private root: HTMLElement;
  private viewRoot!: HTMLElement;
  private euclidView = new EuclidView();
  private loopTimeEl: HTMLElement | null = null;
  // Loop view: per-line node dot elements, for the playing-node highlight.
  private nodeDotEls: HTMLElement[][] | null = null;
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

  // --- playhead ----------------------------------------------------------
  private handlePlayhead(p: Playhead): void {
    if (!p.lines) {
      this.refreshRings(); // stopped: rings back to the edited nodes
      if (this.nodeDotEls) this.nodeDotEls.forEach((els) => els.forEach((el) => el.classList.remove("playing")));
      return;
    }
    // Rings follow each line's LIVE node + step; a resting line falls back to its
    // edited node shown statically (no active step) so the ring stays populated.
    const states: RingState[] = this.arr.lines.map((ln, i) => {
      const st = p.lines![i];
      if (st && st.node >= 0) return { node: ln.nodes[st.node] ?? null, step: st.step };
      return { node: this.node(i), step: -1 };
    });
    this.euclidView.setRings(states);
    this.euclidView.pulse(p.fired);
    // Loop view: highlight each line's playing node.
    if (this.nodeDotEls) {
      this.nodeDotEls.forEach((els, li) => {
        const st = p.lines![li];
        els.forEach((el, k) => el.classList.toggle("playing", !!st && st.node === k));
      });
    }
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
      soloed-out LINES get Volume zeroed (mute/solo act per line). */
  private buildSounds(): EngineSound[] {
    const sounds: EngineSound[] = [];
    this.arr.lines.forEach((ln, li) => {
      const audible = this.lineAudible(li);
      for (const n of ln.nodes) {
        // Transitions have no snapshot of their own — the engine morphs their
        // neighbours (whose ids are already in the table), so skip them here.
        if (n.soundId < 0 || n.transition) continue;
        const snap = n.snapshot.slice();
        if (!audible) snap[ParamId.Volume] = 0;
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
    this.loopTimeEl.textContent =
      steps > 0 ? `${sec.toFixed(2)}s · ${Math.round(steps / STEPS_PER_BAR)} bars` : "empty";
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
    this.mixerLeds = null;
    this.voiceBtns = null;

    const bar = document.createElement("header");
    bar.className = "topbar";
    // The wordmark, drawn from the sequencer's dots and lines (see ui/logo.ts).
    const title = document.createElement("span");
    title.className = "app-title";
    title.append(...logoLetters(15, false));
    bar.append(title, this.transport(), this.menu());
    this.root.append(bar);

    this.viewRoot = document.createElement("main");
    this.viewRoot.className = "viewroot";
    this.root.append(this.viewRoot);

    if (this.view === "seq") this.renderSeq();
    else if (this.view === "loop") this.renderLoop();
    else if (this.view === "mixer") this.renderMixer();
    else this.renderSound();

    // Keep the section loop in step with what's on screen (the edit target).
    this.syncSection();
  }

  /** The node currently being edited (its shuffle menu / values are the focus): the
      expanded sequencer row, or the node the deep sound editor is on. null otherwise. */
  private currentEditTarget(): { line: number; node: number } | null {
    if (this.view === "sound") return { line: this.soundLine, node: this.editNode[this.soundLine] };
    if (this.view === "seq" && this.expanded >= 0) return { line: this.expanded, node: this.editNode[this.expanded] };
    return null;
  }

  /** While playing with an edit target, loop just that node's window of the loop so
      the edit is auditioned in context; otherwise play the whole loop. */
  private syncSection(): void {
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
    panel.append(
      mk("New project", () => { if (confirm("Clear everything and start fresh?")) this.newProject(); }),
      mk("Save to file", () => this.saveToFile()),
      mk("Load from file", () => fileInput.click()),
      mk("Export WAV", () => this.promptExportWav()),
    );

    btn.onclick = () => panel.classList.toggle("hidden");
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
    play.onclick = () => {
      this.playing = !this.playing;
      if (this.playing) { this.engine.play(); this.syncSection(); }
      else {
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

  // --- sequencer view ----------------------------------------------------
  private renderSeq(): void {
    const v = this.viewRoot;

    const wrap = document.createElement("div");
    wrap.className = "euclid-wrap";
    wrap.append(this.euclidView.canvas);
    v.append(wrap);
    v.append(this.linesMenu());
    v.append(this.seqActions());
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

      // Title: the node's sound (voice-coloured pill), a transition (from→to
      // gradient), or a wiggling die inviting a first shuffle. Tap = expand the row;
      // tap again (expanded, sounding node) = shuffle menu (transitions have none).
      const k = this.editNode[i];
      const sound = document.createElement("button");
      if (node.transition) {
        const fromC = nodes[k - 1]?.color ?? node.color;
        const toC = nodes[k + 1]?.color ?? node.color;
        sound.className = "euclid-sound transition";
        sound.style.background = `linear-gradient(90deg, ${fromC}, ${toC})`;
        sound.style.borderColor = toC;
        sound.style.color = "#15161a";
        sound.style.setProperty("--vc", toC);
        sound.textContent = "→ transition";
        this.voiceBtns.set(node.soundId, sound);
      } else if (node.soundId >= 0) {
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
        else if (!node.transition) this.openVoiceShuffleMenu(sound, i);
      };
      r.append(sound);

      if (isOpen) {
        // A hits/steps/start/split/reps circle: tap to type, or click-hold and drag
        // up/down to scrub. Drawn as the sequencer's own language — voice-coloured
        // circles joined by a line (see .euclid-vals in style.css).
        const mkNum = (label: string, value: number, field: NodeField, disabled = false) => {
          const cell = document.createElement("label");
          cell.className = "euclid-num";
          const lab = document.createElement("span");
          lab.textContent = label;
          const inp = document.createElement("input");
          inp.type = "number";
          inp.value = String(value);
          inp.min = "0";
          inp.inputMode = "numeric";
          inp.disabled = disabled;
          if (!disabled) {
            inp.onfocus = () => inp.select(); // one tap selects the value, ready to retype
            inp.onchange = () => { this.setNodeNum(i, field, Number(inp.value)); };
            this.attachDragScrub(inp, i, field);
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

        const vals = document.createElement("div");
        vals.className = "euclid-vals";
        vals.style.setProperty("--vc", (node.soundId >= 0 || node.transition) ? node.color : "#4a4e58");
        vals.append(hits, steps, start, split, reps);

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
      }

      // Node navigation, in the dots-and-lines language: •— = previous node,
      // —• = next node (creates a new one at the end of the chain).
      const nav = document.createElement("div");
      nav.className = "node-nav";
      nav.style.setProperty("--vc", node.soundId >= 0 ? node.color : "#9aa0aa");
      if (this.editNode[i] > 0) {
        const prev = document.createElement("button");
        prev.className = "node-nav-btn";
        prev.title = "Previous node";
        prev.append(this.nodeNavIcon(false));
        prev.onclick = () => { this.editNode[i]--; this.expanded = i; this.render(); };
        nav.append(prev);
      }
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
      nav.append(next);
      r.append(nav);

      wrap.append(r);
    }
    return wrap;
  }

  /** Row below the circle: Loop view + Mixer. */
  private seqActions(): HTMLElement {
    const row = document.createElement("div");
    row.className = "steps-actions";

    const loop = document.createElement("button");
    loop.className = "loop-view-btn";
    loop.textContent = "↻";
    loop.title = "Loop view — the node chains";
    loop.onclick = () => { this.view = "loop"; this.render(); };

    const mix = document.createElement("button");
    mix.className = "mixer-open-btn";
    mix.textContent = "🎚";
    mix.title = "Mixer";
    mix.setAttribute("aria-label", "Mixer");
    mix.onclick = () => { this.view = "mixer"; this.render(); };

    row.append(loop, mix);
    return row;
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
    else v.split = Math.max(1, Math.min(maxSplitGap(v.hits, v.steps), Math.round(n))); // primary gap
    // Cap hits at steps only once steps is set (a blank node defaults to 0 steps and
    // shouldn't swallow a hits value the user types first).
    if (v.steps >= 1 && v.hits > v.steps) v.hits = v.steps;
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
      A plain tap (no drag) falls through to the normal focus/type behaviour. */
  private attachDragScrub(input: HTMLInputElement, li: number, field: NodeField): void {
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
        : (v.split ?? evenGap(v.hits, v.steps));
      input.value = String(shown);
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { input.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (moved) this.render(); // rebuild so every row reflects the clamped values
    };
    input.addEventListener("pointerup", end);
    input.addEventListener("pointercancel", end);
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
      // Give a fresh node an audible default pattern so the shuffle can be heard.
      if (v.steps < 1) { v.steps = 8; v.hits = 4; v.rotation = 0; }
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

  /** Preview one node's current editor sound once (on the reserved audition channel). */
  private auditionVoice(li: number): void {
    const p = this.voiceEditorFor(li).kit.get(REF_DRUM);
    const snap = p.capture();
    this.engine.audition(snap, Math.round(this.engine.sampleRate * 0.4), estimateLength(snap, this.tempo));
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

  /** Inline shuffle menu for one line's edited node: generate/replace its sound live.
      Transitions have no sound of their own (they morph their neighbours), so there's
      nothing to shuffle. */
  private openVoiceShuffleMenu(anchor: HTMLElement, li: number): void {
    if (this.node(li).transition) return;
    const existing = this.viewRoot.querySelector(".voice-shuffle");
    if (existing) { existing.remove(); return; }
    const editor = this.voiceEditorFor(li);
    const openFull = () => {
      panel.remove();
      document.removeEventListener("pointerdown", close, true);
      this.soundLine = li;
      this.view = "sound";
      this.render();
    };
    const panel = buildVoiceShuffleMenu(editor, REF_DRUM, {
      onChange: () => this.writeVoiceFromEditor(li),
      audition: () => this.auditionVoice(li),
      onFullParams: openFull,
      context: () => this.shuffleContext(),
      mates: () => this.breedMates(li),
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
      on a clear so the line's timing holds. Any transition touching the removed node
      is dropped too (it has nothing left to morph). */
  private removeNode(li: number): void {
    const nodes = this.arr.lines[li].nodes;
    const k = this.editNode[li];
    if (nodes.length > 1) {
      const removedId = nodes[k].soundId;
      nodes.splice(k, 1);
      // Drop transitions orphaned by the removal (they referenced the gone sound, or
      // sat next to it and now bridge the wrong pair).
      for (let j = nodes.length - 1; j >= 0; j--) {
        const t = nodes[j].transition;
        if (t && (t.fromId === removedId || t.toId === removedId)) nodes.splice(j, 1);
      }
      if (nodes.length === 0) nodes.push(emptyNode());
      this.editNode[li] = Math.min(k, nodes.length - 1);
      // Node indices shifted — this line's cached editors are stale.
      for (const key of [...this.voiceEditors.keys()]) {
        if (key.startsWith(`${li}:`)) this.voiceEditors.delete(key);
      }
    } else {
      const v = nodes[0];
      if (v.soundId < 0 && !v.transition) return;
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

  /** Insert a transition node into line `li` at chain gap `gap` (between nodes
      gap-1 and gap), morphing the sound of the node before it into the node after.
      Both neighbours must be sounding (non-transition) nodes. */
  private insertTransition(li: number, gap: number): void {
    const nodes = this.arr.lines[li].nodes;
    const from = nodes[gap - 1];
    const to = nodes[gap];
    if (!from || !to || from.soundId < 0 || to.soundId < 0 || from.transition || to.transition) return;
    const tr = emptyNode();
    tr.soundId = this.nextSoundId++;      // its own channel id (no table entry needed)
    tr.transition = { fromId: from.soundId, toId: to.soundId };
    tr.color = to.color;                  // ring shows the destination colour
    tr.name = "→";
    // Inherit the "from" node's rhythm so the morph is heard on a familiar groove.
    tr.hits = from.hits; tr.steps = from.steps; tr.rotation = from.rotation; tr.split = from.split;
    tr.reps = 1;
    nodes.splice(gap, 0, tr);
    this.editNode[li] = gap;
    this.addingTransition = false;
    // Editors keyed by node index are now stale for this line.
    for (const key of [...this.voiceEditors.keys()]) {
      if (key.startsWith(`${li}:`)) this.voiceEditors.delete(key);
    }
    this.syncLines();
    this.render();
  }

  // --- loop view (the node chains) ----------------------------------------
  private renderLoop(): void {
    const v = this.viewRoot;
    this.nodeDotEls = [];

    const head = document.createElement("div");
    head.className = "mixer-head";
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = "‹ Sequencer";
    back.onclick = () => { this.view = "seq"; this.render(); };
    const title = document.createElement("h2");
    title.className = "mixer-title";
    title.textContent = "Loop";
    head.append(back, title);
    v.append(head);

    const loop = document.createElement("div");
    loop.className = "loop-time";
    const loopLabel = document.createElement("span");
    loopLabel.className = "loop-time-label";
    loopLabel.textContent = "Loop length";
    this.loopTimeEl = document.createElement("span");
    this.loopTimeEl.className = "loop-time-val";
    loop.append(loopLabel, this.loopTimeEl);
    v.append(loop);
    this.updateLoopTime();

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = this.addingTransition
      ? "Tap a ✛ between two sounds to morph one into the other."
      : "Each voice flows along its line of nodes (the number = bars). The loop is as long as the longest line; shorter lines rest until it comes round. Tap a node to edit it.";
    v.append(hint);

    // Add-transition toggle: in this mode a ✛ appears in each gap between two
    // adjacent sounding nodes; tapping it inserts a morph between them.
    const actions = document.createElement("div");
    actions.className = "steps-actions";
    const addTr = document.createElement("button");
    addTr.className = "add-transition-btn" + (this.addingTransition ? " on" : "");
    addTr.textContent = this.addingTransition ? "Cancel" : "✛ Add transition";
    addTr.onclick = () => { this.addingTransition = !this.addingTransition; this.render(); };
    actions.append(addTr);
    v.append(actions);

    // Format a node's length in bars (28 steps = 1.75), trimming trailing zeros.
    const barsLabel = (n: VoiceNode): string => {
      const b = nodeBars(n);
      return Number.isInteger(b) ? String(b) : String(+b.toFixed(2));
    };
    const sounding = (n: VoiceNode | undefined): boolean => !!n && n.soundId >= 0 && !n.transition;

    const list = document.createElement("div");
    list.className = "line-list";
    for (let li = 0; li < NUM_LINES; li++) {
      const nodes = this.arr.lines[li].nodes;
      const row = document.createElement("div");
      row.className = "line-row";
      row.style.setProperty("--vc", VOICE_COLORS[li]);

      const dots: HTMLElement[] = [];
      nodes.forEach((n, k) => {
        // A ✛ gap sits between two adjacent sounding nodes while adding a transition.
        if (this.addingTransition && k > 0 && sounding(nodes[k - 1]) && sounding(n)) {
          const gap = document.createElement("button");
          gap.className = "transition-gap";
          gap.textContent = "✛";
          gap.title = "Morph these two sounds";
          gap.onclick = () => this.insertTransition(li, k);
          row.append(gap);
        }
        const dot = document.createElement("button");
        dot.className = "node-dot"
          + (n.transition ? " transition" : n.soundId >= 0 ? " has-sound" : "")
          + (k === this.editNode[li] ? " editing" : "");
        if (n.transition) {
          const fromC = nodes[k - 1]?.color ?? n.color;
          const toC = nodes[k + 1]?.color ?? n.color;
          dot.style.background = `linear-gradient(90deg, ${fromC}, ${toC})`;
          dot.textContent = "→";
          dot.title = `transition · ${barsLabel(n)} bars`;
        } else {
          dot.textContent = barsLabel(n);
          dot.title = (n.soundId >= 0 ? (n.name || "node") : "rest") + ` · ${barsLabel(n)} bars`;
        }
        dot.onclick = () => {
          this.editNode[li] = k;
          this.expanded = li;
          this.view = "seq";
          this.render();
        };
        dots.push(dot);
        row.append(dot);
      });
      this.nodeDotEls.push(dots);

      // Trailing —• : grow this line with a fresh node.
      const add = document.createElement("button");
      add.className = "node-nav-btn node-add";
      add.title = "New node";
      add.append(this.nodeNavIcon(true));
      add.onclick = () => {
        nodes.push(emptyNode());
        this.editNode[li] = nodes.length - 1;
        this.syncLines();
        this.render();
      };
      row.append(add);

      list.append(row);
    }
    v.append(list);
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
    back.textContent = "‹ Sequencer";
    back.onclick = () => { this.view = "seq"; this.render(); };
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
    const firstSound = line.nodes.find((n) => n.soundId >= 0 && !n.transition);

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
    const first = line.nodes.find((n) => n.soundId >= 0 && !n.transition);
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
        if (n.soundId < 0 || n.transition) continue; // transitions morph their neighbours
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

    // Header: Back to the sequencer + the node's current (auto-generated) name.
    const head = document.createElement("div");
    head.className = "mixer-head";
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = "‹ Sequencer";
    back.onclick = () => { this.view = "seq"; this.render(); };
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
