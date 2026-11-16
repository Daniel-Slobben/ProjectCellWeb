export class ClientUpdateRequest {
  blocksToRemove: string[];
  blocksToAdd: string[];
  // The alive cells per sector of the blocks instead of their cells.
  sectors: boolean;

  constructor(blocksToRemove: string[], blocksToAdd: string[], sectors: boolean) {
    this.blocksToRemove = blocksToRemove;
    this.blocksToAdd = blocksToAdd;
    this.sectors = sectors;
  }
}
