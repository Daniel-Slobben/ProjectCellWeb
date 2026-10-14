export function getKey(blockX: number, blockY: number): string {
  return `${blockX}/${blockY}`;
}

export function workerIndex(blockX: number, blockY: number, workers: number): number {
  return Math.abs(blockX * 1000003 + blockY) % workers;
}
