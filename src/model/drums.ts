// The drum palette. The engine supports all 12 of the desktop app's drums (the
// indices are preserved so the per-drum range tables line up), but the mobile
// app ships with these five to start.

export enum DrumType {
  Kick = 0,
  Snare,
  Clap,
  ClosedHat,
  OpenHat,
  LowTom,
  MidTom,
  HighTom,
  Rim,
  Cowbell,
  Wobble,
  SynthBass,
}

export interface DrumDef {
  type: DrumType;
  name: string;
  colour: string; // identity colour, also used for painted grid cells
}

// The five drums available in v1, in selector order.
export const DRUMS: DrumDef[] = [
  { type: DrumType.Kick, name: "Kick", colour: "#ff3b30" },
  { type: DrumType.Snare, name: "Snare", colour: "#0a84ff" },
  { type: DrumType.ClosedHat, name: "Hat", colour: "#34c759" },
  { type: DrumType.SynthBass, name: "Bass", colour: "#6c5cff" },
  { type: DrumType.Wobble, name: "Wobble", colour: "#00ffc8" },
];

const COLOUR_BY_TYPE = new Map<number, string>(DRUMS.map((d) => [d.type, d.colour]));
const NAME_BY_TYPE = new Map<number, string>(DRUMS.map((d) => [d.type, d.name]));

/** Identity colour for a drum index (also the painted cell colour). */
export function drumColour(type: number): string {
  return COLOUR_BY_TYPE.get(type) ?? "#888888";
}

export function drumName(type: number): string {
  return NAME_BY_TYPE.get(type) ?? "?";
}
