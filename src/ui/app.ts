// App shell: owns the engine + pattern + UI state, and switches between the two
// full-screen views (Steps / Sound). Within Steps you pick a workspace from the
// numbered pattern buttons: one of the six 16-step patterns (drawn as two stacked
// 8-wide grids), or the "Loop" view (20-slot order list) that sequences which
// patterns play and in what order. Painted lanes are added from saved sounds.

import { EngineHost, EngineSound, Playhead } from "../audio/engineHost";
import { encodeWavFromBuffer } from "../audio/wav";
import { DRUMS, DrumType } from "../model/drums";
import { ParamId, NUM_PARAMS } from "../model/params";
import { baseSpec } from "../model/paramSpec";
import { DrumKit, estimateLength } from "../model/drumKit";
import { FULL_RANGE_PRESET } from "../model/presets";
import { serialize, deserialize, ProjectJSON } from "../model/project";
import {
  WipArrangement, NUM_BLOCKS, ORDER_SLOTS, EMPTY, GRID_COLORS, VOICE_COLORS,
} from "../model/melodyGrid";
import { EUCLID_VOICES, clampSteps, MAX_STEPS, VOICE_DEFAULT, evenGap, maxSplitGap, voicePattern } from "../model/euclid";
import { GridView } from "./gridView";
import { EuclidView } from "./euclidView";
import { SoundView } from "./soundView";
import { buildVoiceShuffleMenu, VoiceEditor } from "./voiceShuffleMenu";
import { logoLetters } from "./logo";

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

// Every voice's inline shuffle editor drives a single-drum DrumKit; the reference drum
// only picks parameter specs — Full Range opens all ranges so any character is reachable.
const REF_DRUM = DrumType.Kick;

type View = "grid" | "sound" | "mixer";

// The editable numeric fields of a Euclidean voice (its scrubbable number boxes).
type EuclidField = "hits" | "steps" | "rotation" | "split";

export class App {
  private engine = new EngineHost();
  private arr = new WipArrangement();
  private kit = new DrumKit(DRUMS.map((d) => d.type)); // editable per-drum params
  private drumTypes = DRUMS.map((d) => d.type);
  private saveTimer = 0;

  private view: View = "grid"; // the Euclid grid is the landing view
  private soundSlot = 0; // which voice the full-parameters (sound) view is editing
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

  // Per-voice inline shuffle editors, keyed by `${block}:${slot}`. Lazily created when
  // a voice's shuffle menu first opens; cleared on new/load (rebuilt from saved state).
  private voiceEditors = new Map<string, VoiceEditor>();

  private root: HTMLElement;
  private viewRoot!: HTMLElement;
  private gridView = new GridView(this.arr.blocks[0]);
  private euclidView = new EuclidView(this.arr.blocks[0]);
  private loopTimeEl: HTMLElement | null = null;
  private orderSlotEls: HTMLElement[] | null = null;
  // Channel -> flash LED, populated while the Mixer view is shown.
  private mixerLeds: Map<number, HTMLElement> | null = null;
  // Sound id -> voice title button, for the colour flash when its voice fires.
  private voiceBtns: Map<number, HTMLElement> | null = null;

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
    // Juice: swell + ripple the fired hits on the circle, and flash their voice rows.
    if (blk && blk.euclid && onCurrent) this.euclidView.pulse(p.fired);
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
    this.syncPattern();
    this.engine.setTempo(this.tempo);
  }

  /** The engine sound table: every painted lane + assigned Euclidean voice as a stable
      id + snapshot + Pitch range (for the key mapping) + estimated tail (for channel
      stealing). Muted / soloed-out channels get Volume zeroed. */
  private buildSounds(): EngineSound[] {
    const sounds = this.allLanes().map((lane) => {
      const snap = lane.snapshot.slice();
      if (!this.channelAudible(lane)) snap[ParamId.Volume] = 0;
      return { id: lane.soundId, snap, lo: lane.pitch[0], hi: lane.pitch[1], tail: estimateLength(snap, this.tempo) };
    });
    for (const blk of this.arr.blocks) {
      if (!blk.euclid) continue;
      for (const v of blk.voices) {
        if (v.soundId < 0) continue;
        const snap = v.snapshot.slice();
        if (!this.channelAudible(v)) snap[ParamId.Volume] = 0;
        sounds.push({ id: v.soundId, snap, lo: v.pitch[0], hi: v.pitch[1], tail: estimateLength(snap, this.tempo) });
      }
    }
    return sounds;
  }

  /** Push the sound table to the (live) engine. The engine binds ids to channels. */
  private pushSounds(): void {
    this.engine.setSounds(this.buildSounds());
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

  /** The order sent to the engine reflects the play source: a numbered grid button solos
      just that grid (ignore the loop order); the Loop view plays the real order. */
  private effectiveOrder(): number[] {
    if (this.workspace < NUM_BLOCKS) return [this.workspace]; // solo the selected grid
    return this.arr.orderArray();
  }

  /** Resend grids + order. While playing the engine stages this and applies it
      at the next loop restart, so the current pass plays unchanged. */
  private syncPattern(): void {
    this.engine.setPattern(this.arr.blocksMessage(), this.effectiveOrder());
    this.updateLoopTime();
    this.persist();
  }

  /** Switch the workspace = play source. A numbered grid solos that grid; the Loop button
      plays the whole order. While playing, jump straight to the new source (restart). */
  private selectWorkspace(ws: number): void {
    this.workspace = ws;
    this.engine.setPattern(this.arr.blocksMessage(), this.effectiveOrder(), this.playing);
    this.render();
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

  /** Ask how many loop passes to render, then export (offline) to a downloadable WAV. */
  private promptExportWav(): void {
    const answer = prompt("Export the loop as a WAV — how many times should it repeat?", "4");
    if (answer === null) return;
    const loops = Math.max(1, Math.floor(Number(answer)) || 1);
    this.exportWav(loops).catch((e) => {
      console.error(e);
      alert("Sorry — the export failed.");
    });
  }

  /** Render `loops` passes of the loop-order arrangement to a WAV and download it, so it
      can be uploaded to SoundCloud (etc.) manually. Renders offline (faster than realtime)
      and appends a tail sized to the longest sound so reverb/echo rings out cleanly. */
  private async exportWav(loops: number): Promise<void> {
    const loopLen = this.arr.loopSteps();
    if (loopLen <= 0) { alert("Nothing to export yet — add some voices to a grid first."); return; }
    const sounds = this.buildSounds();
    const maxTail = sounds.reduce((m, s) => Math.max(m, s.tail || 0), 0);
    const tailSec = Math.min(8, Math.max(1.5, maxTail + 0.5));
    const buffer = await this.engine.renderToBuffer({
      blocks: this.arr.blocksMessage(),
      order: this.arr.orderArray(),
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
    this.voiceEditors.clear();
    this.nextSoundId = 0;
    this.afterProjectChange();
  }

  /** After load/new: select each grid's first lane (or none if empty), and bump the
      id counter past every loaded sound id so new lanes never collide with cells. */
  private resetActiveLanes(): void {
    this.voiceEditors.clear(); // rebuilt lazily from each voice's saved snapshot/ranges
    let maxId = -1;
    for (const lane of this.allLanes()) if (lane.soundId > maxId) maxId = lane.soundId;
    // Voices carry sound ids too — keep new ids clear of them.
    for (const blk of this.arr.blocks) {
      for (const v of blk.voices) if (v.soundId > maxId) maxId = v.soundId;
    }
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

  /** Seed the (now background) editor kit with a fresh random Full Range sound. Kept so
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
    this.orderSlotEls = null;
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

    if (this.view === "grid") this.renderGrid();
    else if (this.view === "mixer") this.renderMixer();
    else this.renderSound();
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
      if (this.playing) this.engine.play();
      else {
        this.engine.stop();
        this.gridView.setPlayhead(-1);
        this.euclidView.setPlayhead(-1);
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

  // --- steps view -------------------------------------------------------
  private renderGrid(): void {
    const v = this.viewRoot;
    v.append(this.patternBar());

    if (this.workspace === ORDER_VIEW) {
      v.append(this.renderOrderEditor());
    } else {
      const blk = this.arr.blocks[this.workspace];
      blk.euclid = true; // the sequencer is Euclidean-only now

      // Circle visualization + the 6-voice shuffle menu.
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
    }

    this.updateLoopTime();
  }

  /** The 6-voice Euclidean menu: each row opens a shuffle menu + hits/steps/start. */
  private euclidMenu(): HTMLElement {
    const blk = this.arr.blocks[this.curBlock()];
    const wrap = document.createElement("div");
    wrap.className = "euclid-menu";
    this.voiceBtns = new Map();

    for (let i = 0; i < EUCLID_VOICES; i++) {
      const voice = blk.voices[i];
      const r = document.createElement("div");
      r.className = "euclid-row";

      // Tap the voice to open its inline shuffle menu (generate/replace the sound). The
      // title fills with the voice's ring colour so it reads at a glance against its circle.
      const sound = document.createElement("button");
      sound.className = "euclid-sound" + (voice.soundId >= 0 ? " has-sound" : "");
      if (voice.soundId >= 0) {
        sound.style.background = voice.color;
        sound.style.borderColor = voice.color;
        sound.style.color = "#15161a"; // dark text for contrast on the light voice hues
        sound.style.setProperty("--vc", voice.color); // hit-flash glow colour
        sound.textContent = voice.name || `Voice ${i + 1}`;
        this.voiceBtns.set(voice.soundId, sound);
      } else {
        // Empty slot: a gently wiggling die invites a first shuffle.
        const dice = document.createElement("span");
        dice.className = "dice";
        dice.textContent = "🎲";
        sound.append(dice, ` Voice ${i + 1}`);
      }
      sound.onclick = () => this.openVoiceShuffleMenu(sound, i);

      // A hits/steps/start/split box: tap to type, or click-hold and drag up/down to scrub.
      const mkNum = (label: string, value: number, field: EuclidField, disabled = false) => {
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
          inp.onchange = () => { this.setEuclidNum(i, field, Number(inp.value)); };
          this.attachDragScrub(inp, i, field);
        }
        cell.append(lab, inp);
        return cell;
      };

      const hits = mkNum("Hits", voice.hits, "hits");
      const steps = mkNum("Steps", voice.steps, "steps");
      const start = mkNum("Start", voice.rotation, "rotation");
      // Split: the primary gap between hits (even spread by default). Disabled unless there
      // are 2+ hits AND room to vary the gap. Drag/type it to try uneven splits (6·6·4 …).
      const splitLocked = voice.hits < 2 || maxSplitGap(voice.hits, voice.steps) <= 1;
      const split = mkNum("Split", voice.split ?? evenGap(voice.hits, voice.steps), "split", splitLocked);
      split.title = `Hit split: ${this.splitLabel(voice.hits, voice.steps, voice.rotation, voice.split)}`;

      // The four values read like a flattened ring: voice-coloured circles joined
      // by a line (the .euclid-vals::before rule). Empty slots stay dim grey.
      const vals = document.createElement("div");
      vals.className = "euclid-vals";
      vals.style.setProperty("--vc", voice.soundId >= 0 ? voice.color : "#4a4e58");
      vals.append(hits, steps, start, split);

      r.append(sound, vals);

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

  /** Apply a typed hits/steps/start/split value: update the model, then re-render so the
      inputs show the clamped result. */
  private setEuclidNum(slot: number, field: EuclidField, n: number): void {
    this.applyEuclidNum(slot, field, n);
    this.render(); // reflect clamped values in the inputs
  }

  /** Core hits/steps/start/split update (clamped) + resync + redraw, with NO full render —
      so drag-scrub can update live without tearing down the input mid-drag. */
  private applyEuclidNum(slot: number, field: EuclidField, n: number): void {
    const v = this.arr.blocks[this.curBlock()].voices[slot];
    if (Number.isNaN(n)) n = 0;
    if (field === "steps") v.steps = clampSteps(n);
    else if (field === "hits") v.hits = Math.max(0, Math.min(MAX_STEPS, Math.round(n)));
    else if (field === "rotation") v.rotation = Math.round(n);
    else v.split = Math.max(1, Math.min(maxSplitGap(v.hits, v.steps), Math.round(n))); // primary gap
    // Cap hits at steps only once steps is set (a blank voice defaults to 0 steps and
    // shouldn't swallow a hits value the user types first).
    if (v.steps >= 1 && v.hits > v.steps) v.hits = v.steps;
    this.syncPattern();
    this.euclidView.draw();
    this.updateLoopTime();
  }

  /** Human-readable gap composition of the voice's actual pattern, e.g. "6·6·4" — the
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
  private attachDragScrub(input: HTMLInputElement, slot: number, field: EuclidField): void {
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
      this.applyEuclidNum(slot, field, startVal + delta);
      const v = this.arr.blocks[this.curBlock()].voices[slot];
      const shown = field === "steps" ? v.steps : field === "hits" ? v.hits
        : field === "rotation" ? v.rotation : (v.split ?? evenGap(v.hits, v.steps));
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

  /** The live editor for one voice slot, created lazily. Rebuilt from the voice's saved
      snapshot/ranges/preset so a reloaded project keeps shuffling from where it left. */
  private voiceEditorFor(slot: number): VoiceEditor {
    const key = `${this.curBlock()}:${slot}`;
    let ed = this.voiceEditors.get(key);
    if (ed) return ed;
    const kit = new DrumKit([REF_DRUM]);
    const p = kit.get(REF_DRUM);
    p.applyPreset(FULL_RANGE_PRESET); // default window (no undo entry)
    const v = this.arr.blocks[this.curBlock()].voices[slot];
    if (v.preset) kit.adoptPresetByName(REF_DRUM, v.preset); // Reset target after reload
    if (v.ranges) p.restoreRanges(v.ranges.lo, v.ranges.hi);
    if (v.snapshot.length) p.restore(v.snapshot);
    ed = { kit, randomness: 1.0, curveIdx: 1, maxLenIdx: 0, snapIdx: 0, seedText: "", lastSeed: "" };
    this.voiceEditors.set(key, ed);
    return ed;
  }

  /** Write the voice's editor state back into the voice, swap it into the engine (takes
      effect on the voice's next "on" step), persist, and redraw the circle. */
  private writeVoiceFromEditor(slot: number): void {
    const ed = this.voiceEditorFor(slot);
    const p = ed.kit.get(REF_DRUM);
    const v = this.arr.blocks[this.curBlock()].voices[slot];
    if (v.soundId < 0) {
      v.soundId = this.nextSoundId++;
      v.color = VOICE_COLORS[slot % VOICE_COLORS.length];
      // Give a fresh voice an audible default pattern so the shuffle can be heard.
      if (v.steps < 1) { v.steps = 8; v.hits = 4; v.rotation = 0; }
    }
    v.snapshot = p.capture();
    v.name = p.describe().join(" · ");
    const pr = ed.kit.pitchRange(REF_DRUM);
    v.pitch = [pr[0], pr[1]];
    v.preset = p.presetName();
    v.ranges = p.captureRanges();
    this.pushSounds();
    this.syncPattern();
    this.euclidView.draw();
  }

  /** Preview one voice's current editor sound once (on the reserved audition channel). */
  private auditionVoice(slot: number): void {
    const p = this.voiceEditorFor(slot).kit.get(REF_DRUM);
    const snap = p.capture();
    this.engine.audition(snap, Math.round(this.engine.sampleRate * 0.4), estimateLength(snap, this.tempo));
  }

  /** Key + tempo context passed to the shuffle UIs (Key snap + synced-echo lengths). */
  private shuffleContext(): { root: number; scale: number; bpm: number } {
    const blk = this.arr.blocks[this.curBlock()];
    return { root: blk.root, scale: blk.scale, bpm: this.tempo };
  }

  /** The other voices of the current grid that carry sounds — crossbreed partners. */
  private breedMates(slot: number): { name: string; color: string; snapshot: number[] }[] {
    const blk = this.arr.blocks[this.curBlock()];
    const out: { name: string; color: string; snapshot: number[] }[] = [];
    blk.voices.forEach((v, i) => {
      if (i === slot || v.soundId < 0 || !v.snapshot.length) return;
      out.push({ name: v.name || `Voice ${i + 1}`, color: v.color, snapshot: v.snapshot.slice() });
    });
    return out;
  }

  /** Inline shuffle menu for one voice: generate/replace its sound live. Reuses the
      anchor + outside-tap-dismiss pattern of the old sound picker. */
  private openVoiceShuffleMenu(anchor: HTMLElement, slot: number): void {
    const existing = this.viewRoot.querySelector(".voice-shuffle");
    if (existing) { existing.remove(); return; }
    const editor = this.voiceEditorFor(slot);
    const openFull = () => {
      panel.remove();
      document.removeEventListener("pointerdown", close, true);
      this.soundSlot = slot;
      this.view = "sound";
      this.render();
    };
    const panel = buildVoiceShuffleMenu(editor, REF_DRUM, {
      onChange: () => this.writeVoiceFromEditor(slot),
      audition: () => this.auditionVoice(slot),
      onFullParams: openFull,
      context: () => this.shuffleContext(),
      mates: () => this.breedMates(slot),
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
    v.split = undefined;
    v.mute = false; v.solo = false;
    v.preset = undefined; v.ranges = undefined;
    this.voiceEditors.delete(`${this.curBlock()}:${slot}`); // next open starts fresh
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
      b.title = `Play grid ${i + 1} on its own`;
      b.onclick = () => this.selectWorkspace(i);
      bar.append(b);
    }

    const loop = document.createElement("button");
    loop.className = "loop-view-btn" + (this.workspace === ORDER_VIEW ? " on" : "");
    loop.textContent = "↻";
    loop.title = "Play the loop order";
    loop.onclick = () => this.selectWorkspace(ORDER_VIEW);
    bar.append(loop);

    return bar;
  }

  /** Row below the circle: open the Mixer. */
  private stepsActions(): HTMLElement {
    const row = document.createElement("div");
    row.className = "steps-actions";

    const mix = document.createElement("button");
    mix.className = "mixer-open-btn";
    mix.textContent = "🎚";
    mix.title = "Mixer";
    mix.setAttribute("aria-label", "Mixer");
    mix.onclick = () => { this.view = "mixer"; this.render(); };

    row.append(mix);
    return row;
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
    const channels: MixChannel[] = blk.voices.filter((vo) => vo.soundId >= 0);

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

    // Faders: Volume + Reverb send (0..1) + Pan (-1..1) written into the snapshot.
    strip.append(this.mixFader("Vol", ch, ParamId.Volume));
    strip.append(this.mixFader("Verb", ch, ParamId.ReverbMix));
    strip.append(this.mixFader("Pan", ch, ParamId.Pan, -1, 1));
    return strip;
  }

  /** A labelled fader bound to one snapshot index of a channel. Pan-style bipolar
      faders show L/C/R; 0..1 faders show percent. Old snapshots may be short — a
      missing index reads as the param's neutral 0. */
  private mixFader(label: string, lane: MixChannel, id: ParamId, min = 0, max = 1): HTMLElement {
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
    slider.value = String(lane.snapshot[id] ?? 0);
    const val = document.createElement("span");
    val.className = "mix-fader-val";
    const show = (x: number) => {
      if (min >= 0) return `${Math.round(x * 100)}`;
      if (Math.abs(x) < 0.01) return "C";
      return `${x < 0 ? "L" : "R"}${Math.round(Math.abs(x) * 100)}`;
    };
    val.textContent = show(Number(slider.value));
    slider.oninput = () => {
      // Older snapshots are shorter than the newest param indices — pad the gap
      // with param defaults first so no null "holes" get persisted.
      for (let i = lane.snapshot.length; i < NUM_PARAMS; i++) lane.snapshot[i] = baseSpec(i as ParamId).def;
      lane.snapshot[id] = Number(slider.value);
      val.textContent = show(Number(slider.value));
      this.pushSounds();
      this.persist();
    };
    row.append(lbl, slider, val);
    return row;
  }

  // --- paint lanes (legacy model; grids are Euclidean in the UI now) ----
  /** Grid the pattern bar + voices act on (ORDER_VIEW falls back to grid 0). */
  private curBlock(): number {
    return this.workspace < NUM_BLOCKS ? this.workspace : 0;
  }
  /** Every paint lane across all grids (kept so old projects still push to the engine). */
  private allLanes(): Lane[] {
    return this.lanesPerBlock.flat();
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

  // --- sound view (full per-parameter editor for one voice, live) -------
  private renderSound(): void {
    const v = this.viewRoot;
    const slot = this.soundSlot;
    const voice = this.arr.blocks[this.curBlock()].voices[slot];

    // Header: Back to the sequencer + the voice's current (auto-generated) name.
    const head = document.createElement("div");
    head.className = "mixer-head";
    const back = document.createElement("button");
    back.className = "mixer-back";
    back.textContent = "‹ Sequencer";
    back.onclick = () => { this.view = "grid"; this.render(); };
    const title = document.createElement("h2");
    title.className = "mixer-title";
    title.textContent = voice.name || `Voice ${slot + 1}`;
    head.append(back, title);
    v.append(head);

    // The editor drives this voice's own kit, so every change is live: writing it back
    // resends the sound table and the engine swaps it in on the voice's next "on" step.
    const editor = this.voiceEditorFor(slot);
    const sound = new SoundView(editor.kit, REF_DRUM, {
      onChange: () => this.writeVoiceFromEditor(slot),
      onRangeChange: () => this.writeVoiceFromEditor(slot),
      onAudition: () => this.auditionVoice(slot),
      context: () => this.shuffleContext(),
    });
    v.append(sound.el);
  }
}

