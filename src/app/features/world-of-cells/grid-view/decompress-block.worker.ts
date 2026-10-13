import { decompressBlock } from 'lz4js';
import { getKey } from './utils.component';
import {Block} from '../../../requests/incoming/Block';

let blockSize: number;

let poolFactor = 1;
const densityGamma = 0.8;

const blockGenerationMap = new Map<string, number>();
const encodedBlocks = new Map<string, Uint8Array>();

let queue = Promise.resolve();

globalThis.onmessage = function (e: any) {
  queue = queue.then(() => handleMessage(e.data));
};

async function handleMessage({type, batchId, payload}: any): Promise<void> {
  const results: any[] = [];
  try {
    await decodeBatch(type, payload, results);
  } catch (err) {
    console.error(err);
  }
  self.postMessage({batchId, results}, {transfer: results.flatMap((r) => r.bitmap ? [r.bitmap] : [])});
}

async function decodeBatch(type: string, payload: any, results: any[]): Promise<void> {
  if (type === 'init') {
    blockSize = payload.blockSize;
  }
  if (payload.poolFactor !== undefined) {
    poolFactor = payload.poolFactor;
  }

  if (type === 'rescale') {
    for (const {x, y} of payload.data) {
      const data = encodedBlocks.get(getKey(x, y));
      if (!data) continue;
      const bitmap = await toBitmap(decodeByteArrayToImageData(data));
      results.push({bitmap, x, y});
    }
    return;
  }
  const blockList: Block[] = payload.data;

  for (const block of blockList) {
    const key = getKey(block.x, block.y);

    if (block.type === "FULL") {
      const data = decodeLz4BlockToByteArray(block.encodedCells, blockSize);
      const image = decodeByteArrayToImageData(data);
      const bitmap = await toBitmap(image);

      results.push({bitmap, x: block.x, y: block.y});

      encodedBlocks.set(key, data);
      blockGenerationMap.set(key, block.generation);
    } else {

      try {
        const seenBlockGeneration = blockGenerationMap.get(key)!;
        if (block.generation - seenBlockGeneration !== 1) {
          console.warn(`Saved Block Data is ${block.generation - seenBlockGeneration} generations behind Border Blocks. Has to be exactly 1.`);
          if (block.generation - seenBlockGeneration > 3) {
            results.push({error: true, x: block.x, y: block.y})
          }
          continue;
        }

        const data = stepGameOfLife(encodedBlocks.get(key)!);
        writeBorder(block.encodedCells, data);
        const image = decodeByteArrayToImageData(data);
        const bitmap = await toBitmap(image);

        results.push({bitmap, x: block.x, y: block.y});
        blockGenerationMap.set(key, block.generation);
        encodedBlocks.set(key, data);
      } catch (e) {
        results.push({error: true, x: block.x, y: block.y})
        console.error(e);
      }
    }
  }

}

// Scratch for stepGameOfLife, reused between blocks: the previous generation as 32-bit words with
// zero padding on both sides, the two bit planes of each cell's vertical sum, and the next generation.
let lifeCells = new Int32Array(0);
let lifeOnes = new Int32Array(0);
let lifeTwos = new Int32Array(0);
let lifeNext = new Int32Array(0);

/**
 * One Game of Life generation for a block, 32 cells per operation. The inner cells are exact; the
 * border cells come out as junk, so the caller must overwrite them with the server's border.
 *
 * The cells are one bit string (bit x * blockSize + y), so the neighbours of bit i are i ± 1 (y ± 1,
 * which stays inside the column for inner cells) and i ± blockSize (x ± 1). Each cell is first summed
 * with its y ± 1 neighbours into two bit planes (0..3), then the sums of the columns either side are
 * added, giving 0..9 including the cell itself. The cell lives on a total of 3, or of 4 if it was alive.
 */
function stepGameOfLife(previous: Uint8Array): Uint8Array {
  const words = Math.ceil(previous.length / 4);
  const columnWords = blockSize >>> 5;
  const columnBits = blockSize & 31;
  const pad = columnWords + 2;
  const total = words + 2 * pad;
  if (lifeCells.length !== total) {
    lifeCells = new Int32Array(total);
    lifeOnes = new Int32Array(total);
    lifeTwos = new Int32Array(total);
    lifeNext = new Int32Array(total);
  }
  // Bytes past previous.length are never written, so the padding stays zero.
  new Uint8Array(lifeCells.buffer).set(previous, pad * 4);

  sumColumns(lifeCells, lifeOnes, lifeTwos, total);
  if (columnBits === 0) {
    stepAligned(lifeCells, lifeOnes, lifeTwos, lifeNext, pad, pad + words, columnWords);
  } else {
    stepUnaligned(lifeCells, lifeOnes, lifeTwos, lifeNext, pad, pad + words, columnWords, columnBits);
  }

  const next = new Uint8Array(previous.length);
  next.set(new Uint8Array(lifeNext.buffer, pad * 4, previous.length));
  // Keep the bits past the last cell zero, like a freshly decoded block.
  const cells = blockSize * blockSize;
  if (cells & 7) next[next.length - 1] &= (1 << (cells & 7)) - 1;
  return next;
}

/** Each cell plus its y - 1 and y + 1 neighbours, as two bit planes. */
function sumColumns(cells: Int32Array, ones: Int32Array, twos: Int32Array, total: number): void {
  for (let k = 1; k < total - 1; k++) {
    const c = cells[k];
    const up = (c << 1) | (cells[k - 1] >>> 31);
    const down = (c >>> 1) | (cells[k + 1] << 31);
    const half = up ^ c;
    ones[k] = half ^ down;
    twos[k] = (up & c) | (down & half);
  }
}

/**
 * Adds the column sums at x - 1, x and x + 1 (bit offsets -blockSize, 0, +blockSize) and applies the
 * rule. blockSize is a multiple of 32 here, so those offsets are whole words.
 */
function stepAligned(cells: Int32Array, ones: Int32Array, twos: Int32Array, next: Int32Array, from: number, to: number, columnWords: number): void {
  for (let k = from; k < to; k++) {
    next[k] = applyRule(cells[k],
      ones[k - columnWords], twos[k - columnWords], ones[k], twos[k], ones[k + columnWords], twos[k + columnWords]);
  }
}

/** stepAligned for a blockSize that is not a multiple of 32: the neighbouring columns straddle two words. */
function stepUnaligned(cells: Int32Array, ones: Int32Array, twos: Int32Array, next: Int32Array, from: number, to: number, columnWords: number, columnBits: number): void {
  const back = 32 - columnBits;
  for (let k = from; k < to; k++) {
    const l = k - columnWords;
    const r = k + columnWords;
    next[k] = applyRule(cells[k],
      (ones[l - 1] >>> back) | (ones[l] << columnBits), (twos[l - 1] >>> back) | (twos[l] << columnBits),
      ones[k], twos[k],
      (ones[r] >>> columnBits) | (ones[r + 1] << back), (twos[r] >>> columnBits) | (twos[r + 1] << back));
  }
}

/** Sums three 2-bit column sums per bit (0..9) and keeps the cells totalling 3, or 4 when alive. */
function applyRule(alive: number, a0: number, a1: number, b0: number, b1: number, c0: number, c1: number): number {
  const halfOnes = a0 ^ b0;
  const t0 = halfOnes ^ c0;                          // total bit 0
  const carry = (a0 & b0) | (c0 & halfOnes);         // weight 2
  const halfTwos = a1 ^ b1;
  const twos = halfTwos ^ c1;
  const fours = (a1 & b1) | (c1 & halfTwos);         // weight 4
  const t1 = twos ^ carry;                           // total bit 1
  const t2 = fours ^ (twos & carry);                 // total bit 2; bit 3 is only set for 8 and 9
  // A total of 11 or 12 cannot occur, so bit 3 never turns 8/9 into a false 3 or 4.
  return (t0 & t1 & ~t2) | (~t0 & ~t1 & t2 & alive);
}

// Pixels are written as whole RGBA words through a little-endian Int32Array. Signed on purpose:
// values above 2^31 in a Uint32Array are boxed as doubles and run several times slower.
// A cell bit becomes a pixel as (bit - 1) | BLACK: 0 -> -1 (white), 1 -> BLACK. Plain bit operations
// are as fast as anything in V8 and SpiderMonkey, and about 4x faster than a multiply in Safari's JSC.
const BLACK = 0xff000000 | 0; // R = G = B = 0, A = 255
const POPCOUNT = new Uint8Array(256).map((_, b) => {
  let n = 0;
  for (let v = b; v; v &= v - 1) n++;
  return n;
});

// Turning the pixels into a bitmap copies them, so one ImageData per worker is reused between blocks.
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

async function toBitmap(image: ImageData): Promise<ImageBitmap> {
  if (!canvasBitmaps) return createImageBitmap(image);
  if (bitmapCanvas?.width !== image.width || bitmapCanvas.height !== image.height || bitmapContext?.isContextLost?.()) {
    bitmapCanvas = new OffscreenCanvas(image.width, image.height);
    bitmapContext = bitmapCanvas.getContext('2d', {alpha: false});
  }
  bitmapContext!.putImageData(image, 0, 0);
  return bitmapCanvas.transferToImageBitmap();
}

function decodePooledImageData(packed: Uint8Array): ImageData {
  const shift = Math.log2(poolFactor);
  const size = Math.ceil(blockSize / poolFactor);
  const counts = new Uint16Array(size * size);
  if ((blockSize & 7) === 0) {
    countPatchesByByte(packed, counts, size, shift);
  } else {
    countPatchesByCell(packed, counts, size, shift);
  }

  // Patch sizes along each axis; only the last row/column can be partial.
  const fullEdge = blockSize % poolFactor === 0 ? poolFactor : blockSize % poolFactor;
  const imageData = imageOfSize(size);
  const pixels = new Int32Array(imageData.data.buffer);

  // Every full patch has the same denominator, so its colours come from a table.
  const fullPatch = poolFactor * poolFactor;
  const fullColors = new Int32Array(fullPatch + 1);
  for (let n = 0; n <= fullPatch; n++) fullColors[n] = grayPixel(n / fullPatch);

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
    for (let i = start; i < last; i++) pixels[i] = grayPixel(counts[i] / (poolFactor * cellsY));
  }
  pixels[last] = grayPixel(counts[last] / (fullEdge * cellsY));
}

function grayPixel(density: number): number {
  const color = Math.round(255 * (1 - Math.pow(density, densityGamma)));
  return BLACK | (color << 16) | (color << 8) | color;
}

/**
 * Alive cells per patch when blockSize is a multiple of 8, so every byte holds 8 cells of one
 * column (bit k = row y0 + k). Sums a patch's columns a byte at a time, eight rows per pass.
 */
function countPatchesByByte(packed: Uint8Array, counts: Uint16Array, size: number, shift: number): void {
  const n = blockSize;
  const stride = n >>> 3; // bytes per column
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
  const n = blockSize;
  for (let px = 0, x0 = 0; px < size; px++, x0 += pf) {
    const xEnd = Math.min(n, x0 + pf);
    let sum = 0;
    for (let x = x0, i = x0 * stride + byte0; x < xEnd; x++, i += stride) sum += POPCOUNT[packed[i]];
    counts[row + px] += sum;
  }
}

/** Alive cells per patch for any blockSize, one cell at a time. */
function countPatchesByCell(packed: Uint8Array, counts: Uint16Array, size: number, shift: number): void {
  for (let x = 0; x < blockSize; x++) countColumnByCell(packed, counts, x, size, shift);
}

function countColumnByCell(packed: Uint8Array, counts: Uint16Array, x: number, size: number, shift: number): void {
  const n = blockSize;
  const px = x >> shift;
  for (let y = 0, bit = x * n; y < n; y++, bit++) {
    counts[(y >> shift) * size + px] += (packed[bit >>> 3] >> (bit & 7)) & 1;
  }
}

function decodeByteArrayToImageData(packed: Uint8Array): ImageData {
  if (poolFactor > 1) {
    return decodePooledImageData(packed);
  }
  const imageData = imageOfSize(blockSize);
  const pixels = new Int32Array(imageData.data.buffer);
  if ((blockSize & 7) === 0) {
    transposeByTile(packed, pixels);
  } else {
    transposeByCell(packed, pixels);
  }
  return imageData;
}

/**
 * Cells are column-major (bit x * blockSize + y), pixels row-major. With blockSize a multiple of 8,
 * reads 8 columns x 8 rows (8 bytes) and writes them as 8 runs of 8 pixels, keeping the writes
 * sequential instead of striding down a column. Branchless, since the cells are random.
 */
function transposeByTile(packed: Uint8Array, pixels: Int32Array): void {
  for (let y0 = 0; y0 < blockSize; y0 += 8) transposeTileRow(packed, pixels, y0);
}

function transposeTileRow(packed: Uint8Array, pixels: Int32Array, y0: number): void {
  const n = blockSize;
  const stride = n >>> 3;
  for (let x0 = 0; x0 < n; x0 += 8) {
    let i = x0 * stride + (y0 >>> 3);
    const c0 = packed[i], c1 = packed[i += stride], c2 = packed[i += stride], c3 = packed[i += stride];
    const c4 = packed[i += stride], c5 = packed[i += stride], c6 = packed[i += stride], c7 = packed[i += stride];
    for (let k = 0, p = y0 * n + x0; k < 8; k++, p += n) {
      pixels[p] = (((c0 >> k) & 1) - 1) | BLACK;
      pixels[p + 1] = (((c1 >> k) & 1) - 1) | BLACK;
      pixels[p + 2] = (((c2 >> k) & 1) - 1) | BLACK;
      pixels[p + 3] = (((c3 >> k) & 1) - 1) | BLACK;
      pixels[p + 4] = (((c4 >> k) & 1) - 1) | BLACK;
      pixels[p + 5] = (((c5 >> k) & 1) - 1) | BLACK;
      pixels[p + 6] = (((c6 >> k) & 1) - 1) | BLACK;
      pixels[p + 7] = (((c7 >> k) & 1) - 1) | BLACK;
    }
  }
}

/** The transpose for any blockSize, one cell at a time. */
function transposeByCell(packed: Uint8Array, pixels: Int32Array): void {
  for (let x = 0; x < blockSize; x++) transposeColumn(packed, pixels, x);
}

function transposeColumn(packed: Uint8Array, pixels: Int32Array, x: number): void {
  const n = blockSize;
  for (let y = 0, bit = x * n, p = x; y < n; y++, bit++, p += n) {
    pixels[p] = (((packed[bit >>> 3] >> (bit & 7)) & 1) - 1) | BLACK;
  }
}

function decodeLz4BlockToByteArray(encodedCells: string, blockSize: number): Uint8Array {
  // Step 1: Base64 → compressed bytes
  const compressedBytes = base64ToBytes(encodedCells);

  // Step 2: LZ4 decompress → packed bits (column-major: bit[x * blockSize + y])
  const packedBits = new Uint8Array(Math.ceil(blockSize * blockSize / 8));
  decompressBlock(compressedBytes, packedBits, 0, compressedBytes.length, 0);

  return packedBits;
}

// Native in Chrome 140+, Firefox 133+ and Safari 18.2+, but not in the ES2022 lib yet.
const nativeFromBase64 = (Uint8Array as unknown as {fromBase64?: (base64: string) => Uint8Array}).fromBase64?.bind(Uint8Array);

function base64ToBytes(encodedCells: string) {
  if (nativeFromBase64) return nativeFromBase64(encodedCells);
  const binaryString = atob(encodedCells);
  const compressedBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    compressedBytes[i] = binaryString.codePointAt(i)!;
  }
  return compressedBytes;
}

function getBit(bits: Uint8Array, i: number): boolean {
  return ((bits[i >>> 3] >> (i & 7)) & 1) === 1;
}

function setBit(bits: Uint8Array, i: number, value: boolean): void {
  if (value) bits[i >>> 3] |= 1 << (i & 7); else bits[i >>> 3] &= ~(1 << (i & 7));
}

/**
 * Decodes a border payload and writes it over the border cells of blockBits, setting and clearing.
 * Inner cells are left as they are.
 */
function writeBorder(encodedCells: string, blockBits: Uint8Array): void {
  const compressedBytes = base64ToBytes(encodedCells);

  const totalBits = blockSize * 4 - 4;
  const borderBits = new Uint8Array(Math.ceil(totalBits / 8));
  decompressBlock(compressedBytes, borderBits, 0, compressedBytes.length, 0);

  const last = blockSize - 1;
  let index = 0;

  // cells[i][max] -> y = last edge, full
  for (let x = 0; x < blockSize; x++) {
    setBit(blockBits, x * blockSize + last, getBit(borderBits, index++));
  }
  // cells[i][min] -> y = 0 edge, full
  for (let x = 0; x < blockSize; x++) {
    setBit(blockBits, x * blockSize, getBit(borderBits, index++));
  }
  // cells[min][i] -> x = 0 column, corners excluded
  for (let y = 1; y < last; y++) {
    setBit(blockBits, y, getBit(borderBits, index++));
  }
  // cells[max][i] -> x = last column, corners excluded
  for (let y = 1; y < last; y++) {
    setBit(blockBits, last * blockSize + y, getBit(borderBits, index++));
  }

  if (index !== totalBits) throw new Error('bit count mismatch: index: ' + index + 'bits: ' + totalBits);
}
