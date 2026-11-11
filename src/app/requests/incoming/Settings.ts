import {Coordinates} from './Coordinates';

export interface Settings {
  readonly blockSize: number;
  readonly clientId: string;
  readonly viewport: Coordinates;
  readonly targetSpeed: number;
}
