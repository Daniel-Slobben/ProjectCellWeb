/**
 * Block updates as the backend sends them over the socket: blocks back to back until the end of the
 * message, little-endian.
 */

export const FULL = 0;
export const BORDER = 1;

const xOffset = 0;
const yOffset = 4;
const typeOffset = 8;
const generationOffset = 9;
const payloadLengthOffset = 13;
export const payloadOffset = 17;

export interface FramedBlock {
  x: number;
  y: number;
  type: number;
  generation: number;
  cells: Uint8Array;
  start: number;
  end: number;
}

export function readBlockFrame(frame: Uint8Array): FramedBlock[] {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const blocks: FramedBlock[] = [];

  for (let start = 0; start < frame.byteLength;) {
    if (start + payloadOffset > frame.byteLength) throw new Error(`truncated block header at ${start}`);

    const length = view.getUint32(start + payloadLengthOffset, true);
    const end = start + payloadOffset + length;

    if (end > frame.byteLength) throw new Error(`block payload at ${start} runs past the frame`);

    blocks.push({
      x: view.getInt32(start + xOffset, true),
      y: view.getInt32(start + yOffset, true),
      type: view.getUint8(start + typeOffset),
      generation: view.getUint32(start + generationOffset, true),
      cells: frame.subarray(start + payloadOffset, end),
      start,
      end,
    });
    start = end;
  }
  return blocks;
}

/**
 * The packed bits of a FULL block, bit x * size + y, from its zstd frame unpacked. The backend lays the cells out as bytes
 * of 8 cells of a row, bit k for column 8c + k, in strips 64 rows tall, so byte (x, c) is at
 * (x / 64 * columns + c) * 64 + x % 64. Per run of live bytes down a strip it sends a varint of the empty bytes before
 * the run, its bytes and a zero.
 *
 * Before the runs come the rows that have the cells of an earlier row, up to a zero. Each is two varints: the rows since
 * the copied row before it, and how much further back its earlier row is than that of the copied row before it, zigzag.
 */
export function readStrips(runs: Uint8Array, size: number): Uint8Array {
  const columns = (size + 7) >> 3;
  const bits = new Uint8Array(Math.ceil(size * size / 8));
  let i = 0;
  const readVarint = () => {
    let value = 0;
    for (let shift = 0; i < runs.length; shift += 7) {
      value += (runs[i] & 0x7f) << shift;
      if (runs[i++] < 0x80) break;
    }
    return value;
  };

  const copies: number[] = [];
  for (let x = 0, distance = 0; i < runs.length && runs[i] !== 0;) {
    x += readVarint();
    const further = readVarint();
    distance += further >>> 1 ^ -(further & 1);
    copies.push(x, x - distance);
  }
  i++;

  for (let position = 0; i < runs.length; i++) {
    position += readVarint();
    const strip = position >> 6, c = strip % columns;
    for (let x = (strip - c) / columns * 64 + (position & 63); i < runs.length && runs[i] !== 0; i++, x++, position++) {
      const bit = x * size + 8 * c;
      bits[bit >> 3] |= runs[i] << (bit & 7);
      // a row that starts inside a byte, only in worlds whose size is no multiple of 8
      if (bit & 7) bits[(bit >> 3) + 1] |= runs[i] >> (8 - (bit & 7));
    }
  }

  // in row order: the earlier row can be a copy itself
  for (let j = 0; j < copies.length; j += 2) {
    const to = copies[j] * size, from = copies[j + 1] * size;
    if (size % 8 === 0) {
      bits.copyWithin(to >> 3, from >> 3, (from + size) >> 3);
    } else {
      for (let y = 0; y < size; y++) bits[(to + y) >> 3] |= (bits[(from + y) >> 3] >> ((from + y) & 7) & 1) << ((to + y) & 7);
    }
  }
  return bits;
}
