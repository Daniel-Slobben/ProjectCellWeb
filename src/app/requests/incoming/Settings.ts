import {Coordinates} from './Coordinates';

export interface Settings {
  readonly blockSize: number;
  readonly viewport: Coordinates;
  readonly targetSpeed: number;
}
