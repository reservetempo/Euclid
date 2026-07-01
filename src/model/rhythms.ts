// Preset rhythm library: global dance-music grooves on a 16-step grid. Adapted from
// a 16-step-sequencer JSON (tempos dropped — this app has its own tempo). Each track
// is 16 values of 1 (hit) / 0 (rest); the Steps view lets you assign a saved sound to
// each track and lay the pattern onto a grid's rows. Track names are display labels.

export interface Rhythm {
  name: string;
  genre: string;
  tracks: { name: string; steps: number[] }[]; // ordered; each steps[] is length 16
}

export const RHYTHMS: Rhythm[] = [
  {
    name: "House / Techno",
    genre: "Four-on-the-Floor",
    tracks: [
      { name: "Kick", steps: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] },
      { name: "Snare/Clap", steps: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
      { name: "Hi-Hat Open", steps: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0] },
      { name: "Hi-Hat Closed", steps: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] },
    ],
  },
  {
    name: "Dembow (Reggaeton)",
    genre: "Reggaeton / Latin Pop",
    tracks: [
      { name: "Kick", steps: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] },
      { name: "Snare", steps: [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0] },
      { name: "Hi-Hat", steps: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] },
    ],
  },
  {
    name: "2-Step Garage",
    genre: "UK Garage",
    tracks: [
      { name: "Kick", steps: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0] },
      { name: "Snare", steps: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
      { name: "Hi-Hat Closed", steps: [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0] },
    ],
  },
  {
    name: "Boom Bap",
    genre: "Hip-Hop / Breaks",
    tracks: [
      { name: "Kick", steps: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0] },
      { name: "Snare", steps: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
      { name: "Hi-Hat", steps: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] },
    ],
  },
  {
    name: "Trap (Half-Time)",
    genre: "Trap / Modern Hip-Hop",
    tracks: [
      { name: "Kick", steps: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0] },
      { name: "Snare", steps: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] },
      { name: "Hi-Hat", steps: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
    ],
  },
  {
    name: "Dubstep",
    genre: "Dubstep / Bass Music",
    tracks: [
      { name: "Kick", steps: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { name: "Snare", steps: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] },
      { name: "Hi-Hat", steps: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] },
    ],
  },
  {
    name: "Drum & Bass",
    genre: "Drum & Bass / Jungle",
    tracks: [
      { name: "Kick", steps: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0] },
      { name: "Snare", steps: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
      { name: "Hi-Hat", steps: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] },
    ],
  },
  {
    name: "Disco",
    genre: "Disco / Nu-Disco",
    tracks: [
      { name: "Kick", steps: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] },
      { name: "Snare", steps: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
      { name: "Hi-Hat Closed", steps: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] },
      { name: "Hi-Hat Open", steps: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0] },
    ],
  },
  {
    name: "Afrobeat",
    genre: "Afrobeat",
    tracks: [
      { name: "Kick", steps: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
      { name: "Snare", steps: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
      { name: "Shaker", steps: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
    ],
  },
  {
    name: "Baile Funk",
    genre: "Baile Funk / Brazilian Bass",
    tracks: [
      { name: "Kick", steps: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] },
      { name: "Beatbox Tom", steps: [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0] },
    ],
  },
  {
    name: "Bossa Nova",
    genre: "Bossa Nova / Latin Jazz",
    tracks: [
      { name: "Kick", steps: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] },
      { name: "Rimshot", steps: [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0] },
      { name: "Hi-Hat", steps: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] },
    ],
  },
  {
    name: "UK Drill",
    genre: "UK Drill",
    tracks: [
      { name: "Kick", steps: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] },
      { name: "Snare", steps: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0] },
      { name: "Hi-Hat", steps: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0] },
    ],
  },
];
