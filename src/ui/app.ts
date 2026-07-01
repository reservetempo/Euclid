// App shell: owns the engine + pattern + UI state, and switches between the two
// full-screen views (Steps / Sound). Within Steps you pick a workspace from the
// numbered pattern buttons: one of the six 16-step patterns (drawn as two stacked
// 8-wide grids), or the "Loop" view (20-slot order list) that sequences which
// patterns play and in what order. Painted lanes are added from saved sounds.

import { EngineHost, Playhead } from "../audio/engineHost";
import { DRUMS, DrumType, drumColour } from "../model/drums";
import { ParamId } from "../model/params";
import { DrumKit, estimateLength } from "../model/drumKit";
import { FULL_RANGE_PRESET } from "../model/presets";
import { SoundLibrary, SavedSound } from "../model/soundLibrary";
import { serialize, deserialize, ProjectJSON } from "../model/project";
import {
  WipArrangement, NUM_BLOCKS, NUM_ROWS, NUM_STEPS, ORDER_SLOTS, EMPTY, GRID_COLORS,
} from "../model/melodyGrid";
import { ALL_ROOTS, ALL_SCALES } from "../model/melodyScale";
import { RHYTHMS, Rhythm } from "../model/rhythms";
import { EUCLID_VOICES, clampSteps, MAX_STEPS, VOICE_DEFAULT } from "../model/euclid";
import { GridView } from "./gridView";
import { EuclidView } from "./euclidView";
import { SoundView } from "./soundView";

// A paint lane added from the saved-sound library. Each lane has a stable `soundId`
// (what grid cells reference); the engine binds ids to physical channels on demand
// (see engine.js allocate). Plus its own identity colour and Pitch range.
interface Lane {
  soundId: number; // stable id grid cells point at (engine maps it to a channel)
  name: string;
  snapshot: number[];
  color: string;
  pitch: [number, number]; // Pitch range for melody mapping
  mute?: boolean; // mixer: silenced
  solo?: boolean; // mixer: when any lane is soloed, only soloed lanes are audible
}

// What the mixer strips, faders and mute/solo logic operate on. Both a paint Lane and
// a Euclidean voice satisfy this, so a Euclidean grid mixes its voices the same way a
// manual grid mixes its lanes.
interface MixChannel {
  soundId: number;
  name: string;
  snapshot: number[];
  color: string;
  mute?: boolean;
  solo?: boolean;
}

const PROJECT_KEY = "msq010.project";
const ORDER_VIEW = NUM_BLOCKS; // workspace value for the order list

type View = "grid" | "sound" | "mixer";

export class App {
  private engine = new EngineHost();
  private arr = new WipArrangement();
  private kit = new DrumKit(DRUMS.map((d) => d.type)); // editable per-drum params
  private library = new SoundLibrary();
  private drumTypes = DRUMS.map((d) => d.type);
  private saveTimer = 0;

  private view: View = "sound"; // Sounds is the landing view
  private selectedDrum: DrumType = DrumType.Kick; // voice edited in the Sounds view
  private soundName = ""; // last used sound name (prefills the Save dialog)
  private workspace = 0; // 0..5 = pattern index, ORDER_VIEW = loop/order list
  private orderBrush = 0; // which pattern (colour) the order grid places
  private playing = false;
  private tempo = 120;

  // Paint lanes per grid: each numbered grid has its OWN sounds. The + button adds
  // saved sounds to the current grid. allLanes() spans every grid (engine pushes +
  // channel allocation); `lanes`/`activeLane` below address the current grid.
  private lanesPerBlock: Lane[][] = Array.from({ length: NUM_BLOCKS }, () => []);
  private activeLanePerBlock: number[] = new Array(NUM_BLOCKS).fill(-1);
  private nextSoundId = 0; // monotonic id for new lanes (cells reference these)

  private root: HTMLElement;
  private viewRoot!: HTMLElement;
  private gridView = new GridView(this.arr.blocks[0]);
  private euclidView = new EuclidView(this.arr.blocks[0]);
  private loopTimeEl: HTMLElement | null = null;
  private orderSlotEls: HTMLElement[] | null = null;
  // Channel -> flash LED, populated while the Mixer view is shown.
  private mixerLeds: Map<number, HTMLElement> | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.gridView.onEdit = () => this.syncPattern();
    this.engine.onPlayhead = (p) => this.handlePlayhead(p);
    // Resume audio after iOS/tab interruptions.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.engine.resume();
    });
    this.renderStart();
  }

  private handlePlayhead(p: Playhead): void {
    const onCurrent = this.workspace < NUM_BLOCKS && p.grid === this.workspace;
    const step = onCurrent ? p.col : -1; // p.col is the grid-local step (manual or Euclidean)
    const blk = this.workspace < NUM_BLOCKS ? this.arr.blocks[this.workspace] : null;
    if (blk && blk.euclid) this.euclidView.setPlayhead(step);
    else this.gridView.setPlayhead(step);
    if (this.orderSlotEls) {
      this.orderSlotEls.forEach((el, i) => el.classList.toggle("playing", i === p.slot));
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
  }

  // --- engine sync ------------------------------------------------------
  private pushAll(): void {
    this.pushSounds();
    this.syncPattern();
    this.engine.setTempo(this.tempo);
  }

  /** Replace the engine's sound table with every painted lane: stable id + snapshot +
      Pitch range (for the key mapping) + estimated tail (for channel stealing).
      Muted / soloed-out lanes get Volume zeroed. The engine binds ids to channels. */
  private pushSounds(): void {
    const sounds = this.allLanes().map((lane) => {
      const snap = lane.snapshot.slice();
      if (!this.channelAudible(lane)) snap[ParamId.Volume] = 0;
      return { id: lane.soundId, snap, lo: lane.pitch[0], hi: lane.pitch[1], tail: estimateLength(snap) };
    });
    // Euclidean voices across every grid are sounds too — same mute/solo handling.
    for (const blk of this.arr.blocks) {
      if (!blk.euclid) continue;
      for (const v of blk.voices) {
        if (v.soundId < 0) continue;
        const snap = v.snapshot.slice();
        if (!this.channelAudible(v)) snap[ParamId.Volume] = 0;
        sounds.push({ id: v.soundId, snap, lo: v.pitch[0], hi: v.pitch[1], tail: estimateLength(snap) });
      }
    }
    this.engine.setSounds(sounds);
  }

  /** Every mixable channel: each grid's paint lanes plus every assigned Euclidean voice. */
  private allMixChannels(): MixChannel[] {
    const out: MixChannel[] = [...this.allLanes()];
    for (const blk of this.arr.blocks) {
      if (!blk.euclid) continue;
      for (const v of blk.voices) if (v.soundId >= 0) out.push(v);
    }
    return out;
  }

  /** True while at least one channel is soloed (so the rest are silenced). */
  private anySolo(): boolean {
    return this.allMixChannels().some((c) => c.solo);
  }

  /** A channel is heard unless it's muted or another channel has stolen solo. */
  private channelAudible(ch: MixChannel): boolean {
    return !ch.mute && (!this.anySolo() || !!ch.solo);
  }

  /** Resend grids + order. While playing the engine stages this and applies it
      at the next loop restart, so the current pass plays unchanged. */
  private syncPattern(): void {
    this.engine.setPattern(this.arr.blocksMessage(), this.arr.orderArray());
    this.updateLoopTime();
    this.persist();
  }

  private updateLoopTime(): void {
    if (!this.loopTimeEl) return;
    const steps = this.arr.loopSteps();
    const sec = (steps * 60) / Math.max(1, this.tempo) / 4; // 16th notes
    this.loopTimeEl.textContent = steps > 0 ? `${sec.toFixed(2)}s · ${steps} steps` : "empty";
  }

  // --- persistence ------------------------------------------------------
  private persist(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        const json = serialize(this.arr, this.kit, this.tempo, this.drumTypes, this.lanesPerBlock, this.soundName);
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
      this.tempo = deserialize(json, this.arr, this.kit, this.drumTypes, this.lanesPerBlock);
      this.soundName = json.soundName ?? this.soundName;
      this.resetActiveLanes();
      return true;
    } catch {
      return false; // ignore corrupt storage
    }
  }

  private saveToFile(): void {
    const json = serialize(this.arr, this.kit, this.tempo, this.drumTypes, this.lanesPerBlock, this.soundName);
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "msq010-project.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  private loadFromFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(String(reader.result)) as ProjectJSON;
        this.tempo = deserialize(json, this.arr, this.kit, this.drumTypes, this.lanesPerBlock);
        this.soundName = json.soundName ?? "";
        this.resetActiveLanes();
        this.afterProjectChange();
      } catch {
        alert("Could not load that file.");
      }
    };
    reader.readAsText(file);
  }

  private newProject(): void {
    this.arr = new WipArrangement();
    this.kit = new DrumKit(this.drumTypes);
    this.applyRandomDefault(); // default editor sound: random Full Range
    this.tempo = 120;
    for (const list of this.lanesPerBlock) list.length = 0;
    this.activeLanePerBlock.fill(-1);
    this.nextSoundId = 0;
    this.afterProjectChange();
  }

  /** After load/new: select each grid's first lane (or none if empty), and bump the
      id counter past every loaded sound id so new lanes never collide with cells. */
  private resetActiveLanes(): void {
    let maxId = -1;
    for (const lane of this.allLanes()) if (lane.soundId > maxId) maxId = lane.soundId;
    this.nextSoundId = maxId + 1;
    for (let b = 0; b < NUM_BLOCKS; b++) {
      this.activeLanePerBlock[b] = this.lanesPerBlock[b].length ? 0 : -1;
    }
  }

  private afterProjectChange(): void {
    if (this.playing) { this.playing = false; this.engine.stop(); }
    const gi = this.workspace < NUM_BLOCKS ? this.workspace : 0;
    this.gridView = new GridView(this.arr.blocks[gi]);
    this.gridView.onEdit = () => this.syncPattern();
    this.pushAll();
    this.render();
  }

  private audition(drum: DrumType): void {
    const gate = Math.round(this.engine.sampleRate * 0.4);
    const snap = this.kit.get(drum).capture();
    this.engine.audition(snap, gate, estimateLength(snap));
  }

  /** Preview a lane once (on the reserved audition channel). */
  private auditionLane(lane: Lane): void {
    const gate = Math.round(this.engine.sampleRate * 0.4);
    this.engine.audition(lane.snapshot, gate, estimateLength(lane.snapshot));
  }

  /** The editor's default sound: Full Range, fully shuffled so it's random and
      different every time, with no carried-over name. */
  private applyRandomDefault(): void {
    this.kit.applyPreset(this.selectedDrum, FULL_RANGE_PRESET);
    this.kit.shuffleAll(this.selectedDrum, 1.0); // 100% -> uniform over the full range
    this.soundName = "";
  }

  /** After saving a sound: drop back to a fresh random Full Range sound. */
  private revertEditorToDefault(): void {
    this.applyRandomDefault();
    this.audition(this.selectedDrum); // editor sound is auditioned, not in the table
    this.persist();
    this.render();
  }

  // --- start gate -------------------------------------------------------
  private renderStart(): void {
    this.root.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "start-screen";
    const h = document.createElement("h1");
    h.textContent = "Euclid";
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
    this.orderSlotEls = null;
    this.mixerLeds = null;

    const bar = document.createElement("header");
    bar.className = "topbar";
    bar.append(this.viewToggle(), this.transport(), this.menu());
    this.root.append(bar);

    this.viewRoot = document.createElement("main");
    this.viewRoot.className = "viewroot";
    this.root.append(this.viewRoot);

    if (this.view === "grid") this.renderGrid();
    else if (this.view === "mixer") this.renderMixer();
    else this.renderSound();
  }

  private viewToggle(): HTMLElement {
    const seg = document.createElement("div");
    seg.className = "seg";
    for (const v of ["grid", "sound"] as View[]) {
      const b = document.createElement("button");
      b.textContent = v === "grid" ? "Steps" : "Sounds";
      // The Mixer is a sub-view of Steps, so it keeps the Steps segment lit.
      const active = v === "grid" ? this.view !== "sound" : this.view === "sound";
      b.className = "seg-btn" + (active ? " on" : "");
      b.onclick = () => {
        if (this.view === v) return;
        this.view = v;
        this.render();
      };
      seg.append(b);
    }
    return seg;
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
    play.textContent = this.playing ? "■" : "▶";
    play.onclick = () => {
      this.playing = !this.playing;
      if (this.playing) this.engine.play();
      else {
        this.engine.stop();
        this.gridView.setPlayhead(-1);
        this.euclidView.setPlayhead(-1);
      }
      play.textContent = this.playing ? "■" : "▶";
    };

    const tempo = document.createElement("input");
    tempo.type = "range";
    tempo.min = "60";
    tempo.max = "200";
    tempo.value = String(this.tempo);
    tempo.className = "tempo";
    const label = document.createElement("span");
    label.className = "tempo-label";
    label.textContent = `${this.tempo}`;
    tempo.oninput = () => {
      this.tempo = Number(tempo.value);
      this.engine.setTempo(this.tempo);
      label.textContent = `${this.tempo}`;
      this.updateLoopTime();
      this.persist();
    };

    t.append(play, tempo, label);
    return t;
  }

  // --- steps view -------------------------------------------------------
  private renderGrid(): void {
    const v = this.viewRoot;
    v.append(this.patternBar());

    if (this.workspace === ORDER_VIEW) {
      v.append(this.renderOrderEditor());
    } else {
      const blk = this.arr.blocks[this.workspace];

      if (blk.euclid) {
        // Euclidean mode: circle visualization + the 5-voice menu (no cell grid).
        this.euclidView.setBlock(blk);
        const wrap = document.createElement("div");
        wrap.className = "euclid-wrap";
        wrap.append(this.euclidView.canvas);
        v.append(wrap);
        v.append(this.euclidMenu());
        v.append(this.stepsActions());
        // viewRoot is already in the DOM, so size synchronously (reads real width),
        // and again on the next frame as a fallback for first-paint width.
        this.euclidView.layout();
        requestAnimationFrame(() => this.euclidView.layout());
      } else {
        const gridWrap = document.createElement("div");
        gridWrap.className = "grid-wrap";
        this.gridView.setBlock(blk);
        this.gridView.setActiveDrum(this.activeDrumForPaint());
        // Colour painted cells by the lane that owns that channel (any grid).
        this.gridView.colorForDrum = (id) => this.allLanes().find((l) => l.soundId === id)?.color ?? drumColour(id);
        gridWrap.append(this.gridView.canvas);
        v.append(gridWrap);

        v.append(this.scaleControls());
        v.append(this.stepsActions());
        v.append(this.laneSelector());

        requestAnimationFrame(() => this.gridView.layout());
      }

      v.append(this.modeToggle()); // Manual / Euclid switch lives at the bottom of the page
    }

    this.updateLoopTime();
  }

  /** Manual / Euclidean mode toggle for the current grid. */
  private modeToggle(): HTMLElement {
    const blk = this.arr.blocks[this.curBlock()];
    const row = document.createElement("div");
    row.className = "mode-toggle";
    (["Manual", "Euclid"] as const).forEach((label, i) => {
      const isEuclid = i === 1;
      const b = document.createElement("button");
      b.className = "mode-btn" + (blk.euclid === isEuclid ? " on" : "");
      b.textContent = label;
      b.onclick = () => {
        if (blk.euclid === isEuclid) return;
        blk.euclid = isEuclid;
        this.pushSounds(); // euclid voices enter/leave the sound table
        this.syncPattern();
        this.render();
      };
      row.append(b);
    });
    return row;
  }

  /** The 5-voice Euclidean menu: each row assigns a saved sound + hits/steps/start. */
  private euclidMenu(): HTMLElement {
    const blk = this.arr.blocks[this.curBlock()];
    const wrap = document.createElement("div");
    wrap.className = "euclid-menu";

    for (let i = 0; i < EUCLID_VOICES; i++) {
      const voice = blk.voices[i];
      const r = document.createElement("div");
      r.className = "euclid-row";

      // Sound assignment (reuses the saved-sound picker).
      const sound = document.createElement("button");
      sound.className = "euclid-sound" + (voice.soundId >= 0 ? " has-sound" : "");
      if (voice.soundId >= 0) {
        const sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = voice.color;
        sound.append(sw, document.createTextNode(voice.name || `Voice ${i + 1}`));
      } else {
        sound.textContent = `+ Voice ${i + 1}`;
      }
      sound.onclick = () => this.openEuclidSoundPicker(sound, i);

      const mkNum = (label: string, value: number, onSet: (n: number) => void) => {
        const cell = document.createElement("label");
        cell.className = "euclid-num";
        const lab = document.createElement("span");
        lab.textContent = label;
        const inp = document.createElement("input");
        inp.type = "number";
        inp.value = String(value);
        inp.min = "0";
        inp.inputMode = "numeric";
        inp.onfocus = () => inp.select(); // one tap selects the value, ready to retype
        inp.onchange = () => { onSet(Number(inp.value)); };
        cell.append(lab, inp);
        return cell;
      };

      const hits = mkNum("Hits", voice.hits, (n) => this.setEuclidNum(i, "hits", n));
      const steps = mkNum("Steps", voice.steps, (n) => this.setEuclidNum(i, "steps", n));
      const start = mkNum("Start", voice.rotation, (n) => this.setEuclidNum(i, "rotation", n));

      r.append(sound, hits, steps, start);

      // Remove button: clears the assigned sound from this slot (only shown when filled).
      if (voice.soundId >= 0) {
        const rm = document.createElement("button");
        rm.className = "euclid-remove";
        rm.textContent = "×";
        rm.title = "Remove this sound";
        rm.onclick = () => this.clearEuclidVoice(i);
        r.append(rm);
      }

      wrap.append(r);
    }
    return wrap;
  }

  /** Update a Euclidean voice's hits/steps/rotation (clamped), then resync + redraw. */
  private setEuclidNum(slot: number, field: "hits" | "steps" | "rotation", n: number): void {
    const v = this.arr.blocks[this.curBlock()].voices[slot];
    if (Number.isNaN(n)) n = 0;
    if (field === "steps") v.steps = clampSteps(n);
    else if (field === "hits") v.hits = Math.max(0, Math.min(MAX_STEPS, Math.round(n)));
    else v.rotation = Math.round(n);
    // Cap hits at steps only once steps is set (a blank voice defaults to 0 steps and
    // shouldn't swallow a hits value the user types first).
    if (v.steps >= 1 && v.hits > v.steps) v.hits = v.steps;
    this.syncPattern();
    this.euclidView.draw();
    this.updateLoopTime();
    this.render(); // reflect clamped values in the inputs
  }

  /** Saved-sound picker for one Euclidean voice slot. */
  private openEuclidSoundPicker(anchor: HTMLElement, slot: number): void {
    const existing = this.viewRoot.querySelector(".sound-picker");
    if (existing) { existing.remove(); return; }
    const panel = this.buildSoundList((s) => {
      panel.remove();
      const v = this.arr.blocks[this.curBlock()].voices[slot];
      if (v.soundId < 0) {
        // Fresh assignment: start the circle blank (all zero) so the user dials in the
        // pattern (also resets older saves whose empty voices held a legacy default).
        v.soundId = this.nextSoundId++;
        v.hits = VOICE_DEFAULT.hits; v.steps = VOICE_DEFAULT.steps; v.rotation = VOICE_DEFAULT.rotation;
      }
      v.snapshot = s.snapshot.slice();
      v.color = s.color;
      v.name = s.name;
      v.pitch = [s.pitch[0], s.pitch[1]];
      this.pushSounds();
      this.syncPattern();
      this.engine.audition(v.snapshot, Math.round(this.engine.sampleRate * 0.4), estimateLength(v.snapshot));
      this.render();
    });
    anchor.parentElement?.append(panel);
    const close = (ev: PointerEvent) => {
      if (!panel.contains(ev.target as Node) && ev.target !== anchor) {
        panel.remove();
        document.removeEventListener("pointerdown", close, true);
      }
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  }

  /** Empty a Euclidean voice slot: drop its sound and reset the circle to blank (all
      zero), then resync the engine + persist. */
  private clearEuclidVoice(slot: number): void {
    const v = this.arr.blocks[this.curBlock()].voices[slot];
    if (v.soundId < 0) return;
    v.soundId = EMPTY;
    v.snapshot = [];
    v.color = "#888888";
    v.name = "";
    v.pitch = [60, 1000];
    v.hits = VOICE_DEFAULT.hits; v.steps = VOICE_DEFAULT.steps; v.rotation = VOICE_DEFAULT.rotation;
    v.mute = false; v.solo = false;
    this.pushSounds(); // drop the removed voice from the engine sound table
    this.syncPattern();
    this.euclidView.draw();
    this.render();
  }

  /** Numbered pattern buttons (replacing the old dropdown) + the Loop view button. */
  private patternBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "pattern-bar";

    for (let i = 0; i < NUM_BLOCKS; i++) {
      const b = document.createElement("button");
      b.className = "pat-btn" + (this.workspace === i ? " on" : "");
      b.textContent = String(i + 1);
      b.style.setProperty("--pat", GRID_COLORS[i]);
      b.onclick = () => { this.workspace = i; this.render(); };
      bar.append(b);
    }

    const loop = document.createElement("button");
    loop.className = "loop-view-btn" + (this.workspace === ORDER_VIEW ? " on" : "");
    loop.textContent = "↻";
    loop.title = "Loop / order view";
    loop.onclick = () => { this.workspace = ORDER_VIEW; this.render(); };
    bar.append(loop);

    return bar;
  }

  /** Key on/off toggle + Root + Scale pickers, shown below both stacked grids.
      When the key is off the row->note mapping is bypassed (each cell plays its
      saved sound as-is) and the Root/Scale pickers are hidden. */
  private scaleControls(): HTMLElement {
    const blk = this.arr.blocks[this.workspace];
    const row = document.createElement("div");
    row.className = "scale-ctl";

    const keyToggle = document.createElement("button");
    keyToggle.className = "key-toggle" + (blk.keyEnabled ? " on" : "");
    keyToggle.textContent = blk.keyEnabled ? "Key: On" : "Key: Off";
    keyToggle.title = "Turn the key/scale mapping on or off for this pattern";
    keyToggle.onclick = () => {
      blk.keyEnabled = !blk.keyEnabled;
      // Turning the key on targets the grid's current sounds by default; tap a sound's
      // key badge in the lane bar to include/exclude individual ones.
      if (blk.keyEnabled) {
        blk.keyedDrums.clear();
        for (const lane of this.lanes) blk.keyedDrums.add(lane.soundId);
      }
      this.gridView.draw();
      this.syncPattern();
      this.render(); // show/hide the Root + Scale pickers + lane key badges
    };
    row.append(labelled("Key", keyToggle));

    if (!blk.keyEnabled) return row; // no key -> hide the Root/Scale pickers

    const rootSel = document.createElement("select");
    ALL_ROOTS.forEach((name, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = name;
      rootSel.append(o);
    });
    rootSel.value = String(blk.root);
    rootSel.onchange = () => {
      blk.setRoot(Number(rootSel.value));
      this.gridView.draw();
      this.syncPattern();
    };

    const scaleSel = document.createElement("select");
    ALL_SCALES.forEach((name, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = name;
      scaleSel.append(o);
    });
    scaleSel.value = String(blk.scale);
    scaleSel.onchange = () => {
      blk.scale = Number(scaleSel.value);
      this.gridView.draw();
      this.syncPattern();
    };

    row.append(labelled("Root", rootSel), labelled("Scale", scaleSel));
    return row;
  }

  /** Row below the scale controls: open the Mixer or the preset-Rhythms picker. */
  private stepsActions(): HTMLElement {
    const row = document.createElement("div");
    row.className = "steps-actions";

    const mix = document.createElement("button");
    mix.className = "mixer-open-btn";
    mix.textContent = "🎚 Mixer";
    mix.onclick = () => { this.view = "mixer"; this.render(); };

    const rhythms = document.createElement("button");
    rhythms.className = "mixer-open-btn rhythms-open-btn";
    rhythms.textContent = "🥁 Rhythms";
    rhythms.onclick = () => this.openRhythmPanel();

    row.append(mix, rhythms);
    return row;
  }

  /** Modal: pick a preset rhythm, assign a saved sound to each track, then lay it
      onto the current grid (each track on its own empty row; layered on top). */
  private openRhythmPanel(): void {
    const overlay = document.createElement("div");
    overlay.className = "rhythm-overlay";
    const modal = document.createElement("div");
    modal.className = "rhythm-modal";
    overlay.append(modal);
    const close = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    let selected: Rhythm | null = null;
    const assigned = new Map<string, SavedSound>(); // track name -> sound

    const header = (title: string, onBack?: () => void) => {
      const h = document.createElement("div");
      h.className = "rhythm-head";
      if (onBack) {
        const back = document.createElement("button");
        back.className = "rhythm-back";
        back.textContent = "‹";
        back.onclick = onBack;
        h.append(back);
      }
      const t = document.createElement("span");
      t.className = "rhythm-title";
      t.textContent = title;
      const x = document.createElement("button");
      x.className = "rhythm-close";
      x.textContent = "×";
      x.onclick = close;
      h.append(t, x);
      return h;
    };

    // List of rhythms -> selecting one shows its track-assignment view.
    const showList = () => {
      modal.innerHTML = "";
      modal.append(header("Preset Rhythms"));
      const list = document.createElement("div");
      list.className = "rhythm-list";
      for (const r of RHYTHMS) {
        const b = document.createElement("button");
        b.className = "rhythm-item";
        const nm = document.createElement("span");
        nm.className = "rhythm-name";
        nm.textContent = r.name;
        const gn = document.createElement("span");
        gn.className = "rhythm-genre";
        gn.textContent = r.genre;
        b.append(nm, gn);
        b.onclick = () => { selected = r; assigned.clear(); showAssign(); };
        list.append(b);
      }
      modal.append(list);
    };

    // Per-track sound assignment + Apply.
    const showAssign = () => {
      if (!selected) return showList();
      modal.innerHTML = "";
      modal.append(header(selected.name, showList));
      const body = document.createElement("div");
      body.className = "rhythm-assign";
      for (const track of selected.tracks) {
        const r = document.createElement("div");
        r.className = "rhythm-track";
        const nm = document.createElement("span");
        nm.className = "rhythm-track-name";
        nm.textContent = track.name;
        const pick = document.createElement("button");
        pick.className = "cat-btn rhythm-pick";
        const chosen = assigned.get(track.name);
        if (chosen) {
          pick.classList.add("has-sound");
          const sw = document.createElement("span");
          sw.className = "swatch";
          sw.style.background = chosen.color;
          pick.append(sw, document.createTextNode(chosen.name));
        } else {
          pick.textContent = "Add sound";
        }
        pick.onclick = () => showAssignPick(track.name);
        r.append(nm, pick);
        body.append(r);
      }
      modal.append(body);

      const apply = document.createElement("button");
      apply.className = "rhythm-apply";
      apply.textContent = "Apply to grid";
      apply.onclick = () => {
        if (assigned.size === 0) { alert("Assign a sound to at least one track first."); return; }
        this.applyRhythm(selected!, assigned);
        close();
      };
      modal.append(apply);
    };

    // Saved-sound picker for one track; picking returns to the assignment view.
    const showAssignPick = (trackName: string) => {
      modal.innerHTML = "";
      modal.append(header(`Sound for ${trackName}`, showAssign));
      modal.append(this.buildSoundList((s) => { assigned.set(trackName, s); showAssign(); }));
    };

    showList();
    this.root.append(overlay);
  }

  /** Layer a rhythm onto the current grid: each assigned track becomes a new sound
      on the next empty row, painted where the pattern hits. Existing rows are kept. */
  private applyRhythm(rhythm: Rhythm, assigned: Map<string, SavedSound>): void {
    const blk = this.arr.blocks[this.curBlock()];
    const emptyRows: number[] = [];
    for (let r = 0; r < NUM_ROWS; r++) {
      let empty = true;
      for (let s = 0; s < NUM_STEPS; s++) if (blk.getCell(r, s) >= 0) { empty = false; break; }
      if (empty) emptyRows.push(r);
    }

    let placed = 0;
    let skipped = 0;
    for (const track of rhythm.tracks) {
      const sound = assigned.get(track.name);
      if (!sound) continue;
      if (placed >= emptyRows.length) { skipped++; continue; } // out of empty rows
      const id = this.nextSoundId++;
      const lane: Lane = {
        soundId: id,
        name: sound.name,
        snapshot: sound.snapshot.slice(),
        color: sound.color,
        pitch: [sound.pitch[0], sound.pitch[1]],
      };
      this.lanes.push(lane); // current grid's lane list
      const row = emptyRows[placed++];
      for (let s = 0; s < NUM_STEPS; s++) if (track.steps[s]) blk.setCell(row, s, id);
    }

    if (this.activeLane < 0 && this.lanes.length) this.activeLane = 0;
    this.pushAll();
    this.render();
    if (skipped) alert(`${skipped} track(s) skipped — the grid ran out of empty rows or channels.`);
  }

  // --- mixer view -------------------------------------------------------
  // One channel strip per mixable channel: a colour LED that flashes when it
  // triggers, a Volume fader, Mute/Solo, and a Reverb send. Volume/Reverb write
  // straight into the channel snapshot (Volume = index 22, ReverbMix = 21);
  // Mute/Solo are applied at push time by zeroing Volume. A manual grid mixes its
  // paint lanes; a Euclidean grid mixes its assigned voices.
  private renderMixer(): void {
    const v = this.viewRoot;
    this.mixerLeds = new Map();

    const blk = this.arr.blocks[this.curBlock()];
    const channels: MixChannel[] = blk.euclid
      ? blk.voices.filter((vo) => vo.soundId >= 0)
      : this.lanes;

    const head = document.createElement("div");
    head.className = "mixer-head";
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = "‹ Steps";
    back.onclick = () => { this.view = "grid"; this.render(); };
    const title = document.createElement("h2");
    title.className = "mixer-title";
    title.textContent = "Mixer";
    head.append(back, title);
    v.append(head);

    if (channels.length === 0) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = blk.euclid
        ? "No voices yet. Assign sounds to this grid's circles in the Steps view, then mix them here."
        : "No sounds yet. Add some in the Steps view, then mix them here.";
      v.append(hint);
      return;
    }

    const list = document.createElement("div");
    list.className = "mixer-list";
    channels.forEach((ch) => list.append(this.mixerStrip(ch)));
    v.append(list);
  }

  /** A single mixer channel strip for one lane or Euclidean voice. */
  private mixerStrip(ch: MixChannel): HTMLElement {
    const strip = document.createElement("div");
    strip.className = "mix-strip";
    strip.style.setProperty("--lane", ch.color);

    // Header: flashing LED + name.
    const hd = document.createElement("div");
    hd.className = "mix-strip-head";
    const led = document.createElement("span");
    led.className = "mix-led";
    this.mixerLeds!.set(ch.soundId, led);
    const name = document.createElement("span");
    name.className = "mix-name";
    name.textContent = ch.name;

    const toggles = document.createElement("div");
    toggles.className = "mix-toggles";
    const mute = document.createElement("button");
    mute.className = "mix-toggle mute" + (ch.mute ? " on" : "");
    mute.textContent = "M";
    mute.title = "Mute";
    const solo = document.createElement("button");
    solo.className = "mix-toggle solo" + (ch.solo ? " on" : "");
    solo.textContent = "S";
    solo.title = "Solo";
    mute.onclick = () => {
      ch.mute = !ch.mute;
      mute.classList.toggle("on", ch.mute);
      this.pushSounds(); // mute/solo affect every channel's audibility
      this.persist();
    };
    solo.onclick = () => {
      ch.solo = !ch.solo;
      solo.classList.toggle("on", !!ch.solo);
      this.pushSounds();
      this.persist();
    };
    toggles.append(mute, solo);
    hd.append(led, name, toggles);
    strip.append(hd);

    // Faders: Volume + Reverb send, both 0..1 written into the snapshot.
    strip.append(this.mixFader("Vol", ch, ParamId.Volume));
    strip.append(this.mixFader("Verb", ch, ParamId.ReverbMix));
    return strip;
  }

  /** A labelled 0..1 fader bound to one snapshot index of a channel. */
  private mixFader(label: string, lane: MixChannel, id: ParamId): HTMLElement {
    const row = document.createElement("div");
    row.className = "mix-fader";
    const lbl = document.createElement("span");
    lbl.className = "mix-fader-lbl";
    lbl.textContent = label;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1";
    slider.step = "0.02";
    slider.value = String(lane.snapshot[id] ?? 0);
    const val = document.createElement("span");
    val.className = "mix-fader-val";
    const pct = (x: number) => `${Math.round(x * 100)}`;
    val.textContent = pct(Number(slider.value));
    slider.oninput = () => {
      lane.snapshot[id] = Number(slider.value);
      val.textContent = pct(Number(slider.value));
      this.pushSounds();
      this.persist();
    };
    row.append(lbl, slider, val);
    return row;
  }

  // --- paint lanes ------------------------------------------------------
  /** Grid the lane bar + paint act on (ORDER_VIEW falls back to grid 0). */
  private curBlock(): number {
    return this.workspace < NUM_BLOCKS ? this.workspace : 0;
  }
  /** Lanes of the current grid (the bar shown under it). */
  private get lanes(): Lane[] {
    return this.lanesPerBlock[this.curBlock()];
  }
  /** Every lane across all grids (engine pushes, colouring, channel allocation). */
  private allLanes(): Lane[] {
    return this.lanesPerBlock.flat();
  }
  /** Selected lane index within the current grid. */
  private get activeLane(): number { return this.activeLanePerBlock[this.curBlock()]; }
  private set activeLane(i: number) { this.activeLanePerBlock[this.curBlock()] = i; }

  /** Drum index the grid paints, or -1 when no lane is selected. */
  private activeDrumForPaint(): number {
    const lane = this.lanes[this.activeLane];
    return lane ? lane.soundId : -1;
  }

  /** Added sound lanes (none by default) plus a + button to add from the library.
      When the grid's key is on, each pad shows a key badge to include/exclude that
      sound from the key (only highlighted sounds get pitched by the row). */
  private laneSelector(): HTMLElement {
    const blk = this.arr.blocks[this.curBlock()];
    const row = document.createElement("div");
    row.className = "lane-bar";

    const lanes = document.createElement("div");
    lanes.className = "lanes";
    this.lanes.forEach((lane, i) => {
      const keyed = blk.keyEnabled && blk.isKeyed(lane.soundId);
      const b = document.createElement("button");
      b.className = "drum-pad" + (i === this.activeLane ? " on" : "") + (keyed ? " keyed" : "");
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = lane.color;
      const name = document.createElement("span");
      name.textContent = lane.name;
      b.append(sw, name);
      b.onclick = () => this.selectLane(i);
      // While the key is on, a tappable key badge toggles this sound's targeting.
      if (blk.keyEnabled) {
        const key = document.createElement("span");
        key.className = "lane-key" + (keyed ? " on" : "");
        key.textContent = "♪";
        key.title = keyed ? "Key on for this sound (tap to exclude)" : "Tap to apply the key to this sound";
        key.onclick = (e) => {
          e.stopPropagation();
          blk.toggleKeyed(lane.soundId);
          this.gridView.draw();
          this.syncPattern();
          this.render();
        };
        b.append(key);
      }
      // The selected lane gets an × to remove it.
      if (i === this.activeLane) {
        const rm = document.createElement("span");
        rm.className = "lane-remove";
        rm.textContent = "×";
        rm.title = "Remove lane";
        rm.onclick = (e) => { e.stopPropagation(); this.removeLane(i); };
        b.append(rm);
      }
      lanes.append(b);
    });

    const add = document.createElement("button");
    add.className = "add-sound-btn";
    add.textContent = "+";
    add.title = "Add a saved sound";
    add.onclick = (e) => { e.stopPropagation(); this.openSoundPicker(row); };

    row.append(lanes, add);
    return row;
  }

  private selectLane(i: number): void {
    this.activeLane = i;
    const lane = this.lanes[i];
    if (!lane) return;
    this.gridView.setActiveDrum(lane.soundId); // paint with this sound, and preview it
    this.auditionLane(lane);
    this.persist();
    this.render();
  }

  private removeLane(i: number): void {
    const lane = this.lanes[i];
    if (lane) this.arr.blocks[this.curBlock()].keyedDrums.delete(lane.soundId); // don't leave it keyed
    this.lanes.splice(i, 1);
    if (this.activeLane === i) this.activeLane = -1; // nothing selected to paint
    else if (this.activeLane > i) this.activeLane -= 1;
    this.gridView.setActiveDrum(this.activeDrumForPaint());
    this.pushSounds(); // drop the removed sound from the engine table
    this.persist();
    this.render();
  }

  /** A `.sound-picker` panel listing every saved sound, grouped into collapsible
      folders; tapping one calls `onPick`. Reused by the lane + button and by the
      rhythm track-assignment UI. */
  private buildSoundList(onPick: (s: SavedSound) => void): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "sound-picker";
    const items = this.library.all();

    const makeItem = (it: SavedSound, inFolder: boolean) => {
      const b = document.createElement("button");
      b.className = "pick-item" + (inFolder ? " in-folder" : "");
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = it.color;
      const name = document.createElement("span");
      name.textContent = it.name;
      b.append(sw, name);
      b.onclick = () => onPick(it);
      return b;
    };

    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No saved sounds yet. Save some in the Sounds view.";
      panel.append(empty);
      return panel;
    }
    // Group by folder name (folders can span drums), each collapsible, ungrouped last.
    const folderNames = [...new Set(items.filter((s) => s.folder).map((s) => s.folder))]
      .sort((a, b) => a.localeCompare(b));
    const collapsed = new Set<string>();
    const render = () => {
      panel.innerHTML = "";
      for (const f of folderNames) {
        const group = items.filter((s) => s.folder === f);
        const open = !collapsed.has(f);
        const head = document.createElement("button");
        head.className = "saved-folder-head";
        head.textContent = `${open ? "▾" : "▸"} ${f} (${group.length})`;
        const color = this.library.folderColor(f);
        if (color) {
          head.style.background = color;
          head.style.color = textOn(color);
          head.style.borderColor = "transparent";
        }
        head.onclick = () => { if (open) collapsed.add(f); else collapsed.delete(f); render(); };
        panel.append(head);
        if (open) for (const it of group) panel.append(makeItem(it, true));
      }
      for (const it of items.filter((s) => !s.folder)) panel.append(makeItem(it, false));
    };
    render();
    return panel;
  }

  /** Popup of every saved sound across drums; choosing one adds it as a lane. */
  private openSoundPicker(anchor: HTMLElement): void {
    const existing = anchor.querySelector(".sound-picker");
    if (existing) { existing.remove(); return; }

    const panel = this.buildSoundList((s) => { panel.remove(); this.addLane(s); });
    anchor.append(panel);
    // Dismiss on the next outside tap.
    const close = (ev: PointerEvent) => {
      if (!panel.contains(ev.target as Node)) {
        panel.remove();
        document.removeEventListener("pointerdown", close, true);
      }
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  }

  private addLane(sound: SavedSound): void {
    const lane: Lane = {
      soundId: this.nextSoundId++,
      name: sound.name,
      snapshot: sound.snapshot.slice(),
      color: sound.color,
      pitch: [sound.pitch[0], sound.pitch[1]],
    };
    this.lanes.push(lane);
    this.pushSounds();
    this.selectLane(this.lanes.length - 1);
  }

  // --- order editor -----------------------------------------------------
  private renderOrderEditor(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "order-editor";

    const loop = document.createElement("div");
    loop.className = "loop-time";
    const loopLabel = document.createElement("span");
    loopLabel.className = "loop-time-label";
    loopLabel.textContent = "Loop length";
    this.loopTimeEl = document.createElement("span");
    this.loopTimeEl.className = "loop-time-val";
    loop.append(loopLabel, this.loopTimeEl);
    wrap.append(loop);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Pick a pattern colour, then tap slots to place it. Plays top-left to bottom-right.";
    wrap.append(hint);

    wrap.append(this.gridPalette());

    const grid = document.createElement("div");
    grid.className = "order-grid";
    this.orderSlotEls = [];

    for (let i = 0; i < ORDER_SLOTS; i++) {
      const slot = document.createElement("button");
      slot.className = "order-slot";
      this.paintOrderSlot(slot, i);
      slot.onclick = () => {
        // Toggle: placing the selected grid where it already is clears the slot.
        this.arr.order[i] = this.arr.order[i] === this.orderBrush ? EMPTY : this.orderBrush;
        this.paintOrderSlot(slot, i);
        this.syncPattern();
      };
      this.orderSlotEls.push(slot);
      grid.append(slot);
    }
    wrap.append(grid);
    return wrap;
  }

  /** Colour swatches for the six patterns; the selected one is the placing brush. */
  private gridPalette(): HTMLElement {
    const row = document.createElement("div");
    row.className = "grid-palette";
    for (let g = 0; g < NUM_BLOCKS; g++) {
      const b = document.createElement("button");
      b.className = "grid-swatch" + (g === this.orderBrush ? " on" : "");
      b.style.background = GRID_COLORS[g];
      b.textContent = String(g + 1);
      b.onclick = () => {
        this.orderBrush = g;
        row.querySelectorAll(".grid-swatch").forEach((el) => el.classList.remove("on"));
        b.classList.add("on");
      };
      row.append(b);
    }
    return row;
  }

  private paintOrderSlot(el: HTMLElement, i: number): void {
    const g = this.arr.order[i];
    if (g >= 0) {
      el.style.background = GRID_COLORS[g];
      el.textContent = String(g + 1);
      el.classList.remove("empty");
    } else {
      el.style.background = "";
      el.textContent = String(i + 1);
      el.classList.add("empty");
    }
  }

  // --- sound view -------------------------------------------------------
  private renderSound(): void {
    const v = this.viewRoot;

    const sound = new SoundView(this.kit, this.library, this.selectedDrum, this.soundName, {
      // The editor voice isn't in the engine sound table — it's auditioned on demand
      // (onAudition reads the kit fresh), so edits just need persisting.
      onChange: () => { this.persist(); },
      onRangeChange: () => { this.persist(); },
      onAudition: (d) => this.audition(d),
      onRename: (name) => { this.soundName = name; this.persist(); },
      onSaved: () => this.revertEditorToDefault(),
    });

    v.append(sound.el);
  }
}

// Black or white text for readability on a given hex background.
function textOn(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#15161a" : "#ffffff";
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.textContent = text;
  wrap.append(span, control);
  return wrap;
}
