// TRACK NAME generator: coins a fresh pronounceable word by stringing syllables from
// three shuffleable pools — an onset (consonant / cluster, sometimes none so a word can
// open on a vowel), a vowel or vowel-combo nucleus, and an occasional nasal-ish coda
// ("n", "en", "on", "m", …). Words run 2–3 syllables and read like invented names:
// "Enon", "Onavel", "Tuveli", "Shaenor".
//
// The pools are held in shuffled BAGS drawn in order (wrapping) so a run of names doesn't
// repeat the same picks; reshuffleNames() re-permutes every bag, so each New Project opens
// a whole fresh ordering (see App.newProject). Draw order is what changes — the alphabet
// of pieces is fixed, the sequence they're spent in is not.

const ONSETS = [
  "b", "c", "d", "f", "g", "h", "j", "k", "l", "m", "n", "p", "r", "s", "t", "v", "w", "z",
  "bl", "br", "cl", "cr", "dr", "fl", "fr", "gl", "gr", "pl", "pr", "sl", "sm", "sn", "sp",
  "st", "sw", "tr", "th", "sh", "ch", "ph", "kr", "vr", "thr", "str",
];
const SINGLE_VOWELS = ["a", "e", "i", "o", "u"];
const COMBO_VOWELS = [
  "ae", "ai", "au", "ea", "ee", "ei", "eo", "eu", "ia", "ie", "io", "oa",
  "oe", "oi", "oo", "ou", "ua", "ue", "ui", "ya", "yo", "ao",
];
// Codas that close a syllable. The vowel-initial nasal pieces ("en"/"on"/…) the design
// calls for only follow a SINGLE-vowel nucleus (see below), so a syllable never stacks a
// combo onto them; the pure-consonant codas can close either.
const CODAS_CONS = ["n", "m", "r", "l", "s"];
const CODAS_NASAL = ["en", "on", "an", "in", "un", "el", "or", "ar"];

// A small seeded RNG so a given name is reproducible from its seed (used nowhere critical,
// but lets the generator be deterministic when handed one). Mulberry32.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Shuffleable bag: a permuted copy of a pool, drawn in order and wrapping. Reshuffling
// re-permutes it, so the sequence of picks changes wholesale.
class Bag {
  private order: number[] = [];
  private i = 0;
  constructor(private readonly pool: readonly string[]) { this.reshuffle(Math.random); }
  reshuffle(rand: () => number): void {
    this.order = this.pool.map((_, k) => k);
    for (let k = this.order.length - 1; k > 0; k--) {
      const j = (rand() * (k + 1)) | 0;
      [this.order[k], this.order[j]] = [this.order[j], this.order[k]];
    }
    this.i = 0;
  }
  next(): string {
    const v = this.pool[this.order[this.i % this.order.length]];
    this.i++;
    return v;
  }
}

const onsetBag = new Bag(ONSETS);
const singleBag = new Bag(SINGLE_VOWELS);
const comboBag = new Bag(COMBO_VOWELS);
const consCodaBag = new Bag(CODAS_CONS);
const nasalCodaBag = new Bag(CODAS_NASAL);

/** Re-permute every pool so the next stretch of generated names draws in a fresh order.
    Call on New Project. */
export function reshuffleNames(seed?: number): void {
  const rand = seed === undefined ? Math.random : rng(seed);
  onsetBag.reshuffle(rand);
  singleBag.reshuffle(rand);
  comboBag.reshuffle(rand);
  consCodaBag.reshuffle(rand);
  nasalCodaBag.reshuffle(rand);
}

/** Coin a fresh track name: 2–3 syllables drawn from the shuffled bags, first letter
    capitalised. `rand` defaults to Math.random; pass a seeded one for reproducibility. */
export function generateTrackName(rand: () => number = Math.random): string {
  const syllables = rand() < 0.5 ? 2 : 3;
  let word = "";
  for (let s = 0; s < syllables; s++) {
    // The first syllable may open on a bare vowel (~35%), and then keeps a single vowel so
    // a word never opens on a triple-vowel pileup; every later syllable takes an onset
    // consonant, which also stops vowels running across the syllable seam.
    const bareVowelStart = s === 0 && rand() < 0.35;
    if (!bareVowelStart) word += onsetBag.next();
    const combo = !bareVowelStart && rand() < 0.3; // ~30% of nuclei are diphthongs
    word += combo ? comboBag.next() : singleBag.next();
    // A coda closes some syllables — commoner at the end so words land on "…en"/"…on".
    // Only a single-vowel nucleus may take a vowel-initial nasal coda (keeps it sayable);
    // a combo nucleus can only take a pure-consonant coda.
    const codaChance = s === syllables - 1 ? 0.55 : 0.28;
    if (rand() < codaChance) {
      let coda = combo || rand() < 0.4 ? consCodaBag.next() : nasalCodaBag.next();
      // Don't double a vowel across the seam (single "a" + "an" → "aan"): fall back to a
      // consonant coda when the nasal piece would repeat the nucleus's last letter.
      if (coda[0] === word[word.length - 1]) coda = consCodaBag.next();
      word += coda;
    }
  }
  if (word.length > 10) word = word.slice(0, 9);
  return word.charAt(0).toUpperCase() + word.slice(1);
}
