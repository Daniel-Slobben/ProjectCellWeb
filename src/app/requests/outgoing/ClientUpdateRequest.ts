export class ClientUpdateRequest {
  blocksToRemove: string[];
  blocksToAdd: string[];

  constructor(blocksToRemove: string[], blocksToAdd: string[]) {
    this.blocksToRemove = blocksToRemove;
    this.blocksToAdd = blocksToAdd;
  }
}
