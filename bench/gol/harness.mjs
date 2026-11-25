// Correctness and speed checks for the worker's Game of Life step, current tree against a baseline commit.
// run.mjs builds ./.build/current.mjs and ./.build/baseline.mjs from the worker source; this module is
// imported by run.mjs in Node and by a page in each browser.
import {worker as current} from './.build/current.mjs';
import {worker as baseline} from './.build/baseline.mjs';

function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const getBit = (b, i) => (b[i >>> 3] >> (i & 7)) & 1;
const setBit = (b, i, v) => { if (v) b[i >>> 3] |= 1 << (i & 7); else b[i >>> 3] &= ~(1 << (i & 7)); };

/** A block in the worker's layout: bit x * n + y. */
function randomBlock(n, density, r) {
  const b = new Uint8Array(Math.ceil(n * n / 8));
  for (let i = 0; i < n * n; i++) if (r() < density) setBit(b, i, 1);
  return b;
}

/** One generation of the inner cells, counted cell by cell. */
function naive(prev, n) {
  const next = new Uint8Array(prev.length);
  for (let x = 1; x < n - 1; x++) for (let y = 1; y < n - 1; y++) {
    let count = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) count += getBit(prev, (x + dx) * n + y + dy);
    setBit(next, x * n + y, count === 3 || (count === 2 && getBit(prev, x * n + y)) ? 1 : 0);
  }
  return next;
}

function firstInnerDifference(a, b, n) {
  for (let x = 1; x < n - 1; x++) for (let y = 1; y < n - 1; y++) if (getBit(a, x * n + y) !== getBit(b, x * n + y)) return `x=${x} y=${y}`;
  return null;
}

/** A BORDER payload as the worker's writeBorder reads it, of random cells. */
function randomBorder(n, density, r, compress) {
  const bits = new Uint8Array(Math.ceil((4 * n - 4) / 8));
  for (let i = 0; i < 4 * n - 4; i++) if (r() < density) setBit(bits, i, 1);
  return new Uint8Array(compress(bits));
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Steps random blocks for many generations with both versions, a random border written after each step, as in the
 * worker. The current version must match the naive count on the inner cells, and the baseline on every cell and on
 * the image at a pool factor that changes every few generations.
 */
export async function verify({sizes = [3, 4, 5, 8, 31, 32, 33, 63, 64, 65, 96, 100, 127, 128, 500, 512, 1999, 2000]} = {}) {
  const {zstdCompressSync} = await import('node:zlib');
  await Promise.all([current.zstdReady, baseline.zstdReady]);
  const densities = [0, 0.03, 1 / 6, 0.5, 1];
  const pools = [16, 16, 16, 8, 8, 8, 2, 32, 32, 32, 1, 64, 64, 64, 4, 16, 16];
  const failures = [];
  let cases = 0, generations = 0;
  for (const n of sizes) for (const density of densities) {
    current.setBlockSize(n);
    baseline.setBlockSize(n);
    const r = rng(n * 1000 + Math.round(density * 100));
    const start = randomBlock(n, density, r);
    const a = current.load(start), b = baseline.load(start.slice());
    const gens = n >= 1999 ? 8 : n >= 500 ? 17 : 34;
    for (let g = 0; g < gens; g++) {
      const pf = pools[g % pools.length];
      current.setPoolFactor(pf);
      baseline.setPoolFactor(pf);
      const reference = n <= 512 || g === 0 ? naive(current.bits(a), n) : null;
      current.step(a);
      baseline.step(b);
      const diff = reference ? firstInnerDifference(current.bits(a), reference, n) : null;
      const at = `n=${n} density=${density.toFixed(2)} gen=${g}`;
      if (diff) failures.push(`${at}: differs from the naive count at ${diff}`);
      const border = randomBorder(n, density, r, zstdCompressSync);
      for (const [version, state] of [[current, a], [baseline, b]]) {
        version.writeBorder(border, state);
        version.recount(state);
      }
      if (!same(current.bits(a), baseline.bits(b))) failures.push(`${at}: cells differ from the baseline`);
      const imageA = current.image(a), imageB = baseline.image(b);
      if (imageA.width !== imageB.width || !same(imageA.data, imageB.data)) failures.push(`${at} pf=${pf}: image differs from the baseline`);
      generations++;
    }
    cases++;
  }
  return {cases, generations, failures: failures.slice(0, 10), failureCount: failures.length};
}

/** Median ms per generation of an n x n block at density 1/6, baseline and current interleaved. */
export function bench({n = 2000, rounds = 9, gens = 10} = {}) {
  current.setBlockSize(n);
  baseline.setBlockSize(n);
  const start = randomBlock(n, 1 / 6, rng(42));
  const time = (version) => {
    const state = version.load(start.slice());
    const t0 = performance.now();
    for (let g = 0; g < gens; g++) version.step(state);
    return (performance.now() - t0) / gens;
  };
  for (let w = 0; w < 3; w++) { time(baseline); time(current); }
  const baselineMs = [], currentMs = [];
  for (let r = 0; r < rounds; r++) {
    if (r % 2) { baselineMs.push(time(baseline)); currentMs.push(time(current)); }
    else { currentMs.push(time(current)); baselineMs.push(time(baseline)); }
  }
  const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  return {n, baselineMs: +median(baselineMs).toFixed(2), currentMs: +median(currentMs).toFixed(2),
    ratio: +(median(currentMs) / median(baselineMs)).toFixed(2)};
}
