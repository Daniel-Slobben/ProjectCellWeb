export class DeleteBlocksRequest {
  client: string;
  blocksToDelete: string[];

  constructor(uuid: string, blocksToDelete: string[]) {
    this.client = uuid;
    this.blocksToDelete = blocksToDelete;
  }
}
