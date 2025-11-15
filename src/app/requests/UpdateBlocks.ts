export class UpdateBlocks {
  client: string;
  blocksToRemove: string[];
  blocksToAdd: string[];

  constructor(uuid: string, blocksToRemove: string[], blocksToAdd: string[]) {
    this.client = uuid;
    this.blocksToRemove = blocksToRemove;
    this.blocksToAdd = blocksToAdd;
  }
}
