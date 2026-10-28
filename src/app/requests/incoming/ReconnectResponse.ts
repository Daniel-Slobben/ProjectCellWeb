import {Coordinates} from './Coordinates';

export interface ReconnectResponse {
  readonly clientId: string;
  readonly viewport: Coordinates | null;
}
