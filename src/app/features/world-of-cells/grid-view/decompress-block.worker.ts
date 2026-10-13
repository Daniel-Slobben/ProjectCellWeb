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
      const bitmap = await createImageBitmap(decodeByteArrayToImageData(data));
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
      const bitmap = await createImageBitmap(image);

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

        const data = decodeBorderToBlockBits(block.encodedCells, blockSize);
        fillInnerBlockWithAlgo(data, encodedBlocks.get(key)!);
        const image = decodeByteArrayToImageData(data);
        const bitmap = await createImageBitmap(image);

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

function neighborLoopWithIndexCheck(x: number, y: number, size: number, heatmap: Uint8Array) {
  for (let i = -1; i <= 1; i++) {
    if (x + i < 0 || x + i >= size) continue;
    for (let j = -1; j <= 1; j++) {
      if (y + j < 0 || y + j >= size) continue;

      heatmap[(x + i) * size + (y + j)]++;
    }
  }
}

function getNewHeatmap(block: Uint8Array): Uint8Array {
  const size = blockSize;
  const heatmap = new Uint8Array(size * size);

  // border loops. Only those need the expensive out-of-index guards
  for (let x = 0; x < size; x++) {
    if (getCellAt(x, 0, block)) {
      neighborLoopWithIndexCheck(x, 0, size, heatmap);
    }
    if (getCellAt(x, size - 1, block)) {
      neighborLoopWithIndexCheck(x, size - 1, size, heatmap);
    }
  }
  for (let y = 1; y < size - 1; y++) {
    if (getCellAt(0, y, block)) {
      neighborLoopWithIndexCheck(0, y, size, heatmap);
    }
    if (getCellAt(size - 1, y, block)) {
      neighborLoopWithIndexCheck(size - 1, y, size, heatmap);
    }
  }

  // inner loop go zooming
  for (let x = 1; x < size - 1; x++) {
    for (let y = 1; y < size - 1; y++) {

      // skip when the current cell is dead
      if (!getCellAt(x, y, block)) continue;

      const i = x * size + y;

      // increment all 8 neighbors (flat-index equivalent of heatmap[x±1][y±1])
      heatmap[i - size - 1]++;
      heatmap[i - size]++;
      heatmap[i - size + 1]++;

      heatmap[i - 1]++;
      heatmap[i + 1]++;

      heatmap[i + size - 1]++;
      heatmap[i + size]++;
      heatmap[i + size + 1]++;
    }
  }
  return heatmap;
}

function applyGameOfLifeRulesFromHeatmap(packedBits: Uint8Array, previousEncodedBlock: Uint8Array, heatmap: Uint8Array) {
  const size = blockSize;
  for (let x = 1; x < size - 1; x++) {
    for (let y = 1; y < size - 1; y++) {
      const i = x * size + y;
      const heat = heatmap[i];

      // cell was dead
      if (!getCellAt(x, y, previousEncodedBlock)) {
        setBit(packedBits, i, heat === 3);
      }
      // cell was alive
      else {
        setBit(packedBits, i, heat === 2 || heat === 3);
      }
    }
  }
}

function fillInnerBlockWithAlgo(packedBits: Uint8Array, previousEncodedBlock: Uint8Array) {
  const heatmap = getNewHeatmap(previousEncodedBlock);
  applyGameOfLifeRulesFromHeatmap(packedBits, previousEncodedBlock, heatmap);
}

function decodePooledImageData(packed: Uint8Array): ImageData {
  const shift = Math.log2(poolFactor);
  const size = Math.ceil(blockSize / poolFactor);
  const counts = new Uint16Array(size * size);

  for (let x = 0; x < blockSize; x++) {
    const px = x >> shift;
    for (let y = 0; y < blockSize; y++) {
      if (getCellAt(x, y, packed)) counts[(y >> shift) * size + px]++;
    }
  }

  // Patch sizes along each axis; only the last row/column can be partial.
  const fullEdge = blockSize % poolFactor === 0 ? poolFactor : blockSize % poolFactor;
  const imageData = new ImageData(size, size);
  const pixels = imageData.data;

  // counts is row-major like the pixels: counts[py * size + px].
  for (let py = 0; py < size; py++) {
    const cellsY = py === size - 1 ? fullEdge : poolFactor;
    for (let px = 0; px < size; px++) {
      const cellsX = px === size - 1 ? fullEdge : poolFactor;
      const density = counts[py * size + px] / (cellsX * cellsY);
      const color = Math.round(255 * (1 - Math.pow(density, densityGamma)));
      const i = (py * size + px) * 4;
      pixels[i] = color;
      pixels[i + 1] = color;
      pixels[i + 2] = color;
      pixels[i + 3] = 255;
    }
  }
  return imageData;
}

function decodeByteArrayToImageData(packed: Uint8Array): ImageData {
  if (poolFactor > 1) {
    return decodePooledImageData(packed);
  }
  const imageData = new ImageData(blockSize, blockSize);
  const pixels = imageData.data;
  for (let x = 0; x < blockSize; x++) {
    for (let y = 0; y < blockSize; y++) {
      const color = getCellAt(x, y, packed) ? 0 : 255; // black or white
      const pixelIndex = (y * blockSize + x) * 4;
      pixels[pixelIndex] = color; // R
      pixels[pixelIndex + 1] = color; // G
      pixels[pixelIndex + 2] = color; // B
      pixels[pixelIndex + 3] = 255;   // A
    }
  }
  return imageData;
}

function decodeLz4BlockToByteArray(encodedCells: string, blockSize: number): Uint8Array {
  // Step 1: Base64 → compressed bytes
  const compressedBytes = base64ToBytes(encodedCells);

  // Step 2: LZ4 decompress → packed bits (column-major: bit[x * blockSize + y])
  const packedBits = new Uint8Array(Math.ceil(blockSize * blockSize / 8));
  decompressBlock(compressedBytes, packedBits, 0, compressedBytes.length, 0);

  return packedBits;
}

function getCellAt(x: number, y: number, packedBits: Uint8Array): boolean {
  const bitIndex = x * blockSize + y;
  return ((packedBits[bitIndex >>> 3] >> (bitIndex & 7)) & 1) === 1;
}

function base64ToBytes(encodedCells: string) {
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
 * Decodes a border payload into a full-block bit array.
 * Only the border bits are written; inner cells are left zeroed.
 */
function decodeBorderToBlockBits(encodedCells: string, blockSize: number): Uint8Array {
  const compressedBytes = base64ToBytes(encodedCells);

  const totalBits = blockSize * 4 - 4;
  const borderBits = new Uint8Array(Math.ceil(totalBits / 8));
  decompressBlock(compressedBytes, borderBits, 0, compressedBytes.length, 0);

  const blockBits = new Uint8Array(Math.ceil((blockSize * blockSize) / 8));
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
  return blockBits;
}
