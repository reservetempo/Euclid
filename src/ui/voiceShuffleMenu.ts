// The per-loop shuffle menu: a compact panel that lets you audition sounds live on
// one loop while the track plays. It mirrors the shuffle controls from the deep
// Sounds view (Shuffle / recap / Back / Reset / Randomness / Spread / Max-len /
// Snap / Seed) — a shuffled sound just swaps straight into the loop (the app writes
// it back and resends the sound table, so the engine picks it up on the loop's next
// "on" step).

import { DrumKit } from "../model/drumKit";
import { DrumType } from "../model/drums";
import { ParamId } from "../model/params";
import { getParamSpec, formatValue } from "../model/paramSpec";
import {
  ShuffleSettings, shuffleOptions, randomSeed,
  mkBtn, selectRow, seedRow, randomnessRow, shuffleButton,
  normFromRange, valueFromRange,
  CURVE_OPTIONS, MAXLEN_OPTIONS, SNAP_OPTIONS,
} from "./controls";

/** The per-loop editor: its shuffle settings plus the kit holding the live params
    and undo stack for this one loop's sound. */
export interface VoiceEditor extends ShuffleSettings {
  kit: DrumKit;
}

export interface VoiceMenuCallbacks {
  // A whole-sound change happened (shuffle/back/reset): write the kit back into
  // the loop, resend the sound table, persist, redraw the rings. No audio. May be
  // async (the app re-levels the sound offline) — the menu awaits it before the
  // audition so the preview plays at the corrected loudness.
  onChange: () => void | Promise<void>;
  // Preview the current sound once (also used by the ▶ button).
  audition: () => void;
  // Open the full per-parameter editor for this loop (the "Full Parameters" button).
  onFullParams: () => void;
  // Key + tempo context for the shuffle (Key snap + synced-echo length estimates).
  context: () => { root: number; scale: number; bpm: number };
  // File the CURRENT sound in a feedback log: "high" = too screechy (recap row
  // swiped right), "low" = too quiet (swiped left). See model/soundReports.ts.
  report: (kind: "high" | "low") => void;
}

/** Build the loop shuffle panel for `editor` (operating on reference drum `drum`).
    The panel re-renders itself in place after each change so the recap line and the
    Back-enabled state stay current. */
export function buildVoiceShuffleMenu(
  editor: VoiceEditor,
  drum: DrumType,
  cb: VoiceMenuCallbacks,
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "voice-shuffle";
  let rolled = false;      // one-shot: spin the die on the render right after a shuffle

  // Apply a kit mutation, then push it into the loop (awaiting its loudness
  // re-level), preview it, and refresh the UI.
  const afterChange = async () => { await cb.onChange(); cb.audition(); render(); };

  const render = () => {
    panel.innerHTML = "";

    const shuffle = shuffleButton(rolled);
    rolled = false;
    shuffle.onclick = () => {
      const seed = editor.seedText.trim() || randomSeed();
      editor.lastSeed = seed;
      editor.kit.shuffleAll(drum, shuffleOptions(editor, cb.context(), seed));
      rolled = true;
      afterChange();
    };
    panel.append(shuffle);

    // Recap of the current sound + ▶ replay. The row doubles as the feedback
    // surface: swipe it right to file the sound as too screechy, left as too quiet.
    const sum = document.createElement("div");
    sum.className = "shuffle-summary swipe-report";
    sum.title = "Swipe right if too screechy, left if too quiet — files it to the feedback log";
    const play = mkBtn("▶", "summary-play");
    play.title = "Play sound";
    play.onclick = () => cb.audition();
    const txt = document.createElement("span");
    txt.textContent = editor.kit.get(drum).describe().join(" · ");
    sum.append(play, txt);
    attachSwipeReport(sum, cb.report);
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

    panel.append(randomnessRow(editor));
    panel.append(selectRow("Spread", CURVE_OPTIONS.map((o) => o.label), editor.curveIdx, (i) => { editor.curveIdx = i; }));
    panel.append(selectRow("Max len", MAXLEN_OPTIONS.map((o) => o.label), editor.maxLenIdx, (i) => { editor.maxLenIdx = i; }));
    panel.append(selectRow("Snap", SNAP_OPTIONS.map((o) => o.label), editor.snapIdx, (i) => { editor.snapIdx = i; }));
    panel.append(seedRow(editor));

    // Gate: how long each hit is held before note-off. Together with the amp Sustain
    // this is the note-length control (it replaced the old fixed 0.4s hold — now per
    // sound; see engine.js). Commits on release: persist, then audition the new length.
    panel.append(gateRow(editor.kit.get(drum), drum, afterChange));

    // Full Parameters: open the deep per-parameter editor for this loop (live).
    const full = mkBtn("Full Parameters", "cat-btn full-params-btn");
    full.onclick = () => cb.onFullParams();
    panel.append(full);
  };

  render();
  return panel;
}

/** A compact Gate slider (note-hold in seconds), skew-mapped like the deep editor's
    value boxes. Edits the sound's Gate param live so you hear it move, and commits
    (persist + audition) on release. */
function gateRow(params: ReturnType<DrumKit["get"]>, drum: DrumType, commit: () => void): HTMLElement {
  const s = getParamSpec(drum, ParamId.Gate);
  const lo = params.loOf(ParamId.Gate);
  const hi = params.hiOf(ParamId.Gate);

  const row = document.createElement("div");
  row.className = "precision gate-row";
  const lbl = document.createElement("span");
  lbl.className = "precision-lbl";
  lbl.textContent = "Gate";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1";
  slider.step = "0.001";
  slider.value = String(normFromRange(lo, hi, s.skew, params.get(ParamId.Gate)));
  const val = document.createElement("span");
  val.className = "rnd-lbl gate-val";
  val.textContent = formatValue(s, params.get(ParamId.Gate));

  slider.oninput = () => {
    params.set(ParamId.Gate, valueFromRange(lo, hi, s.skew, s.step, Number(slider.value)));
    val.textContent = formatValue(s, params.get(ParamId.Gate));
  };
  slider.onchange = () => commit(); // persist + audition on release
  row.append(lbl, slider, val);
  return row;
}

/** Swipe the recap row to file the current sound in a feedback log: RIGHT = "too
    high" (screechy), LEFT = "too low" (quiet). The row follows the finger and tints
    once the drag is past the commit distance (release to file; short drags snap
    back). Vertical movement is left to the scroller (touch-action: pan-y in CSS),
    and a plain tap still reaches the ▶ button. */
function attachSwipeReport(el: HTMLElement, onReport: (kind: "high" | "low") => void): void {
  const COMMIT = 64; // px of horizontal drag that arms the report
  let id = -1, startX = 0, startY = 0, dx = 0, horizontal = false;

  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    id = e.pointerId; startX = e.clientX; startY = e.clientY;
    dx = 0; horizontal = false;
  });
  el.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return;
    dx = e.clientX - startX;
    if (!horizontal) {
      if (Math.abs(dx) < 8) return; // undecided: could still be a tap
      if (Math.abs(dx) <= Math.abs(e.clientY - startY)) { id = -1; return; } // a scroll
      horizontal = true;
      el.classList.add("swiping");
      try { el.setPointerCapture(id); } catch { /* fine without capture */ }
    }
    el.style.transform = `translateX(${dx}px)`;
    el.classList.toggle("swipe-high", dx > COMMIT);
    el.classList.toggle("swipe-low", dx < -COMMIT);
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = -1;
    if (horizontal) {
      if (dx > COMMIT) onReport("high");
      else if (dx < -COMMIT) onReport("low");
    }
    el.classList.remove("swiping", "swipe-high", "swipe-low");
    el.style.transform = ""; // snap back (the base transition animates it)
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}
