/** Seeded PRNG (mulberry32) so sampling-based algorithms are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k distinct integers from [0, n) chosen deterministically from `seed`, ascending. */
export function sampleIndices(n: number, k: number, seed: number): Uint32Array {
  if (k >= n) {
    const all = new Uint32Array(n);
    for (let i = 0; i < n; i++) all[i] = i;
    return all;
  }
  const rnd = mulberry32(seed);
  // Floyd's algorithm: O(k) memory, deterministic
  const chosen = new Set<number>();
  for (let j = n - k; j < n; j++) {
    const t = Math.floor(rnd() * (j + 1));
    chosen.add(chosen.has(t) ? j : t);
  }
  return Uint32Array.from(chosen).sort();
}
