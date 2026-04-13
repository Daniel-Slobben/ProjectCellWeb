import {decompressBlock} from 'lz4js';
import {getKey} from './utils.component';

let blockSize: number;

globalThis.onmessage = async function(e: any) {
  const {type, payload} = e.data;
  if (type === 'init') {
    blockSize = payload.blockSize;
    return;
  }
  const blockList = payload.data;
  const results = [];
  for (const block of blockList) {
    if (block.blockType == 'COMPLETE') {
      const imageData = decodeLz4BlockToImageData(block.encodedCells, blockSize);
      results.push({imageData, x: block.x, y: block.y});
    } else {
      const imageDataBlock: ImageData = payload.imageData.get(getKey(block.x, block.y));
      const imageData = decodeDeltaToImageData(block.encodedCells, blockSize, imageDataBlock);
      results.push({imageData, x: block.x, y: block.y});
    }
  }
  self.postMessage(results);
};



function decodeLz4BlockToImageData(encodedCells: string, blockSize: number): ImageData {
  // Step 1: Base64 → compressed bytes
  const compressedBytes = base64ToBytes(encodedCells);

  // Step 2: LZ4 decompress → packed bits (column-major: bit[x * blockSize + y])
  const packedBits = new Uint8Array(Math.ceil(blockSize * blockSize / 8));
  decompressBlock(compressedBytes, packedBits, 0, compressedBytes.length, 0);

  const getCellAt = (x: number, y: number): boolean => {
    const bitIndex = x * blockSize + y;
    return ((packedBits[bitIndex >>> 3] >> (bitIndex & 7)) & 1) === 1;
  };

  // Step 3: Write pixels (column-major layout: iterate x outer, y inner)
  const imageData = new ImageData(blockSize, blockSize);
  const pixels = imageData.data;
  for (let x = 0; x < blockSize; x++) {
    for (let y = 0; y < blockSize; y++) {
      const color = getCellAt(x, y) ? 0 : 255; // black or white
      const pixelIndex = (y * blockSize + x) * 4;
      pixels[pixelIndex]     = color; // R
      pixels[pixelIndex + 1] = color; // G
      pixels[pixelIndex + 2] = color; // B
      pixels[pixelIndex + 3] = 255;   // A
    }
  }
  return imageData;
}

function decodeDeltaToImageData(deltaCells: string, blockSize: number, previousImageData: ImageData): ImageData {
  // Step 1: Base64 -> delta bytes
  const deltaBytes = base64ToBytes(deltaCells);

  // Step 2: Custom delta decoding (first bit = changed or not changed (1-0), last 7 bytes is how many in a row)
  const pixels = previousImageData.data;
  let index = 0;
  deltaBytes.forEach(byte => {
     const changed = byte & 0b10000000;
     const amount = byte & 0b01111111;

     if (changed) {
         index = setNextPixelsToColor(amount, pixels, index);
     } else {
       // no change needed
       index += amount * 4;
     }
  })
  return previousImageData;
}

function setNextPixelsToColor(amount: number, pixels: ImageDataArray, index: number): number {
  for (let i = 0; i < amount; i++) {
    let color = 255;
    if (pixels[index] == 255) {
      color = 0;
    }
    pixels[index++] = color; // R
    pixels[index++] = color; // G
    pixels[index++] = color; // B
    pixels[index++] = 255;   // A
  }
  return index;
}

function base64ToBytes(encodedCells: string) {
  const binaryString = atob(encodedCells);
  const compressedBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    compressedBytes[i] = binaryString.codePointAt(i)!;
  }
  return compressedBytes;
}
