/** The blocks in view, minX to maxX and minY to maxY inclusive. */
export interface BlockRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export class ClientUpdateRequest {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  // The alive cells per sector of the blocks instead of their cells.
  sectors: boolean;
  // Blocks in view whose full block is wanted again.
  resend: string[];

  constructor({minX, maxX, minY, maxY}: BlockRange, sectors: boolean, resend: string[]) {
    this.minX = minX;
    this.maxX = maxX;
    this.minY = minY;
    this.maxY = maxY;
    this.sectors = sectors;
    this.resend = resend;
  }
}
