export class ClientUpdateRequest {
  client: string;
  keyTopLeft: string;
  keyBottomRight: string;

  constructor(uuid: string, keyTopLeft: string, keyBottomRight: string) {
    this.client = uuid;
    this.keyTopLeft = keyTopLeft;
    this.keyBottomRight = keyBottomRight;
  }
}
