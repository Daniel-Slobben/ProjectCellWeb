// Correctness and speed checks for the worker's stepGameOfLife, current tree against a baseline commit.
// run.mjs builds ./.build/current.mjs and ./.build/baseline.mjs from the worker source; this module is
// imported by run.mjs in Node and by a page in each browser.
import {gol as current} from './.build/current.mjs';
import {gol as baseline} from './.build/baseline.mjs';

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

/** Overwrites the edge cells like the worker's writeBorder does, with the same random bits on every call. */
function randomBorder(n, density, r) {
  const bits = Array.from({length: 4 * n - 4}, () => (r() < density ? 1 : 0));
  return (block) => {
    let k = 0;
    const last = n - 1;
    for (let x = 0; x < n; x++) setBit(block, x * n + last, bits[k++]);
    for (let x = 0; x < n; x++) setBit(block, x * n, bits[k++]);
    for (let y = 1; y < last; y++) setBit(block, y, bits[k++]);
    for (let y = 1; y < last; y++) setBit(block, last * n + y, bits[k++]);
  };
}

/**
 * Steps random blocks for many generations with both versions. The current version must match the
 * naive count on the inner cells, and after the border is written, as in the worker, it must be
 * byte-identical to the baseline.
 */
export function verify({sizes = [3, 4, 5, 8, 31, 32, 33, 63, 64, 65, 96, 100, 127, 128, 500, 512, 1999, 2000]} = {}) {
  const densities = [0, 0.03, 1 / 6, 0.5, 1];
  const failures = [];
  let cases = 0, generations = 0;
  for (const n of sizes) for (const density of densities) {
    current.setBlockSize(n);
    baseline.setBlockSize(n);
    const r = rng(n * 1000 + Math.round(density * 100));
    let a = randomBlock(n, density, r), b = a.slice();
    const gens = n >= 1999 ? 3 : n >= 500 ? 6 : 25;
    for (let g = 0; g < gens; g++) {
      const reference = n <= 512 || g === 0 ? naive(a, n) : null;
      const nextA = current.stepGameOfLife(a), nextB = baseline.stepGameOfLife(b);
      const diff = reference ? firstInnerDifference(nextA, reference, n) : null;
      if (diff) failures.push(`n=${n} density=${density.toFixed(2)} gen=${g}: differs from the naive count at ${diff}`);
      const border = randomBorder(n, density, r);
      border(nextA);
      border(nextB);
      if (nextA.length !== nextB.length || nextA.some((v, i) => v !== nextB[i])) {
        failures.push(`n=${n} density=${density.toFixed(2)} gen=${g}: differs from the baseline`);
      }
      a = nextA;
      b = nextB;
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
  const time = (step) => {
    let block = start;
    const t0 = performance.now();
    for (let g = 0; g < gens; g++) block = step(block);
    return (performance.now() - t0) / gens;
  };
  for (let w = 0; w < 3; w++) { time(baseline.stepGameOfLife); time(current.stepGameOfLife); }
  const baselineMs = [], currentMs = [];
  for (let r = 0; r < rounds; r++) {
    if (r % 2) { baselineMs.push(time(baseline.stepGameOfLife)); currentMs.push(time(current.stepGameOfLife)); }
    else { currentMs.push(time(current.stepGameOfLife)); baselineMs.push(time(baseline.stepGameOfLife)); }
  }
  const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  return {n, baselineMs: +median(baselineMs).toFixed(2), currentMs: +median(currentMs).toFixed(2),
    ratio: +(median(currentMs) / median(baselineMs)).toFixed(2)};
}
