// Replays a recording through the decode worker's own functions and times each step of a tick per block. run.mjs builds
// ./.build/worker.mjs from decompress-block.worker.ts; this module is imported in Node, and in each browser by a worker.
import {worker as w} from './.build/worker.mjs';

/** The FULL and the BORDERs per block of a recording by record.mjs. */
export function parseRecording(buffer) {
  const newline = buffer.indexOf(10);
  const header = JSON.parse(new TextDecoder().decode(buffer.subarray(0, newline)));
  const blocks = new Map();
  for (const frame of w.readBlockFrame(buffer.subarray(newline + 1))) {
    const key = `${frame.x}/${frame.y}`;
    if (frame.type === 0) blocks.set(key, {full: frame.cells, generation: frame.generation, borders: []});
    else blocks.get(key).borders.push(frame);
  }
  return {blockSize: header.blockSize, blocks: [...blocks.values()]};
}

const now = () => performance.now();
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

/**
 * Per block: its FULL, then a tick per BORDER: the GoL step, the border written, and per pool factor the image and the
 * bitmap. Every pool factor gets the same cells, interleaved, so a busy moment hits them all alike.
 */
export async function run(buffer, {pfs = [1, 2, 4, 8, 16, 32], generations = 20, blocks: maxBlocks = 0, bitmaps = true} = {}) {
  await w.zstdReady;
  const {blockSize, blocks} = parseRecording(buffer);
  const replay = maxBlocks ? blocks.slice(0, maxBlocks) : blocks;
  w.setBlockSize(blockSize);
  bitmaps &&= typeof OffscreenCanvas !== 'undefined' || typeof createImageBitmap !== 'undefined';
  const times = {full: [], step: [], border: [], gaps: 0};
  for (const pf of pfs) times[`image${pf}`] = [], times[`bitmap${pf}`] = [];

  const tick = async (cells, border, record) => {
    let t0 = now();
    const next = w.stepGameOfLife(cells);
    let t1 = now();
    w.writeBorder(border.cells, next);
    const t2 = now();
    if (record) times.step.push(t1 - t0), times.border.push(t2 - t1);
    for (const pf of pfs) {
      w.setPoolFactor(pf);
      t0 = now();
      const image = w.decodeByteArrayToImageData(next);
      t1 = now();
      if (bitmaps) (await w.toBitmap(image)).close();
      if (record) times[`image${pf}`].push(t1 - t0), times[`bitmap${pf}`].push(now() - t1);
    }
    return next;
  };

  // warm-up, not recorded
  for (const block of replay.slice(0, 2)) {
    let cells = w.decodeFull(block.full);
    for (const border of block.borders.slice(0, 3)) cells = await tick(cells, border, false);
  }

  for (const block of replay) {
    const t0 = now();
    let cells = w.decodeFull(block.full);
    times.full.push(now() - t0);
    let generation = block.generation;
    for (const border of block.borders.slice(0, generations)) {
      if (border.generation !== ++generation) times.gaps++;
      cells = await tick(cells, border, true);
    }
  }

  const ms = (a) => ({avg: +avg(a).toFixed(3), p90: +pct(a, 0.9).toFixed(3)});
  return {
    blockSize, blocks: replay.length, ticks: times.step.length, gaps: times.gaps, bitmaps,
    full: ms(times.full), step: ms(times.step), border: ms(times.border),
    pools: pfs.map((pf) => ({pf, image: ms(times[`image${pf}`]), bitmap: bitmaps ? ms(times[`bitmap${pf}`]) : null})),
  };
}

const bitCount = (v) => {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/** The rows of a block (bit x * size + y) as 32-cell words. */
function rowWords(bits, size) {
  const words = (size + 31) >>> 5;
  const rows = Array.from({length: size}, () => new Int32Array(words));
  for (let x = 0; x < size; x++) {
    for (let y = 0, bit = x * size; y < size; y++, bit++) {
      if ((bits[bit >>> 3] >> (bit & 7)) & 1) rows[x][y >>> 5] |= 1 << (y & 31);
    }
  }
  return rows;
}

/** The share of words of rows whose 3 x 3 words around them hold a marked one. */
function near(marks, size, words) {
  let count = 0;
  for (let x = 0; x < size; x++) {
    for (let i = 0; i < words; i++) {
      let hit = false;
      for (let dx = -1; dx <= 1 && !hit; dx++) {
        const row = marks[x + dx];
        if (row) for (let di = -1; di <= 1 && !hit; di++) hit = row[i + di] !== 0 && row[i + di] !== undefined;
      }
      if (hit) count++;
    }
  }
  return count / (size * words);
}

/** The share of pf x pf patches with a cell that differs between a and b. */
function patchesChanged(a, b, size, pf) {
  const patches = Math.ceil(size / pf), hit = new Uint8Array(patches * patches);
  for (let x = 0; x < size; x++) {
    for (let i = 0; i < a[x].length; i++) {
      for (let diff = a[x][i] ^ b[x][i]; diff !== 0; diff &= diff - 1) {
        hit[Math.floor(x / pf) * patches + Math.floor((i * 32 + 31 - Math.clz32(diff & -diff)) / pf)] = 1;
      }
    }
  }
  return hit.reduce((s, v) => s + v, 0) / hit.length;
}

/**
 * How much of a block a tick touches, as shares of its 32-cell words and of its patches. A step that skips empty space
 * computes the words near a live cell. A step that writes over the generation before, like the backend's AlgorithmGol,
 * computes the words near a word that differs from two generations back; one that writes in place, those near a word that
 * differs from the generation before. Patch counts kept per cell array need recounting where cells differ from that
 * array's generation: one or two generations back.
 */
export async function activity(buffer, {generations = 20, blocks: maxBlocks = 0, pfs = [8, 16, 32]} = {}) {
  await w.zstdReady;
  const {blockSize: size, blocks} = parseRecording(buffer);
  w.setBlockSize(size);
  const words = (size + 31) >>> 5;
  const shares = {'live cells': [], 'empty rows': [], 'words changed since the generation before': [],
    'step words near a live cell': [], 'step words near a change from the generation before': [],
    'step words near a change from two generations back': [], 'whole blocks as two generations back': []};
  for (const pf of pfs) shares[`pf ${pf} patches changed since the generation before`] = [], shares[`pf ${pf} patches changed since two generations back`] = [];
  for (const block of maxBlocks ? blocks.slice(0, maxBlocks) : blocks) {
    let cells = w.decodeFull(block.full);
    const history = [rowWords(cells, size)];
    for (const border of block.borders.slice(0, generations)) {
      cells = w.stepGameOfLife(cells);
      w.writeBorder(border.cells, cells);
      history.unshift(rowWords(cells, size));
      if (history.length < 3) continue;
      const [current, before, twoBack] = history;
      history.length = 2;
      let live = 0, emptyRows = 0;
      const diff1 = current.map((row, x) => row.map((v, i) => v ^ before[x][i]));
      const diff2 = current.map((row, x) => row.map((v, i) => v ^ twoBack[x][i]));
      for (let x = 0; x < size; x++) {
        let any = 0;
        for (let i = 0; i < words; i++) {
          live += bitCount(current[x][i]);
          any |= current[x][i];
        }
        if (!any) emptyRows++;
      }
      shares['live cells'].push(live / (size * size));
      shares['empty rows'].push(emptyRows / size);
      shares['words changed since the generation before'].push(diff1.reduce((s, row) => s + row.filter((v) => v !== 0).length, 0) / (size * words));
      shares['step words near a live cell'].push(near(current, size, words));
      shares['step words near a change from the generation before'].push(near(diff1, size, words));
      shares['step words near a change from two generations back'].push(near(diff2, size, words));
      shares['whole blocks as two generations back'].push(diff2.every((row) => row.every((v) => v === 0)) ? 1 : 0);
      for (const pf of pfs) {
        shares[`pf ${pf} patches changed since the generation before`].push(patchesChanged(current, before, size, pf));
        shares[`pf ${pf} patches changed since two generations back`].push(patchesChanged(current, twoBack, size, pf));
      }
    }
  }
  const share = (a) => ({avg: +avg(a).toFixed(4), p90: +pct(a, 0.9).toFixed(4), max: +Math.max(...a).toFixed(4)});
  return Object.fromEntries(Object.entries(shares).map(([k, v]) => [k, share(v)]));
}
