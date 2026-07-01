// The per-voice shuffle menu: a compact popup that lets you audition sounds live on
// one Euclidean voice while a rhythm plays. It mirrors the shuffle controls from the
// Sounds view (Shuffle / recap / Back / Reset / Randomness / Spread / Max-len /
// Presets) but drops the Save/Saved library — a shuffled sound just swaps straight
// into the voice (the app writes it back and resends the sound table, so the engine
// picks it up on the voice's next "on" step).

import { DrumKit } from "../model/drumKit";
import { DrumType } from "../model/drums";
import { FACTORY_PRESETS, Preset } from "../model/presets";
import { CURVE_OPTIONS, MAXLEN_OPTIONS } from "./soundView";

// The mutable shuffle settings kept per voice (persist across menu opens). The kit
// holds the live params + ranges + undo stack for this one voice.
export interface VoiceEditor {
  kit: DrumKit;
  randomness: number; // 0..1 shuffle amount
  curveIdx: number;   // index into CURVE_OPTIONS
  maxLenIdx: number;  // index into MAXLEN_OPTIONS
}

export interface VoiceMenuCallbacks {
  // A whole-sound change happened (shuffle/back/reset/preset): write the kit back into
  // the voice, resend the sound table, persist, redraw the circle. No audio.
  onChange: () => void;
  // Preview the current sound once (also used by the ▶ button).
  audition: () => void;
  // Open the full per-parameter editor for this voice (the "Full Parameters" button).
  onFullParams: () => void;
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

  // Apply a kit mutation, then push it into the voice, preview it, and refresh the UI.
  const afterChange = () => { cb.onChange(); cb.audition(); render(); };

  const render = () => {
    panel.innerHTML = "";

    // Big primary Shuffle.
    const shuffle = mkBtn("🎲 Shuffle", "shuffle-big");
    shuffle.onclick = () => {
      editor.kit.shuffleAll(
        drum, editor.randomness, CURVE_OPTIONS[editor.curveIdx].curve, MAXLEN_OPTIONS[editor.maxLenIdx].seconds,
      );
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

    // Spread (frequency distribution) + Max length cap.
    panel.append(selectRow("Spread", CURVE_OPTIONS.map((o) => o.label), editor.curveIdx, (i) => { editor.curveIdx = i; }));
    panel.append(selectRow("Max len", MAXLEN_OPTIONS.map((o) => o.label), editor.maxLenIdx, (i) => { editor.maxLenIdx = i; }));

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
      for (const preset of FACTORY_PRESETS) {
        presets.append(presetTile(preset, () => {
          editor.kit.applyPreset(drum, preset);
          showPresets = false;
          afterChange();
        }));
      }
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
