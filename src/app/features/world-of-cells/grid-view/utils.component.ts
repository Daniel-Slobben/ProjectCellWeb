export function getKey(blockX: number, blockY: number): string {
  return `${blockX}/${blockY}`;
}

// Sectors are drawn in tiles of tileBlocks x tileBlocks blocks, so a frame zoomed far out draws a few hundred bitmaps
// instead of thousands. A tile's sectors all go to one worker.
export const tileBlocks = 8;

export function workerIndex(blockX: number, blockY: number, workers: number): number {
  return Math.abs(blockX * 1000003 + blockY) % workers;
}
