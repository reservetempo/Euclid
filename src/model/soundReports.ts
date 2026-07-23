// Swipe-to-report feedback logs: while auditioning shuffles the user can flag the
// current sound as "too high" (screechy — swipe the recap row RIGHT) or "too low"
// (quiet/inaudible — swipe LEFT). Reports accumulate in localStorage as two
// separate logs and export as two JSON files from the ≡ menu, for offline tuning
// of the shuffle guards. Each report carries the FULL parameter snapshot, so a
// flagged sound can be reproduced and measured exactly.

export type ReportKind = "high" | "low";

export interface SoundReport {
  at: string;             // ISO timestamp of the swipe
  name: string;           // the generated recap name (the sound's identity)
  seed?: string;          // seed of the LAST shuffle, when one was rolled
  tempo: number;          // bpm when flagged (synced echoes/LFOs depend on it)
  gain?: number;          // loudness makeup that was applied (see VoiceNode.gain)
  pitch: [number, number];
  snapshot: number[];     // full parameter values — reproduces the sound
}

const KEYS: Record<ReportKind, string> = {
  high: "msq010.reports.high",
  low: "msq010.reports.low",
};
const MAX_REPORTS = 200; // per log — oldest dropped so localStorage stays small

function read(kind: ReportKind): SoundReport[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEYS[kind]) ?? "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Append a report to its log. Returns the log's new size. */
export function addReport(kind: ReportKind, report: SoundReport): number {
  const arr = read(kind);
  arr.push(report);
  while (arr.length > MAX_REPORTS) arr.shift();
  try {
    localStorage.setItem(KEYS[kind], JSON.stringify(arr));
  } catch {
    /* quota — reporting is best-effort */
  }
  return arr.length;
}

export function reportCount(kind: ReportKind): number {
  return read(kind).length;
}

export function clearReports(): void {
  localStorage.removeItem(KEYS.high);
  localStorage.removeItem(KEYS.low);
}

/** Download one log as a JSON file (euclid-too-high.json / euclid-too-low.json). */
export function exportReports(kind: ReportKind): void {
  const json = { version: 1, kind, exportedAt: new Date().toISOString(), reports: read(kind) };
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `euclid-too-${kind}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
