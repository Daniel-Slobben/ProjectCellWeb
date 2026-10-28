import {decompressBlock} from 'lz4js';
import {getKey} from './utils.component';
import {Block} from '../../../requests/incoming/Block';
import {BORDER, FramedBlock, FULL, readBlockFrame} from './block-frame';

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

  type BlockSummary = Pick<FramedBlock, 'x' | 'y' | 'type' | 'generation' | 'cells'>;

  const toBlockSummary = (b: Block): BlockSummary => ({
    x: b.x,
    y: b.y,
    generation: b.generation,
    type: b.type === 'FULL' ? FULL : BORDER,
    cells: base64ToBytes(b.encodedCells),
  });

  const blockList: BlockSummary[] = type === 'init'
    ? (payload.data as Block[]).map(toBlockSummary)
    : readBlockFrame(new Uint8Array(payload.frame));

  for (const block of blockList) {
    const key = getKey(block.x, block.y);

    if (block.type === FULL) {
      const data = decodeLz4BlockToByteArray(block.cells, blockSize);
      const image = decodeByteArrayToImageData(data);
      const bitmap = await toBitmap(image);

      results.push({bitmap, x: block.x, y: block.y});

      encodedBlocks.set(key, data);
      blockGenerationMap.set(key, block.generation);
    } else if (block.type === BORDER) {
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
        writeBorder(block.cells, data);
        const image = decodeByteArrayToImageData(data);
        const bitmap = await toBitmap(image);

        results.push({bitmap, x: block.x, y: block.y});
        blockGenerationMap.set(key, block.generation);
        encodedBlocks.set(key, data);
      } catch (e) {
        results.push({error: true, x: block.x, y: block.y})
        console.error(e);
      }
    } else {
      console.warn(`Unknown block type ${block.type} for ${key}`);
    }
  }

}

let lifeSource = new Int32Array(0);
let lifeRows: Int32Array[] = [];
let lifeNextRow = new Int32Array(0);
let lifeNext = new Int32Array(0);
let innerMask = new Int32Array(0);
let words = 0;
let lastWordMask = -1;

/**
 * port of gol algo in backend
 */
function stepGameOfLife(previous: Uint8Array): Uint8Array {
  prepareLife(previous.length);
  new Uint8Array(lifeSource.buffer).set(previous);
  for (let x = 0; x < blockSize; x++) packRow(lifeSource, lifeRows[x], x);

  lifeNext.fill(0);
  for (let x = 1; x < blockSize - 1; x++) {
    nextRow(lifeRows[x - 1], lifeRows[x], lifeRows[x + 1], lifeNextRow);
    unpackRow(lifeNextRow, lifeNext, x);
  }

  const next = new Uint8Array(previous.length);
  next.set(new Uint8Array(lifeNext.buffer, 0, previous.length));
  return next;
}

function prepareLife(bytes: number): void {
  if (lifeRows.length === blockSize && lifeSource.length * 4 >= bytes + 4) return;
  words = (blockSize + 31) >>> 5;
  lastWordMask = blockSize & 31 ? (1 << (blockSize & 31)) - 1 : -1;
  lifeSource = new Int32Array(Math.ceil(bytes / 4) + 1);
  lifeNext = new Int32Array(Math.ceil(bytes / 4) + 1);
  lifeNextRow = new Int32Array(words + 2);
  const rows = new Int32Array(blockSize * (words + 2));
  lifeRows = Array.from({length: blockSize}, (_, x) => rows.subarray(x * (words + 2), (x + 1) * (words + 2)));
  innerMask = new Int32Array(words + 2);
  for (let y = 1; y < blockSize - 1; y++) innerMask[(y >>> 5) + 1] |= 1 << y;
}

function nextRow(upperRow: Int32Array, middleRow: Int32Array, downRow: Int32Array, out: Int32Array): void {
  for (let i = 1; i <= words; i++) {
    // neighbours to the left / right: shift the word and pull in the edge bit of the adjacent word
    const upperWord = upperRow[i];
    const upperWordLeft = (upperWord << 1) | (upperRow[i - 1] >>> 31);
    const upperWordRight = (upperWord >>> 1) | (upperRow[i + 1] << 31);
    const middleWord = middleRow[i];
    const middleWordLeft = (middleWord << 1) | (middleRow[i - 1] >>> 31);
    const middleWordRight = (middleWord >>> 1) | (middleRow[i + 1] << 31);
    const downWord = downRow[i];
    const downWordLeft = (downWord << 1) | (downRow[i - 1] >>> 31);
    const downWordRight = (downWord >>> 1) | (downRow[i + 1] << 31);

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
    const next = twoOrThree & (combinedOddNumberAlive | middleWord);
    const changed = (next ^ middleWord) & innerMask[i];
    out[i] = middleWord ^ changed;
  }
}

function packRow(source: Int32Array, row: Int32Array, x: number): void {
  const bit = x * blockSize;
  const first = (bit >>> 5) - 1;
  const shift = bit & 31;
  if (shift === 0) {
    for (let i = 1; i <= words; i++) row[i] = source[first + i];
  } else {
    for (let i = 1; i <= words; i++) row[i] = (source[first + i] >>> shift) | (source[first + i + 1] << (32 - shift));
  }
  row[words] &= lastWordMask;
}

function unpackRow(row: Int32Array, target: Int32Array, x: number): void {
  const bit = x * blockSize;
  const first = (bit >>> 5) - 1;
  const shift = bit & 31;
  if (shift === 0) {
    for (let i = 1; i <= words; i++) target[first + i] |= row[i];
  } else {
    for (let i = 1; i <= words; i++) {
      target[first + i] |= row[i] << shift;
      target[first + i + 1] |= row[i] >>> (32 - shift);
    }
  }
}

const BLACK = Math.trunc(0xff000000); // R = G = B = 0, A = 255
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
  for (let px = 0, x0 = 0; px < size; px++, x0 += pf) {
    const xEnd = Math.min(blockSize, x0 + pf);
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

function decodeLz4BlockToByteArray(compressedBytes: Uint8Array, blockSize: number): Uint8Array {
  // LZ4 decompress → packed bits (column-major: bit[x * blockSize + y])
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
  if (value) bits[i >>> 3] |= 1 << (i & 7);
  else bits[i >>> 3] &= ~(1 << (i & 7));
}

/**
 * Decompresses a border payload and writes it over the border cells of blockBits, setting and clearing.
 * Inner cells are left as they are.
 */
function writeBorder(compressedBytes: Uint8Array, blockBits: Uint8Array): void {
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
