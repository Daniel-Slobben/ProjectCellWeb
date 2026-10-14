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
