// The glossary panel shared by the sound-editing surfaces: a full-screen modal that
// lists a set of controls, each with a plain-words description and (optionally) the
// engine lines behind it. The Sound Graph editor (see model/soundTraces.ts) builds its
// items from the trace `about`/`code` fields and opens them with the "?" button.

import { mkBtn } from "./controls";

export interface HelpItem {
  name: string;
  desc: string;
  code?: string; // the behind-the-scenes lines, shown under the description
}

/** The little round "?" for a section head. Tapping it opens the glossary as a
    full-screen modal (a dimmed backdrop with a centred, scrollable card and an ✕);
    tapping the backdrop, the ✕, Escape, or the button again closes it. */
export function helpButton(section: string, items: HelpItem[]): HTMLButtonElement {
  const btn = mkBtn("?", "help-btn");
  btn.setAttribute("aria-label", `Explain the ${section} controls`);
  btn.setAttribute("aria-expanded", "false");

  let overlay: HTMLElement | null = null;
  let onKey: ((ev: KeyboardEvent) => void) | null = null;

  const close = () => {
    overlay?.remove();
    overlay = null;
    if (onKey) { document.removeEventListener("keydown", onKey, true); onKey = null; }
    btn.classList.remove("on");
    btn.setAttribute("aria-expanded", "false");
  };

  btn.onclick = () => {
    if (overlay) { close(); return; }
    overlay = document.createElement("div");
    overlay.className = "help-overlay";
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay.append(buildHelpPanel(section, items, close));
    document.body.append(overlay);
    btn.classList.add("on");
    btn.setAttribute("aria-expanded", "true");
    onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") close(); };
    document.addEventListener("keydown", onKey, true);
  };

  return btn;
}

// The glossary panel: a sticky header (title + ✕), a hint, then one expandable row
// per control (<details> gives the accordion for free, keyboard included). Each open
// row shows the plain-words description, then the real engine lines behind it.
function buildHelpPanel(section: string, items: HelpItem[], onClose: () => void): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "help-panel";

  const head = document.createElement("div");
  head.className = "help-head";
  const title = document.createElement("div");
  title.className = "help-title";
  title.textContent = section;
  const x = document.createElement("button");
  x.className = "help-close";
  x.textContent = "×";
  x.setAttribute("aria-label", "Close help");
  x.onclick = onClose;
  head.append(title, x);
  const hint = document.createElement("div");
  hint.className = "help-hint";
  hint.textContent = "Tap a heading to fold it away.";
  panel.append(head, hint);

  for (const it of items) {
    // Everything OPEN by default — the panel reads as one page, nothing minimised
    // (a heading still folds its block away if wanted).
    const row = document.createElement("details");
    row.className = "help-item";
    row.open = true;
    const sum = document.createElement("summary");
    sum.textContent = it.name;
    const desc = document.createElement("div");
    desc.className = "help-desc";
    desc.textContent = it.desc;
    row.append(sum, desc);
    if (it.code) {
      const code = document.createElement("pre");
      code.className = "help-code";
      code.textContent = it.code;
      row.append(code);
    }
    panel.append(row);
  }
  return panel;
}
