// Shared seeded randomness for the placement + melody models. xorshift32, ported
// from engine.js makeRng so a seed rolls the same everywhere it's interpreted.

/** A fresh 32-bit seed. */
export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

/** Deterministic generator over [0,1) for a seed. */
export function rng01(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
