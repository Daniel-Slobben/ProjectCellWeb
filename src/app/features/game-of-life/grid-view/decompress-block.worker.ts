import {decompressBlock} from 'lz4js';
import {Utils} from './utils.component';

let blockSize: number;
const utils = new Utils();

const lastGen = new Map<string, number>();

globalThis.onmessage = async function (e: any) {
  const {type, payload} = e.data;
  if (type === 'init') {
    blockSize = payload.blockSize;
    return;
  }
  const results = [];
  const updateType = payload.encodedBlocks ? 'borders' : 'full';

  const blockList = payload.data;

  if (payload.encodedBlocks) {
    for (const block of blockList) {
      const key = utils.getKey(block.x, block.y);
      const seen = lastGen.get(key);
      if (seen !== undefined && block.generation <= seen) continue;

      try {
        const data = decodeBorderToBlockBits(block.encodedCells, blockSize);
        fillInnerBlockWithAlgo(data, payload.encodedBlocks.get(key));
        const image = decodeByteArrayToImageData(data);
        results.push({image, data, x: block.x, y: block.y});
        lastGen.set(key, block.generation);
      } catch (e) {
        results.push({error: true, x: block.x, y: block.y})
        console.error(e);
      }
    }
  } else {
    for (const block of blockList) {
      const data = decodeLz4BlockToByteArray(block.encodedCells, blockSize);
      const image = decodeByteArrayToImageData(data);
      results.push({image, data, x: block.x, y: block.y});

      const key = utils.getKey(block.x, block.y);
      lastGen.set(key, block.generation);
    }
  }

  self.postMessage({results, updateType});
}

function fillInnerBlockWithAlgo(packedBits: Uint8Array, previousEncodedBlock: Uint8Array) {
  const heatmap = new Uint8Array(blockSize * blockSize);
  const bumpHeatmap = (x: number, y: number) => {
    const i = x * blockSize + y;
    if (heatmap[i] < 9) heatmap[i]++;
  };
  const at = (x: number, y: number) => heatmap[x * blockSize + y];

  for (let x = 0; x < blockSize; x++) {
    for (let y = 0; y < blockSize; y++) {
      if (!getCellAt(x, y, previousEncodedBlock)) continue;

      // loop over all the neighbors to increment neighbor count
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {

          // skip itself
          if (i == 0 && j == 0) continue;

          // skip out of index cells
          if (x + i < 0 || y + j < 0) continue;
          if (x + i >= blockSize + 2 || y + j >= blockSize + 2) continue;

          bumpHeatmap(x + i, y + j);
        }
      }

    }
  }

  for (let x = 1; x < blockSize - 1; x++) {
    for (let y = 1; y < blockSize - 1; y++) {

      const heatMapValue = at(x, y);
      // If cell was dead
      if (getCellAt(x, y, previousEncodedBlock)) {
        setBit(packedBits, x * blockSize + y, heatMapValue == 2 || heatMapValue == 3)
      }
      // If cell was alive
      else {
        setBit(packedBits, x * blockSize + y, heatMapValue == 3)
      }
    }
  }
}

function decodeByteArrayToImageData(packed: Uint8Array): ImageData {
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
