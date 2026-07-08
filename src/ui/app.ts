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
} from "../model/lines";
import {
  Track, Loop, EveryRule, emptyLoop, loopToNode, randomSeed as newSeed,
} from "../model/track";
import { clampSteps, MAX_STEPS, evenGap, maxSplitGap } from "../model/euclid";
import { EuclidView, RingState } from "./euclidView";
import { SoundView, CURVE_OPTIONS, MAXLEN_OPTIONS, SNAP_OPTIONS, randomSeed } from "./soundView";
import { buildVoiceShuffleMenu, VoiceEditor } from "./voiceShuffleMenu";
import { logoLetters } from "./logo";

const PROJECT_KEY = "msq010.project";

// Every loop's inline shuffle editor drives a single-drum DrumKit; the reference drum
// only picks parameter specs — Full Range opens all ranges so any character is reachable.
const REF_DRUM = DrumType.Kick;

type View = "track" | "color" | "sound" | "mixer";

// The editable numeric fields of a loop's rhythm (its scrubbable number circles).
type RhythmField = "hits" | "steps" | "rotation" | "split";

export class App {
  private engine = new EngineHost();
  private arr = new LineArrangement();       // COMPILED lanes (engine source of truth)
  private track = new Track();               // the authoring model
  private kit = new DrumKit(DRUMS.map((d) => d.type)); // background editor kit (serialised)
  private drumTypes = DRUMS.map((d) => d.type);
  private saveTimer = 0;

  private view: View = "track";
  private openColor = 0;               // which colour panel is open
  private editLoop: Loop | null = null; // loop whose placement popup is open
  private soundLoop: Loop | null = null; // loop the deep sound view is editing
  private selectedDrum: DrumType = DrumType.Kick;
  private soundName = "";
  private playing = false;
  private tempo = 120;
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
    const ct = this.track.colors[c];
    if (!ct) return false;
    return !ct.mute && (!this.anySolo() || !!ct.solo);
  }

  // --- playhead ----------------------------------------------------------
  private handlePlayhead(p: Playhead): void {
    if (!p.lines) {
      this.refreshRings();
      return;
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
    this.view = "track";
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
    this.root.innerHTML = "";
    this.loopTimeEl = null;
    this.mixerLeds = null;
    this.voiceBtns = null;

    const bar = document.createElement("header");
    bar.className = "topbar";
    bar.append(this.topLeftControl(), this.transport(), this.menu());
    this.root.append(bar);

    this.viewRoot = document.createElement("main");
    this.viewRoot.className = "viewroot";
    this.root.append(this.viewRoot);

    if (this.view === "track") this.renderTrackPanel();
    else if (this.view === "color") this.renderColorPanel();
    else if (this.view === "mixer") this.renderMixer();
    else this.renderSound();

    this.updateLoopTime();
    if (!this.playing) this.refreshRings();

    // An open placement popup floats above everything (appended to root, so it survives
    // the panel re-render below it).
    if (this.view === "color" && this.editLoop) this.openPlacement(this.editLoop);
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
  private renderTrackPanel(): void {
    const v = this.viewRoot;
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

    // Whole-track overview: every colour's compiled lanes laid out across the full bar
    // limit (zoomed out — the entire loop at once). Tap a colour to open its loop list.
    this.voiceBtns = new Map();
    const overview = document.createElement("div");
    overview.className = "track-overview";
    overview.append(this.barRuler());
    for (let c = 0; c < NUM_LINES; c++) {
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

      // Lane timeline(s) for this colour — or one empty lane so the grid still reads.
      const lanes = this.colorLaneCoverage(c);
      const bars = Math.max(1, this.track.barLimit);
      const strip = document.createElement("div");
      strip.className = "track-color-lanes";
      if (lanes.length === 0) strip.append(this.laneCells(new Array(bars).fill(false)));
      else for (const lit of lanes) strip.append(this.laneCells(lit));
      row.append(strip);
      for (const l of ct.loops) if (l.soundId >= 0) this.voiceBtns.set(l.soundId, row);

      row.onclick = () => { this.openColor = c; this.view = "color"; this.editLoop = null; this.render(); };
      overview.append(row);
    }
    v.append(overview);
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
  }

  /** One row in a colour's loop list: priority reorder (solo), name + rule summary,
      remove. Tapping the row opens the placement popup. */
  private loopRow(loop: Loop, i: number): HTMLElement {
    const c = this.openColor;
    const loops = this.track.colors[c].loops;
    const row = document.createElement("div");
    row.className = "loop-row";
    row.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#4a4e58");

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

  /** Per-bar coverage of a colour's compiled lanes: one boolean[] per lane, `barLimit`
      wide, true where a sounding node spans that bar. */
  private colorLaneCoverage(c: number): boolean[][] {
    const bars = Math.max(1, this.track.barLimit);
    return this.arr.lines.filter((l) => l.color === c).map((lane) => {
      const lit = new Array(bars).fill(false);
      let bar = 0;
      for (const n of lane.nodes) {
        const span = (n.reps * (n.steps >= 1 ? n.steps : STEPS_PER_BAR)) / STEPS_PER_BAR;
        if (n.soundId >= 0) {
          for (let b = Math.floor(bar); b < Math.min(bars, Math.ceil(bar + span)); b++) lit[b] = true;
        }
        bar += span;
      }
      return lit;
    });
  }

  /** A row of `barLimit` timeline cells for one lane's coverage. */
  private laneCells(lit: boolean[]): HTMLElement {
    const row = document.createElement("div");
    row.className = "color-preview-lane";
    for (let b = 0; b < lit.length; b++) {
      const cell = document.createElement("span");
      cell.className = "color-preview-cell" + (lit[b] ? " on" : "");
      row.append(cell);
    }
    return row;
  }

  /** A read-only timeline of one colour's compiled lanes (used on the colour panel). */
  private colorPreview(c: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "color-preview";
    wrap.style.setProperty("--vc", VOICE_COLORS[c]);
    for (const lit of this.colorLaneCoverage(c)) wrap.append(this.laneCells(lit));
    return wrap;
  }

  /** A bar-number ruler aligned with the timeline cells (labels every 4 bars). */
  private barRuler(): HTMLElement {
    const bars = Math.max(1, this.track.barLimit);
    const row = document.createElement("div");
    row.className = "bar-ruler";
    for (let b = 0; b < bars; b++) {
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
    if (r.every.kind === "nth") every = r.every.n === 1 ? "every bar" : `every ${r.every.n} bars`;
    else if (r.every.kind === "pow2") every = "at 1,2,4,8…";
    else if (r.every.kind === "at") every = r.every.bars.length ? `at bars ${r.every.bars.join(",")}` : "no bars set";
    else every = `${Math.round(r.every.weight * 100)}% chance`;
    const forB = r.forBars === 1 ? "1 bar" : `${r.forBars} bars`;
    return `${every} · for ${forB} · ${r.mode}`;
  }

  private addLoop(c: number): void {
    const loop = emptyLoop(c, -1);
    this.track.colors[c].loops.push(loop);
    this.mintLoopSound(loop, c);
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

  /** The placement popup for `loop`: its Repeat-every rule, For-n-bars, overlap/solo,
      rhythm circles, and the shuffle menu for its sound. Rebuilt in place on any change
      (it's appended to the root, so it survives a panel re-render). */
  private openPlacement(loop: Loop): void {
    document.querySelector(".placement-overlay")?.remove();
    this.editLoop = loop;
    const rerender = () => this.openPlacement(loop);

    const overlay = document.createElement("div");
    overlay.className = "placement-overlay voice-sheet-overlay";
    overlay.onclick = (e) => { if (e.target === overlay) this.closePlacement(); };

    const sheet = document.createElement("div");
    sheet.className = "voice-sheet placement-sheet";
    sheet.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#4a4e58");

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

    sheet.append(this.placementControls(loop, rerender));

    // Rhythm circles (Hits/Steps/Start/Split) + the shuffle menu for the sound.
    const detail = document.createElement("div");
    detail.className = "euclid-detail";
    detail.append(this.rhythmCircles(loop, rerender));
    sheet.append(detail);

    const menu = buildVoiceShuffleMenu(this.voiceEditorFor(loop), REF_DRUM, {
      onChange: async () => {
        await this.writeAndNormalizeLoop(loop);
        title.textContent = loop.name || "Loop";
      },
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

    overlay.append(sheet);
    this.root.append(overlay);
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
        else r.every = { kind: "weight", weight: 0.5 };
        this.recompile();
        rerender();
      };
      return b;
    };
    seg.append(mkSeg("nth", "Nth bar"), mkSeg("pow2", "Powers of 2"), mkSeg("at", "At bars"), mkSeg("weight", "Chance"));
    everyRow.append(everyLbl, seg);
    wrap.append(everyRow);

    // Per-kind parameter.
    if (r.every.kind === "nth") {
      wrap.append(this.numRow("Every N bars", () => (r.every as { n: number }).n, (n) => {
        r.every = { kind: "nth", n: Math.max(1, Math.round(n)) };
        this.recompile();
      }, rerender, () => `${(r.every as { n: number }).n}`));
    } else if (r.every.kind === "at") {
      // Manual bar list: a free-text field (comma/space separated, 1-indexed).
      const row = document.createElement("div");
      row.className = "placement-row placement-atbars";
      const lbl = document.createElement("span");
      lbl.className = "placement-lbl";
      lbl.textContent = "Bars";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.inputMode = "numeric";
      inp.placeholder = "e.g. 1, 5, 9";
      inp.value = (r.every as { bars: number[] }).bars.join(", ");
      const parse = () => {
        const bars = (inp.value.match(/\d+/g) ?? []).map((s) => parseInt(s, 10)).filter((n) => n >= 1);
        r.every = { kind: "at", bars };
        this.recompile();
      };
      inp.oninput = parse; // recompile live; no re-render so the field keeps focus
      row.append(lbl, inp);
      wrap.append(row);
    } else if (r.every.kind === "weight") {
      const chanceRow = this.numRow("Chance %", () => Math.round((r.every as { weight: number }).weight * 100), (n) => {
        r.every = { kind: "weight", weight: Math.max(0, Math.min(1, Math.round(n) / 100)) };
        this.recompile();
      }, rerender, () => `${Math.round((r.every as { weight: number }).weight * 100)}%`);
      // Re-roll / Back for the seeded roll.
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
      wrap.append(chanceRow, rollRow);
    }

    // For: n bars.
    wrap.append(this.numRow("For (bars)", () => r.forBars, (n) => {
      r.forBars = Math.max(1, Math.round(n));
      this.recompile();
    }, rerender, () => `${r.forBars}`));

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

  /** A labelled scrub/numpad row inside the placement popup. */
  private numRow(label: string, read: () => number, write: (n: number) => void, commit: () => void, show: () => string): HTMLElement {
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
    this.attachScrub(inp, { label, read, write, show, commit });
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
    vals.style.setProperty("--vc", loop.soundId >= 0 ? loop.color : "#4a4e58");
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
    ed = { kit, randomness: 1.0, curveIdx: 1, maxLenIdx: 0, snapIdx: 0, seedText: "", lastSeed: "" };
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
  private mintLoopSound(loop: Loop, c: number): void {
    const ed = this.voiceEditorFor(loop);
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
    void c;
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
  }): void {
    const PX_PER_STEP = 7;
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
      opts.write(startVal + delta);
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

  private openNumpad(opts: { title: string; value: number; color?: string; onSubmit: (n: number) => void }): void {
    document.querySelector(".numpad-overlay")?.remove();
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
    if (active.length === 0) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "No loops yet. Add loops to the colours, then mix them here.";
      v.append(hint);
      return;
    }
    const list = document.createElement("div");
    list.className = "mixer-list";
    active.forEach((c) => list.append(this.mixerStrip(c)));
    v.append(list);
  }

  /** A single mixer strip for one colour (all its loops move together). */
  private mixerStrip(c: number): HTMLElement {
    const ct = this.track.colors[c];
    const sounds = ct.loops.filter((l) => l.soundId >= 0);
    const first = sounds[0];

    const strip = document.createElement("div");
    strip.className = "mix-strip";
    strip.style.setProperty("--lane", VOICE_COLORS[c]);

    const hd = document.createElement("div");
    hd.className = "mix-strip-head";
    const led = document.createElement("span");
    led.className = "mix-led";
    for (const l of sounds) this.mixerLeds!.set(l.soundId, led);
    const name = document.createElement("span");
    name.className = "mix-name";
    name.textContent = `Voice ${c + 1}`;

    const toggles = document.createElement("div");
    toggles.className = "mix-toggles";
    const mute = document.createElement("button");
    mute.className = "mix-toggle mute" + (ct.mute ? " on" : "");
    mute.textContent = "M";
    mute.title = "Mute this colour";
    const solo = document.createElement("button");
    solo.className = "mix-toggle solo" + (ct.solo ? " on" : "");
    solo.textContent = "S";
    solo.title = "Solo this colour";
    mute.onclick = () => { ct.mute = !ct.mute; mute.classList.toggle("on", !!ct.mute); this.pushSounds(); this.persist(); };
    solo.onclick = () => { ct.solo = !ct.solo; solo.classList.toggle("on", !!ct.solo); this.pushSounds(); this.persist(); };
    toggles.append(mute, solo);
    hd.append(led, name, toggles);
    strip.append(hd);

    strip.append(this.mixFader("Vol", c, ParamId.Volume));
    strip.append(this.mixFader("Verb", c, ParamId.ReverbMix));
    strip.append(this.mixFader("Pan", c, ParamId.Pan, -1, 1));
    void first;
    return strip;
  }

  /** A labelled fader bound to one snapshot index of every loop in a colour. */
  private mixFader(label: string, c: number, id: ParamId, min = 0, max = 1): HTMLElement {
    const sounds = this.track.colors[c].loops.filter((l) => l.soundId >= 0);
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
    back.onclick = () => {
      this.view = this.soundReturn;
      if (this.soundReturn === "color" && this.editLoop) { /* popup reopens via render */ }
      this.render();
    };
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
