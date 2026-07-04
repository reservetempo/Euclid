// The per-voice shuffle menu: a compact popup that lets you audition sounds live on
// one Euclidean voice while a rhythm plays. It mirrors the shuffle controls from the
// Sounds view (Shuffle / recap / Back / Reset / Randomness / Spread / Max-len /
// Presets) but drops the Save/Saved library — a shuffled sound just swaps straight
// into the voice (the app writes it back and resends the sound table, so the engine
// picks it up on the voice's next "on" step).

import { DrumKit } from "../model/drumKit";
import { DrumType } from "../model/drums";
import { FACTORY_PRESETS, Preset } from "../model/presets";
import { CURVE_OPTIONS, MAXLEN_OPTIONS, SNAP_OPTIONS, randomSeed } from "./soundView";
import { burstConfetti } from "./confetti";

// The mutable shuffle settings kept per voice (persist across menu opens). The kit
// holds the live params + ranges + undo stack for this one voice.
export interface VoiceEditor {
  kit: DrumKit;
  randomness: number; // 0..1 shuffle amount
  curveIdx: number;   // index into CURVE_OPTIONS
  maxLenIdx: number;  // index into MAXLEN_OPTIONS
  snapIdx: number;    // index into SNAP_OPTIONS
  seedText: string;   // user-entered seed ("" = fresh roll per shuffle)
  lastSeed: string;   // seed the last shuffle used (shown as the placeholder)
}

// A potential crossbreeding partner: another voice of the same grid with a sound.
export interface BreedMate {
  name: string;
  color: string;
  snapshot: number[];
}

export interface VoiceMenuCallbacks {
  // A whole-sound change happened (shuffle/back/reset/preset): write the kit back into
  // the voice, resend the sound table, persist, redraw the circle. No audio. May be
  // async (the app re-levels the sound offline) — the menu awaits it before the
  // audition so the preview plays at the corrected loudness.
  onChange: () => void | Promise<void>;
  // Preview the current sound once (also used by the ▶ button).
  audition: () => void;
  // Open the full per-parameter editor for this voice (the "Full Parameters" button).
  onFullParams: () => void;
  // Key + tempo context for the shuffle (Key snap + synced-echo length estimates).
  context: () => { root: number; scale: number; bpm: number };
  // The other voices of this grid that have sounds (crossbreeding partners).
  mates: () => BreedMate[];
}

/** Build the voice shuffle popup for `editor` (operating on reference drum `drum`).
    The panel re-renders itself in place after each change so the recap line and the
    Back-enabled state stay current. */
export function buildVoiceShuffleMenu(
  editor: VoiceEditor,
  drum: DrumType,
  cb: VoiceMenuCallbacks,
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "voice-shuffle";
  let showPresets = false; // presets stay hidden behind their button until toggled
  let showMates = false;   // ditto for the crossbreed partner list
  let rolled = false;      // one-shot: spin the die on the render right after a shuffle

  // Apply a kit mutation, then push it into the voice (awaiting its loudness
  // re-level), preview it, and refresh the UI.
  const afterChange = async () => { await cb.onChange(); cb.audition(); render(); };

  const render = () => {
    panel.innerHTML = "";

    // Big primary Shuffle, with a die that spins on every roll.
    const shuffle = mkBtn(" Shuffle", "shuffle-big");
    const dice = document.createElement("span");
    dice.className = "dice" + (rolled ? " rolled" : "");
    dice.textContent = "🎲";
    shuffle.prepend(dice);
    rolled = false;
    shuffle.onclick = () => {
      const ctx = cb.context();
      const seed = editor.seedText.trim() || randomSeed();
      editor.lastSeed = seed;
      editor.kit.shuffleAll(drum, {
        randomness: editor.randomness,
        curve: CURVE_OPTIONS[editor.curveIdx].curve,
        maxLen: MAXLEN_OPTIONS[editor.maxLenIdx].seconds,
        bpm: ctx.bpm,
        snap: SNAP_OPTIONS[editor.snapIdx].snap,
        root: ctx.root,
        scale: ctx.scale,
        seed,
      });
      rolled = true;
      afterChange();
    };
    panel.append(shuffle);

    // Recap of the current sound + ▶ replay.
    const sum = document.createElement("div");
    sum.className = "shuffle-summary";
    const play = mkBtn("▶", "summary-play");
    play.title = "Play sound";
    play.onclick = () => cb.audition();
    const txt = document.createElement("span");
    txt.textContent = editor.kit.get(drum).describe().join(" · ");
    sum.append(play, txt);
    panel.append(sum);

    // Back / Reset.
    const br = document.createElement("div");
    br.className = "sound-lib";
    const back = mkBtn("Back", "cat-btn");
    const reset = mkBtn("Reset", "cat-btn");
    back.disabled = !editor.kit.canBack(drum);
    back.onclick = () => { if (editor.kit.backAll(drum)) afterChange(); };
    reset.onclick = () => { editor.kit.resetAll(drum); afterChange(); };
    br.append(back, reset);
    panel.append(br);

    // Randomness amount.
    const rnd = document.createElement("div");
    rnd.className = "rnd";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(Math.round(editor.randomness * 100));
    const lbl = document.createElement("span");
    lbl.className = "rnd-lbl";
    lbl.textContent = `${slider.value}%`;
    slider.oninput = () => {
      editor.randomness = Number(slider.value) / 100;
      lbl.textContent = `${slider.value}%`;
    };
    rnd.append(slider, lbl);
    panel.append(rnd);

    // Spread (frequency distribution) + Max length cap + Pitch snap + Seed.
    panel.append(selectRow("Spread", CURVE_OPTIONS.map((o) => o.label), editor.curveIdx, (i) => { editor.curveIdx = i; }));
    panel.append(selectRow("Max len", MAXLEN_OPTIONS.map((o) => o.label), editor.maxLenIdx, (i) => { editor.maxLenIdx = i; }));
    panel.append(selectRow("Snap", SNAP_OPTIONS.map((o) => o.label), editor.snapIdx, (i) => { editor.snapIdx = i; }));
    panel.append(seedRow(editor));

    // Crossbreed: pick another voice of this grid, get a child of the two sounds.
    const mates = cb.mates();
    if (mates.length > 0) {
      const breed = mkBtn("🧬 Breed with…", "cat-btn breed-btn");
      breed.onclick = () => { showMates = !showMates; render(); };
      panel.append(breed);
      if (showMates) {
        const list = document.createElement("div");
        list.className = "voice-preset-grid";
        mates.forEach((m, i) => {
          const tile = mkBtn(m.name, "preset-tile");
          tile.style.background = m.color;
          tile.style.color = textOn(m.color);
          tile.style.borderColor = "transparent";
          tile.style.setProperty("--i", String(i));
          tile.onclick = () => {
            editor.kit.breed(drum, m.snapshot);
            showMates = false;
            burstConfetti(44); // a birth deserves a little party
            afterChange();
          };
          list.append(tile);
        });
        panel.append(list);
      }
    }

    // Presets live behind a button that shows the active preset's name + colour; tapping
    // it reveals the grid of character windows. Picking one applies it and collapses.
    const p = editor.kit.get(drum);
    const presetBtn = mkBtn(p.presetName(), "cat-btn preset-name-btn");
    const col = p.presetColor();
    presetBtn.style.background = col;
    presetBtn.style.color = textOn(col);
    presetBtn.style.borderColor = "transparent";
    presetBtn.onclick = () => { showPresets = !showPresets; render(); };
    panel.append(presetBtn);

    if (showPresets) {
      const presets = document.createElement("div");
      presets.className = "voice-preset-grid";
      FACTORY_PRESETS.forEach((preset, i) => {
        const tile = presetTile(preset, () => {
          editor.kit.applyPreset(drum, preset);
          showPresets = false;
          afterChange();
        });
        tile.style.setProperty("--i", String(i)); // staggered pop-in
        presets.append(tile);
      });
      panel.append(presets);
    }

    // Full Parameters: open the deep per-parameter editor for this voice (live).
    const full = mkBtn("Full Parameters", "cat-btn full-params-btn");
    full.onclick = () => cb.onFullParams();
    panel.append(full);
  };

  render();
  return panel;
}

function presetTile(p: Preset, onPick: () => void): HTMLButtonElement {
  const b = mkBtn(p.name, "preset-tile");
  b.style.background = p.color;
  b.style.color = textOn(p.color);
  b.style.borderColor = "transparent";
  b.onclick = onPick;
  return b;
}

// Seed row: type a seed to repeat a shuffle exactly (best at 100% randomness);
// empty = fresh roll each time, with the used seed shown as the placeholder.
function seedRow(editor: VoiceEditor): HTMLElement {
  const row = document.createElement("div");
  row.className = "precision";
  const lbl = document.createElement("span");
  lbl.className = "precision-lbl";
  lbl.textContent = "Seed";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "vbox-num seed-input";
  input.placeholder = editor.lastSeed ? `last: ${editor.lastSeed}` : "random";
  input.value = editor.seedText;
  input.onchange = () => { editor.seedText = input.value; };
  row.append(lbl, input);
  return row;
}

// A labelled <select> row (mirrors SoundView.selectRow for Spread + Max len).
function selectRow(label: string, options: string[], value: number, onChange: (i: number) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "precision";
  const lbl = document.createElement("span");
  lbl.className = "precision-lbl";
  lbl.textContent = label;
  const sel = document.createElement("select");
  sel.className = "vbox-select";
  options.forEach((o, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = o;
    sel.append(opt);
  });
  sel.value = String(value);
  sel.onchange = () => onChange(Number(sel.value));
  row.append(lbl, sel);
  return row;
}

function mkBtn(text: string, cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = cls;
  return b;
}

// Black or white text for readability on a given hex background.
function textOn(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#15161a" : "#ffffff";
}
