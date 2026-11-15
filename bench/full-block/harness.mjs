// Checks readStrips against zstddec of the rows on the same blocks, then times both. run.mjs builds ./.build and imports
// this module in Node; a page in each browser imports it too.
import {readStrips} from './.build/block-frame.mjs';
import {ZSTDDecoder} from './.build/zstddec.mjs';

// u32 size, u32 count, then per block u32 rows length, u32 full length and both payloads
function parse(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const size = view.getUint32(0, true), count = view.getUint32(4, true);
  const blocks = [];
  let at = 8;
  for (let i = 0; i < count; i++) {
    const rowsLength = view.getUint32(at, true), fullLength = view.getUint32(at + 4, true);
    at += 8;
    blocks.push({rows: buffer.subarray(at, at + rowsLength), full: buffer.subarray(at + rowsLength, at + rowsLength + fullLength)});
    at += rowsLength + fullLength;
  }
  return {size, blocks};
}

function stats(ms) {
  const sorted = [...ms].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return `${avg.toFixed(2)} / ${sorted[Math.floor(sorted.length * 0.9)].toFixed(2)}`;
}

export async function run(buffer, rounds) {
  const {size, blocks} = parse(buffer);
  const zstd = new ZSTDDecoder();
  await zstd.init();
  const raw = Math.ceil(size * size / 8);
  const decodeFull = (payload) => readStrips(zstd.decode(payload), size);
  const wrong = [];
  for (let i = 0; i < blocks.length; i++) {
    const expected = zstd.decode(blocks[i].rows, raw), decoded = decodeFull(blocks[i].full);
    if (decoded.length !== expected.length || decoded.some((b, j) => b !== expected[j])) wrong.push(i);
  }
  const rowsMs = [], fullMs = [];
  for (let r = 0; r < rounds; r++) {
    for (const block of blocks) {
      const t0 = performance.now();
      zstd.decode(block.rows, raw);
      const t1 = performance.now();
      decodeFull(block.full);
      rowsMs.push(t1 - t0);
      fullMs.push(performance.now() - t1);
    }
  }
  const kb = (key) => (blocks.reduce((sum, b) => sum + b[key].length, 0) / blocks.length / 1024).toFixed(1);
  return `${blocks.length} blocks, ${wrong.length ? `WRONG: ${wrong.join(', ')}` : 'all decode right'}; ms avg / p90: ` +
    `zstd of the rows ${stats(rowsMs)} (${kb('rows')} KB), runs of strips ${stats(fullMs)} (${kb('full')} KB)`;
}
