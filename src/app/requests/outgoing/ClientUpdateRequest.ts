export class ClientUpdateRequest {
  blocksToRemove: string[];
  blocksToAdd: string[];
  // No blocks, only the sectors of every block, more often.
  sectors: boolean;

  constructor(blocksToRemove: string[], blocksToAdd: string[], sectors: boolean) {
    this.blocksToRemove = blocksToRemove;
    this.blocksToAdd = blocksToAdd;
    this.sectors = sectors;
  }
}
