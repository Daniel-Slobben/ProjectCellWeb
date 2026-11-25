import {ZSTDDecoder} from 'zstddec';
import {getKey, tileBlocks} from './utils.component';
import {BORDER, FramedBlock, FULL, readBlockFrame, readStrips, SECTOR} from './block-frame';
import type {BlockRange} from '../../../requests/outgoing/ClientUpdateRequest';

let blockSize: number;

let poolFactor = 1;
let sectorPoolFactor = 1;
let densityGamma = 0.6;

const blockGenerationMap = new Map<string, number>();
const blocks = new Map<string, Frames>();
const earlyBorders = new Map<string, FramedBlock[]>();
// The share of alive cells per sector, 0-255, of the blocks in the published view that got sectors.
const sectorBlocks = new Map<string, Uint8Array>();
// Tiles whose sectors changed in this message, and the colours they were drawn in.
const changedTiles = new Set<string>();
let tileStyle = '';
let sectorColors = new Int32Array(256);
// The view the server was last sent, and whether it watches sectors. Only what it asks for is kept, until the block
// leaves it: cells or sectors still on their way for a block outside it, or cells after the switch, would stay for good.
let publishedView: BlockRange | null = null;
let publishedSectors = false;
// a safety cap, about 25 seconds of ticks
const maxEarlyBorders = 50;

const zstd = new ZSTDDecoder();
const zstdReady = zstd.init();

let queue = Promise.resolve();

globalThis.onmessage = function (e: any) {
  queue = queue.then(() => handleMessage(e.data));
};

async function handleMessage({type, batchId, payload}: any): Promise<void> {
  const results: any[] = [];
  try {
    await zstdReady;
    await decodeBatch(type, payload, results);
    await drawChangedTiles(results);
  } catch (err) {
    console.error(err);
  }
  self.postMessage({batchId, results}, {transfer: results.flatMap((r) => r.bitmap ? [r.bitmap] : [])});
}

async function decodeBatch(type: string, payload: any, results: any[]): Promise<void> {
  if (type === 'init') {
    blockSize = payload.blockSize;
    return;
  }
  if (payload.poolFactor !== undefined) {
    poolFactor = payload.poolFactor;
    densityGamma = payload.gamma;
    ALIVE = pixelOf(payload.alive);
    DEAD = pixelOf(payload.dead);
    const style = `${payload.sectorPoolFactor} ${payload.alive} ${payload.dead} ${payload.gamma}`;
    if (style !== tileStyle) {
      tileStyle = style;
      sectorPoolFactor = payload.sectorPoolFactor;
      sectorColors = sectorColors.map((_, share) => densityPixel(share / 255));
      for (const key of sectorBlocks.keys()) changedTiles.add(tileOf(key));
    }
  }

  if (type === 'rescale') {
    for (const {x, y} of payload.data) {
      const frames = blocks.get(getKey(x, y));
      if (frames) results.push({bitmap: await toBitmap(imageOf(frames.current)), x, y});
    }
    return;
  }

  if (type === 'view') {
    // Back to sectors, those from before the cells are out of date, and a block pruned meanwhile gets none.
    if (payload.sectors && !publishedSectors) {
      for (const key of sectorBlocks.keys()) changedTiles.add(tileOf(key));
      sectorBlocks.clear();
    }
    publishedView = payload.view;
    publishedSectors = payload.sectors;
    for (const key of sectorBlocks.keys()) {
      const [x, y] = key.split('/').map(Number);
      if (!inPublishedView(x, y)) sectorBlocks.delete(key);
    }
    for (const key of [...blocks.keys(), ...earlyBorders.keys()]) {
      const [x, y] = key.split('/').map(Number);
      if (wantsCells(x, y)) continue;
      const hadCells = blocks.has(key);
      forgetCells(key);
      // its tile shows through, or nothing until its sectors come
      if (hadCells) results.push({x, y});
    }
    return;
  }

  for (const block of readBlockFrame(new Uint8Array(payload.frame))) {
    const key = getKey(block.x, block.y);
    const wanted = block.type === SECTOR ? inPublishedView(block.x, block.y) : wantsCells(block.x, block.y);
    if (!wanted) continue;

    if (block.type === FULL) {
      blocks.set(key, framesOf(decodeFull(block.cells)));
      blockGenerationMap.set(key, block.generation);
      for (const border of takeEarlyBorders(key, block.generation)) {
        stepWithBorder(key, border);
      }
      const bitmap = await toBitmap(imageOf(blocks.get(key)!.current));

      results.push({bitmap, x: block.x, y: block.y});
    } else if (block.type === BORDER) {
      try {
        const seenBlockGeneration = blockGenerationMap.get(key);
        if (seenBlockGeneration === undefined || block.generation - seenBlockGeneration !== 1) {
          keepEarlyBorder(key, block, seenBlockGeneration);
          if (seenBlockGeneration === undefined) continue;
          console.warn(`Saved Block Data is ${block.generation - seenBlockGeneration} generations behind Border Blocks. Has to be exactly 1.`);
          if (block.generation - seenBlockGeneration > 3) {
            results.push({error: true, x: block.x, y: block.y})
          }
          continue;
        }

        stepWithBorder(key, block);
        const bitmap = await toBitmap(imageOf(blocks.get(key)!.current));

        results.push({bitmap, border: true, x: block.x, y: block.y});
      } catch (e) {
        results.push({error: true, x: block.x, y: block.y})
        console.error(e);
      }
    } else if (block.type === SECTOR) {
      sectorBlocks.set(key, zstd.decode(block.cells));
      changedTiles.add(tileOf(key));
    } else {
      console.warn(`Unknown block type ${block.type} for ${key}`);
    }
  }

}

/** Each changed tile again, with which of its blocks have sectors. A tile without any comes without a bitmap. */
async function drawChangedTiles(results: any[]): Promise<void> {
  for (const key of changedTiles) {
    const [x, y] = key.split('/').map(Number);
    const present = new Uint8Array(tileBlocks * tileBlocks);
    const image = tileImage(x, y, present);
    results.push({tile: true, bitmap: image && await toBitmap(image, true), present, x, y});
  }
  changedTiles.clear();
}

/** A pixel per sectorPoolFactor x sectorPoolFactor sectors. Blocks without sectors stay transparent. */
function tileImage(tileX: number, tileY: number, present: Uint8Array): ImageData | undefined {
  let image: ImageData | undefined;
  for (let i = 0; i < present.length; i++) {
    const blockX = i % tileBlocks, blockY = Math.floor(i / tileBlocks);
    const sectors = sectorBlocks.get(getKey(tileX * tileBlocks + blockX, tileY * tileBlocks + blockY));
    if (!sectors) continue;
    const size = Math.sqrt(sectors.length), pooled = Math.ceil(size / sectorPoolFactor);
    if (!image) {
      image = imageOfSize(tileBlocks * pooled);
      image.data.fill(0);
    }
    poolSectors(sectors, size, new Int32Array(image.data.buffer), image.width, blockX * pooled, blockY * pooled);
    present[i] = 1;
  }
  return image;
}

/**
 * The backend sends the sectors per band down the rows, each band along the row, and its rows are the columns of the
 * picture, like the cells.
 */
function poolSectors(sectors: Uint8Array, size: number, pixels: Int32Array, width: number, left: number, top: number): void {
  const pool = sectorPoolFactor;
  for (let x0 = 0, px = left; x0 < size; x0 += pool, px++) {
    const x1 = Math.min(size, x0 + pool);
    for (let y0 = 0, py = top; y0 < size; y0 += pool, py++) {
      const y1 = Math.min(size, y0 + pool);
      let sum = 0;
      for (let x = x0; x < x1; x++) {
        for (let y = y0; y < y1; y++) sum += sectors[x * size + y];
      }
      pixels[py * width + px] = sectorColors[Math.round(sum / ((x1 - x0) * (y1 - y0)))];
    }
  }
}

function tileOf(key: string): string {
  const [x, y] = key.split('/').map(Number);
  return getKey(Math.floor(x / tileBlocks), Math.floor(y / tileBlocks));
}

function inPublishedView(x: number, y: number): boolean {
  return publishedView !== null && x >= publishedView.minX && x <= publishedView.maxX && y >= publishedView.minY && y <= publishedView.maxY;
}

function wantsCells(x: number, y: number): boolean {
  return !publishedSectors && inPublishedView(x, y);
}

function forgetCells(key: string): void {
  blocks.delete(key);
  blockGenerationMap.delete(key);
  earlyBorders.delete(key);
}

function stepWithBorder(key: string, border: FramedBlock): void {
  const frames = blocks.get(key)!;
  step(frames);
  writeBorder(border.cells, frames.current);
  recount(frames.current);
  blockGenerationMap.set(key, border.generation);
}

/**
 * The full block sent for a client-update and the next tick's border go out separately, so the border can come in
 * first. Borders newer than the block we hold are kept, and applied once its full block has come in.
 */
function keepEarlyBorder(key: string, border: FramedBlock, seenGeneration: number | undefined): void {
  if (seenGeneration !== undefined && border.generation <= seenGeneration) return;
  const borders = earlyBorders.get(key) ?? [];
  // copied, so a kept border does not hold on to its whole frame
  borders.push({...border, cells: border.cells.slice()});
  // its full block is not coming, so the borders are of no use
  if (borders.length > maxEarlyBorders) {
    earlyBorders.delete(key);
    return;
  }
  earlyBorders.set(key, borders);
}

/** The kept borders that follow on from this generation, in order. */
function takeEarlyBorders(key: string, generation: number): FramedBlock[] {
  const borders = earlyBorders.get(key) ?? [];
  earlyBorders.delete(key);
  borders.sort((a, b) => a.generation - b.generation);
  const following: FramedBlock[] = [];
  for (const border of borders) {
    if (border.generation === generation + following.length + 1) following.push(border);
  }
  return following;
}

const FULL_STEPS = 2;

interface Frame {
  cells: Int32Array;
  bytes: Uint8Array;
  changed: Int32Array;
  counts: Uint16Array;
  countedPool: number;
}

interface Frames {
  current: Frame;
  previous: Frame;
  fullSteps: number;
}

let lifeSize = 0;
let words = 0;
let rowWords = 0;
let rowBytes = 0;
let markInts = 0;
let lastWordMask = -1;
let innerMask = new Int32Array(0);
let wordMarks = new Int32Array(0);
let nearMarks = new Int32Array(0);
let lifeSource = new Int32Array(0);

function prepareLife(): void {
  if (lifeSize === blockSize) return;
  lifeSize = blockSize;
  words = (blockSize + 31) >>> 5;
  rowWords = words + 2;
  rowBytes = rowWords * 4;
  markInts = (words >>> 5) + 1;
  lastWordMask = blockSize & 31 ? (1 << (blockSize & 31)) - 1 : -1;
  innerMask = new Int32Array(rowWords);
  for (let y = 1; y < blockSize - 1; y++) innerMask[(y >>> 5) + 1] |= 1 << y;
  wordMarks = new Int32Array(markInts);
  for (let i = 1; i <= words; i++) wordMarks[i >>> 5] |= 1 << i;
  nearMarks = new Int32Array(markInts);
  lifeSource = new Int32Array(Math.ceil(blockSize * blockSize / 32) + 1);
}

function newFrame(): Frame {
  const cells = new Int32Array(blockSize * rowWords);
  const changed = new Int32Array(blockSize * markInts);
  return {cells, bytes: new Uint8Array(cells.buffer, 4), changed, counts: new Uint16Array(0), countedPool: 0};
}

function framesOf(packed: Uint8Array): Frames {
  prepareLife();
  const current = newFrame();
  new Uint8Array(lifeSource.buffer).set(packed);
  for (let x = 0; x < blockSize; x++) packRow(lifeSource, current.cells, x);
  return {current, previous: newFrame(), fullSteps: FULL_STEPS};
}

/**
 * port of gol algo in backend
 */
function step(frames: Frames): void {
  const source = frames.current, target = frames.previous;
  if (frames.fullSteps > 0) {
    markCells(source, target);
    frames.fullSteps--;
  }
  for (let x = 1; x < blockSize - 1; x++) {
    if (wordsNear(source.changed, x)) {
      stepRow(source.cells, target.cells, x, target.changed);
    } else {
      for (let k = x * markInts; k < (x + 1) * markInts; k++) target.changed[k] = 0;
    }
  }
  for (let k = 0; k < markInts; k++) target.changed[k] = target.changed[(blockSize - 1) * markInts + k] = 0;
  frames.current = target;
  frames.previous = source;
}

function markCells(source: Frame, target: Frame): void {
  source.changed.fill(0);
  for (let x = 0; x < blockSize; x++) markRow(source, target, x);
}

function markRow(source: Frame, target: Frame, x: number): void {
  for (let i = 1, w = x * rowWords + 1; i <= words; i++, w++) {
    if ((source.cells[w] | target.cells[w]) !== 0) source.changed[x * markInts + (i >>> 5)] |= 1 << i;
  }
}

function wordsNear(changed: Int32Array, x: number): boolean {
  let any = 0;
  for (let k = 0, i = (x - 1) * markInts; k < markInts; k++, i++) {
    nearMarks[k] = changed[i] | changed[i + markInts] | changed[i + 2 * markInts];
    any |= nearMarks[k];
  }
  if (any === 0) return false;
  let lower = 0;
  for (let k = 0; k < markInts; k++) {
    const marks = nearMarks[k], higher = k + 1 < markInts ? nearMarks[k + 1] : 0;
    nearMarks[k] = (marks | marks << 1 | marks >>> 1 | lower >>> 31 | higher << 31) & wordMarks[k];
    lower = marks;
  }
  return true;
}

function stepRow(cells: Int32Array, next: Int32Array, x: number, changed: Int32Array): void {
  for (let k = 0; k < markInts; k++) {
    let todo = nearMarks[k], marks = 0;
    while (todo !== 0) {
      const from = lowestBit(todo), gap = ~todo & (-1 << from), to = gap === 0 ? 32 : lowestBit(gap);
      todo = to === 32 ? 0 : todo & (-1 << to);
      marks |= stepWords(cells, next, x * rowWords, (k << 5) + from, (k << 5) + to);
    }
    changed[x * markInts + k] = marks;
  }
}

function lowestBit(bits: number): number {
  return 31 - Math.clz32(bits & -bits);
}

function stepWords(cells: Int32Array, next: Int32Array, middle: number, from: number, to: number): number {
  const upper = middle - rowWords, down = middle + rowWords;
  let upperBefore = cells[upper + from - 1], upperWord = cells[upper + from];
  let middleBefore = cells[middle + from - 1], middleWord = cells[middle + from];
  let downBefore = cells[down + from - 1], downWord = cells[down + from];
  let marks = 0;
  for (let i = from; i < to; i++) {
    const upperAfter = cells[upper + i + 1], middleAfter = cells[middle + i + 1], downAfter = cells[down + i + 1];
    // neighbours to the left / right: shift the word and pull in the edge bit of the adjacent word
    const upperWordLeft = (upperWord << 1) | (upperBefore >>> 31);
    const upperWordRight = (upperWord >>> 1) | (upperAfter << 31);
    const middleWordLeft = (middleWord << 1) | (middleBefore >>> 31);
    const middleWordRight = (middleWord >>> 1) | (middleAfter << 31);
    const downWordLeft = (downWord << 1) | (downBefore >>> 31);
    const downWordRight = (downWord >>> 1) | (downAfter << 31);

    // per row: 2-bit sum of the neighbours in that row (twos bit: 0 or 1 neighbours = 0, 2 or 3 neighbours = 1)
    const upperEitherLeftOrMiddle = upperWordLeft ^ upperWord;
    const upperOddNumberAlive = upperEitherLeftOrMiddle ^ upperWordRight;
    const upperTwosBitNeighbours = (upperWordLeft & upperWord) | (upperEitherLeftOrMiddle & upperWordRight);
    const middleOddNumberAlive = middleWordLeft ^ middleWordRight;
    const middleTwosBit = middleWordLeft & middleWordRight;
    const downEitherLeftOrMiddle = downWordLeft ^ downWord;
    const downOddNumberAlive = downEitherLeftOrMiddle ^ downWordRight;
    const downTwosBitNeighbours = (downWordLeft & downWord) | (downEitherLeftOrMiddle & downWordRight);

    const upperOrMiddleIsOdd = upperOddNumberAlive ^ middleOddNumberAlive;
    const combinedOddNumberAlive = upperOrMiddleIsOdd ^ downOddNumberAlive;
    const combinedOddNumberCarry = (upperOddNumberAlive & middleOddNumberAlive) | (upperOrMiddleIsOdd & downOddNumberAlive);

    // 2 or 3 neighbours <=> exactly one of the four "twos" bits is set
    const p = upperTwosBitNeighbours ^ middleTwosBit;
    const q = upperTwosBitNeighbours & middleTwosBit;
    const r = downTwosBitNeighbours ^ combinedOddNumberCarry;
    const t = downTwosBitNeighbours & combinedOddNumberCarry;
    const twoOrThree = (p ^ r) & ~(q | t);

    // 3 neighbours: born or survives, 2 neighbours: survives only if alive
    const state = twoOrThree & (combinedOddNumberAlive | middleWord);
    const old = next[middle + i];
    const changed = (state ^ old) & innerMask[i];
    next[middle + i] = old ^ changed;
    marks |= ((changed | -changed) >>> 31) << i;

    upperBefore = upperWord;
    upperWord = upperAfter;
    middleBefore = middleWord;
    middleWord = middleAfter;
    downBefore = downWord;
    downWord = downAfter;
  }
  return marks;
}

function packRow(source: Int32Array, cells: Int32Array, x: number): void {
  const bit = x * blockSize;
  const first = (bit >>> 5) - 1;
  const shift = bit & 31;
  const row = x * rowWords;
  if (shift === 0) {
    for (let i = 1; i <= words; i++) cells[row + i] = source[first + i];
  } else {
    for (let i = 1; i <= words; i++) cells[row + i] = (source[first + i] >>> shift) | (source[first + i + 1] << (32 - shift));
  }
  cells[row + words] &= lastWordMask;
}

const OPAQUE = Math.trunc(0xff000000); // A = 255
let ALIVE = OPAQUE;
let DEAD = -1;

/** '#rrggbb' as an opaque pixel, little-endian like the ImageData buffer: R in the low byte. */
function pixelOf(hex: string): number {
  const rgb = parseInt(hex.slice(1), 16);
  return OPAQUE | ((rgb & 0xff) << 16) | (rgb & 0xff00) | (rgb >> 16);
}

/** The dead colour for 0, the alive colour for 1. */
function cellPixel(bit: number): number {
  return DEAD ^ (-bit & (ALIVE ^ DEAD));
}
const POPCOUNT = new Uint8Array(256).map((_, b) => {
  let n = 0;
  for (let v = b; v; v &= v - 1) n++;
  return n;
});

let scratchImage: ImageData | undefined;

function imageOfSize(size: number): ImageData {
  if (scratchImage?.width !== size) scratchImage = new ImageData(size, size);
  return scratchImage;
}

// Chrome and Firefox make bitmaps faster through an opaque OffscreenCanvas than with createImageBitmap,
// which they largely run one worker at a time, and Chrome's are GPU-backed, so drawing one does not
// upload 16 MB on the main thread. Safari's WebKit transfers those bitmaps slowly, so it keeps
// createImageBitmap. Both give identical pixels.
const canvasBitmaps = typeof OffscreenCanvas !== 'undefined'
  && !(/AppleWebKit/.test(navigator.userAgent) && !/Chrome\//.test(navigator.userAgent));
let bitmapCanvas: OffscreenCanvas | undefined;
let bitmapContext: OffscreenCanvasRenderingContext2D | null = null;
let bitmapAlpha = false;

async function toBitmap(image: ImageData, alpha = false): Promise<ImageBitmap> {
  if (!canvasBitmaps) return createImageBitmap(image);
  if (bitmapCanvas?.width !== image.width || bitmapCanvas.height !== image.height || bitmapAlpha !== alpha
    || bitmapContext?.isContextLost?.()) {
    bitmapCanvas = new OffscreenCanvas(image.width, image.height);
    bitmapContext = bitmapCanvas.getContext('2d', {alpha});
    bitmapAlpha = alpha;
  }
  bitmapContext!.putImageData(image, 0, 0);
  return bitmapCanvas.transferToImageBitmap();
}

function decodePooledImageData(frame: Frame): ImageData {
  const shift = Math.log2(poolFactor);
  const size = Math.ceil(blockSize / poolFactor);
  let counts: Uint16Array;
  if (poolFactor >= 8) {
    countPatches(frame, size, shift);
    counts = frame.counts;
  } else {
    counts = new Uint16Array(size * size);
    if ((blockSize & 7) === 0) {
      countPatchesByByte(frame.bytes, counts, size, shift);
    } else {
      countPatchesByCell(frame.bytes, counts, size, shift);
    }
  }

  // Patch sizes along each axis; only the last row/column can be partial.
  const fullEdge = blockSize % poolFactor === 0 ? poolFactor : blockSize % poolFactor;
  const imageData = imageOfSize(size);
  const pixels = new Int32Array(imageData.data.buffer);

  // Every full patch has the same denominator, so its colours come from a table.
  const fullPatch = poolFactor * poolFactor;
  const fullColors = new Int32Array(fullPatch + 1);
  for (let n = 0; n <= fullPatch; n++) fullColors[n] = densityPixel(n / fullPatch);

  // counts is row-major like the pixels: counts[py * size + px].
  for (let py = 0; py < size; py++) {
    const cellsY = py === size - 1 ? fullEdge : poolFactor;
    colorPatchRow(counts, pixels, py * size, size, cellsY, fullEdge, fullColors);
  }
  return imageData;
}

// Hot loops below live in small per-row functions: V8 then optimises them as ordinary calls
// instead of on-stack-replacing a whole-block loop, which kept deoptimising on every inner exit.
function colorPatchRow(counts: Uint16Array, pixels: Int32Array, start: number, size: number, cellsY: number, fullEdge: number, fullColors: Int32Array): void {
  const last = start + size - 1;
  if (cellsY === poolFactor) {
    for (let i = start; i < last; i++) pixels[i] = fullColors[counts[i]];
  } else {
    for (let i = start; i < last; i++) pixels[i] = densityPixel(counts[i] / (poolFactor * cellsY));
  }
  pixels[last] = densityPixel(counts[last] / (fullEdge * cellsY));
}

/** Between the dead and the alive colour, by the share of alive cells. */
function densityPixel(density: number): number {
  const t = Math.pow(density, densityGamma);
  let pixel = OPAQUE;
  for (let shift = 0; shift < 24; shift += 8) {
    const dead = (DEAD >> shift) & 0xff, alive = (ALIVE >> shift) & 0xff;
    pixel |= Math.round(dead + (alive - dead) * t) << shift;
  }
  return pixel;
}

/**
 * Alive cells per patch when blockSize is a multiple of 8, so every byte holds 8 cells of one
 * column (bit k = row y0 + k). Sums a patch's columns a byte at a time, eight rows per pass.
 */
function countPatchesByByte(packed: Uint8Array, counts: Uint16Array, size: number, shift: number): void {
  const n = blockSize;
  const stride = rowBytes; // bytes per column
  if (poolFactor < 8) {
    // A byte spans 8 / poolFactor patch rows. byteCounts[b] holds the alive cells of each in its
    // own 8-bit field, so a patch's columns can be summed in one add each.
    const rowsPerByte = 8 / poolFactor;
    const mask = (1 << poolFactor) - 1;
    const byteCounts = new Int32Array(256);
    for (let b = 0; b < 256; b++) {
      for (let j = 0; j < rowsPerByte; j++) byteCounts[b] |= POPCOUNT[(b >> (j * poolFactor)) & mask] << (8 * j);
    }
    for (let y0 = 0; y0 < n; y0 += 8) {
      countSmallPatchRows(packed, counts, y0 >>> 3, (y0 >> shift) * size, size, stride, rowsPerByte, byteCounts);
    }
  } else {
    // Eight rows lie inside one patch row; it takes poolFactor / 8 passes to fill it.
    for (let y0 = 0; y0 < n; y0 += 8) {
      countLargePatchRow(packed, counts, y0 >>> 3, (y0 >> shift) * size, size, stride);
    }
  }
}

function countSmallPatchRows(packed: Uint8Array, counts: Uint16Array, byte0: number, row: number, size: number, stride: number, rowsPerByte: number, byteCounts: Int32Array): void {
  const pf = poolFactor;
  const patchStride = pf * stride;
  for (let px = 0, i0 = byte0; px < size; px++, i0 += patchStride) {
    let sum = 0;
    for (let x = 0, i = i0; x < pf; x++, i += stride) sum += byteCounts[packed[i]];
    for (let j = 0, r = row + px; j < rowsPerByte; j++, r += size) counts[r] = (sum >> (8 * j)) & 0xff;
  }
}

function countLargePatchRow(packed: Uint8Array, counts: Uint16Array, byte0: number, row: number, size: number, stride: number): void {
  const pf = poolFactor;
  for (let px = 0, x0 = 0; px < size; px++, x0 += pf) {
    const xEnd = Math.min(blockSize, x0 + pf);
    let sum = 0;
    for (let x = x0, i = x0 * stride + byte0; x < xEnd; x++, i += stride) sum += POPCOUNT[packed[i]];
    counts[row + px] += sum;
  }
}

function countPatches(frame: Frame, size: number, shift: number): void {
  if (frame.countedPool === poolFactor) return;
  if (frame.counts.length !== size * size) frame.counts = new Uint16Array(size * size);
  else frame.counts.fill(0);
  countPatchesByByte(frame.bytes, frame.counts, size, shift);
  frame.countedPool = poolFactor;
}

function recount(frame: Frame): void {
  if (frame.countedPool !== poolFactor) {
    frame.countedPool = 0;
    return;
  }
  const size = Math.ceil(blockSize / poolFactor);
  for (let px = 0; px < size; px++) recountPatchColumn(frame, px, size);
}

function recountPatchColumn(frame: Frame, px: number, size: number): void {
  const first = px * poolFactor, end = Math.min(blockSize, first + poolFactor), shift = Math.log2(poolFactor);
  let counted = -1;
  for (let k = 0; k < markInts; k++) {
    let marks = 0;
    for (let x = first; x < end; x++) marks |= frame.changed[x * markInts + k];
    for (; marks !== 0; marks &= marks - 1) {
      const y = ((k << 5) + lowestBit(marks) - 1) << 5;
      for (let py = Math.max(counted + 1, y >> shift); py <= Math.min(size - 1, (y + 31) >> shift); py++) {
        frame.counts[py * size + px] = countPatch(frame.bytes, first, end, py);
        counted = py;
      }
    }
  }
}

function countPatch(bytes: Uint8Array, first: number, end: number, py: number): number {
  const from = (py * poolFactor) >>> 3, to = Math.min(words * 4, ((py + 1) * poolFactor) >>> 3);
  let sum = 0;
  for (let x = first; x < end; x++) {
    for (let i = x * rowBytes + from; i < x * rowBytes + to; i++) sum += POPCOUNT[bytes[i]];
  }
  return sum;
}

/** Alive cells per patch for any blockSize, one cell at a time. */
function countPatchesByCell(packed: Uint8Array, counts: Uint16Array, size: number, shift: number): void {
  for (let x = 0; x < blockSize; x++) countColumnByCell(packed, counts, x, size, shift);
}

function countColumnByCell(packed: Uint8Array, counts: Uint16Array, x: number, size: number, shift: number): void {
  const n = blockSize;
  const px = x >> shift;
  for (let y = 0, bit = x * rowBytes * 8; y < n; y++, bit++) {
    counts[(y >> shift) * size + px] += (packed[bit >>> 3] >> (bit & 7)) & 1;
  }
}

function imageOf(frame: Frame): ImageData {
  if (poolFactor > 1) {
    return decodePooledImageData(frame);
  }
  const imageData = imageOfSize(blockSize);
  const pixels = new Int32Array(imageData.data.buffer);
  if ((blockSize & 7) === 0) {
    transposeByTile(frame.bytes, pixels);
  } else {
    transposeByCell(frame.bytes, pixels);
  }
  return imageData;
}

/**
 * Cells are column-major (row x of a frame is column x of the picture), pixels row-major. With blockSize a multiple of 8,
 * reads 8 columns x 8 rows (8 bytes) and writes them as 8 runs of 8 pixels, keeping the writes
 * sequential instead of striding down a column. Branchless, since the cells are random.
 */
function transposeByTile(packed: Uint8Array, pixels: Int32Array): void {
  for (let y0 = 0; y0 < blockSize; y0 += 8) transposeTileRow(packed, pixels, y0);
}

function transposeTileRow(packed: Uint8Array, pixels: Int32Array, y0: number): void {
  const n = blockSize;
  const stride = rowBytes;
  for (let x0 = 0; x0 < n; x0 += 8) {
    let i = x0 * stride + (y0 >>> 3);
    const c0 = packed[i], c1 = packed[i += stride], c2 = packed[i += stride], c3 = packed[i += stride];
    const c4 = packed[i += stride], c5 = packed[i += stride], c6 = packed[i += stride], c7 = packed[i += stride];
    for (let k = 0, p = y0 * n + x0; k < 8; k++, p += n) {
      pixels[p] = cellPixel((c0 >> k) & 1);
      pixels[p + 1] = cellPixel((c1 >> k) & 1);
      pixels[p + 2] = cellPixel((c2 >> k) & 1);
      pixels[p + 3] = cellPixel((c3 >> k) & 1);
      pixels[p + 4] = cellPixel((c4 >> k) & 1);
      pixels[p + 5] = cellPixel((c5 >> k) & 1);
      pixels[p + 6] = cellPixel((c6 >> k) & 1);
      pixels[p + 7] = cellPixel((c7 >> k) & 1);
    }
  }
}

/** The transpose for any blockSize, one cell at a time. */
function transposeByCell(packed: Uint8Array, pixels: Int32Array): void {
  for (let x = 0; x < blockSize; x++) transposeColumn(packed, pixels, x);
}

function transposeColumn(packed: Uint8Array, pixels: Int32Array, x: number): void {
  const n = blockSize;
  for (let y = 0, bit = x * rowBytes * 8, p = x; y < n; y++, bit++, p += n) {
    pixels[p] = cellPixel((packed[bit >>> 3] >> (bit & 7)) & 1);
  }
}

/** The packed bits of a block (column-major: bit[x * blockSize + y]) or its border, zstd compressed. */
function decompress(compressedBytes: Uint8Array, size: number): Uint8Array {
  return zstd.decode(compressedBytes, size);
}

/**
 * The packed bits of a FULL block. A frame of exactly that many bytes holds the bits themselves, from a backend before
 * strips.
 */
function decodeFull(payload: Uint8Array): Uint8Array {
  const bytes = zstd.decode(payload);
  return bytes.length === Math.ceil(blockSize * blockSize / 8) ? bytes : readStrips(bytes, blockSize);
}

function getBit(bits: Uint8Array, i: number): boolean {
  return ((bits[i >>> 3] >> (i & 7)) & 1) === 1;
}

function setCell(frame: Frame, x: number, y: number, alive: boolean): void {
  const word = (y >>> 5) + 1, at = x * rowWords + word;
  const cells = alive ? frame.cells[at] | 1 << y : frame.cells[at] & ~(1 << y);
  if (cells === frame.cells[at]) return;
  frame.cells[at] = cells;
  frame.changed[x * markInts + (word >>> 5)] |= 1 << word;
}

/**
 * Decompresses a border payload and writes it over the border cells of the frame, setting and clearing, and marks the
 * words that changed. Inner cells are left as they are.
 */
function writeBorder(compressedBytes: Uint8Array, frame: Frame): void {
  const totalBits = blockSize * 4 - 4;
  const borderBits = decompress(compressedBytes, Math.ceil(totalBits / 8));

  const last = blockSize - 1;
  let index = 0;

  // cells[i][max] -> y = last edge, full
  for (let x = 0; x < blockSize; x++) {
    setCell(frame, x, last, getBit(borderBits, index++));
  }
  // cells[i][min] -> y = 0 edge, full
  for (let x = 0; x < blockSize; x++) {
    setCell(frame, x, 0, getBit(borderBits, index++));
  }
  // cells[min][i] -> x = 0 column, corners excluded
  for (let y = 1; y < last; y++) {
    setCell(frame, 0, y, getBit(borderBits, index++));
  }
  // cells[max][i] -> x = last column, corners excluded
  for (let y = 1; y < last; y++) {
    setCell(frame, last, y, getBit(borderBits, index++));
  }

  if (index !== totalBits) throw new Error('bit count mismatch: index: ' + index + 'bits: ' + totalBits);
}
