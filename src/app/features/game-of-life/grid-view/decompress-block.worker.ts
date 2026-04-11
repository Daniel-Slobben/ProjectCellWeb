import {decompressBlock} from 'lz4js';

let blockSize: number;

self.onmessage = async function(e: any) {
  const {type, payload} = e.data;

  if (type === 'init') {
    blockSize = payload.blockSize;
    return;
  }

  const blockList = payload.data;
  const amountOfBlocks = blockList.length;
  const instant: boolean = payload.instant;

  const results = [];
  for (const block of blockList) {
    const cells = decodeLz4Block(block.encodedCells, blockSize);
    const imageData = getImageData(cells, blockSize);
    results.push({imageData, x: block.x, y: block.y});
  }

  self.postMessage(results);
};


function decodeLz4Block(encodedCells: string, blockSize: number): boolean[][] {
  // Step 1: Base64 → Uint8Array
  const binaryString = atob(encodedCells);
  const compressedBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    compressedBytes[i] = binaryString.charCodeAt(i);
  }

  // Step 2: LZ4 decompress (sync!)
  const expectedBytes = Math.ceil(blockSize * blockSize / 8);

  const output = new Uint8Array(expectedBytes);
  decompressBlock(compressedBytes, output, 0, compressedBytes.length, 0);

  // Step 3: Read bits (same as before)
  const getBit = (bitIndex: number): boolean => {
    const byteIndex = bitIndex >>> 3;
    const bitOffset = bitIndex & 7;
    return ((output[byteIndex] >> bitOffset) & 1) === 1;
  };

  const result: boolean[][] = [];
  for (let row = 0; row < blockSize; row++) {
    result[row] = [];
    for (let col = 0; col < blockSize; col++) {
      result[row][col] = getBit(row * blockSize + col);
    }
  }

  return result;
}

function getImageData(data: boolean[][], blockSize: number): ImageData  {
  // Create a tiny block image (one pixel per cell)

  const imageData = new ImageData(blockSize, blockSize);

  const pixels = imageData.data;

  for (let y = 0; y < blockSize; y++) {
    const yCol = y * blockSize;
    for (let x = 0; x < blockSize; x++) {
      const cell = data?.[x]?.[y];
      const color = cell ? 0: 255; // black or white
      const index = (yCol + x) * 4;
      pixels[index] = color;     // R
      pixels[index + 1] = color; // G
      pixels[index + 2] = color; // B
      pixels[index + 3] = 255;   // A
    }
  }
  return imageData;
}
