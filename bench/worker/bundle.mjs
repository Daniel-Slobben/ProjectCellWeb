// Bundles a version of decompress-block.worker.ts with an export of what the benches call, the same for both shapes the
// worker has had: packed bits stepped by stepGameOfLife (until 2026-11-25), and frames stepped by step.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as esbuild from 'esbuild';

export const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../src/app/features/world-of-cells/grid-view/decompress-block.worker.ts');

const common = `zstdReady, readBlockFrame, decodeFull, toBitmap,
  setBlockSize(n: number) { blockSize = n; }, setPoolFactor(n: number) { poolFactor = n; },`;

const packedFooter = `
export const worker = {${common}
  load: (packed: Uint8Array) => ({packed}),
  step(state: any) { state.packed = stepGameOfLife(state.packed); },
  writeBorder(border: Uint8Array, state: any) { writeBorder(border, state.packed); },
  recount(state: any) {},
  image: (state: any) => decodeByteArrayToImageData(state.packed),
  bits: (state: any) => state.packed,
};`;

const framesFooter = `
export const worker = {${common}
  load: framesOf,
  step,
  writeBorder(border: Uint8Array, frames: Frames) { writeBorder(border, frames.current); },
  recount(frames: Frames) { recount(frames.current); },
  image: (frames: Frames) => imageOf(frames.current),
  bits(frames: Frames) {
    const bits = new Uint8Array(Math.ceil(blockSize * blockSize / 8));
    for (let x = 0; x < blockSize; x++) {
      for (let y = 0, bit = x * blockSize; y < blockSize; y++, bit++) {
        if ((frames.current.bytes[x * rowBytes + (y >>> 3)] >> (y & 7)) & 1) bits[bit >>> 3] |= 1 << (bit & 7);
      }
    }
    return bits;
  },
};`;

export async function bundleWorker(source, outfile) {
  const footer = source.includes('function stepGameOfLife(') ? packedFooter : framesFooter;
  await esbuild.build({
    // Resolved next to the real worker, so its imports find the current helpers.
    stdin: {contents: source + footer, resolveDir: path.dirname(workerPath), sourcefile: `${path.basename(outfile, '.mjs')}.worker.ts`, loader: 'ts'},
    bundle: true, format: 'esm', target: 'es2022', outfile, logLevel: 'error',
  });
}

// Node has no canvas; its images are plain pixel arrays.
globalThis.ImageData ??= class {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
};
