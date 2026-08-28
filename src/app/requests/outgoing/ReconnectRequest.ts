export class ReconnectRequest {
  visibleBlocks: string[];

  constructor(visibleBlocks: string[]) {
    this.visibleBlocks = visibleBlocks;
  }
}
