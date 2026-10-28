import {Coordinates} from './Coordinates';
import {Block} from './Block';

export interface Settings {
  readonly blockSize: number;
  readonly clientId: string;
  readonly viewport: Coordinates;
  readonly blocks: Block[];
}
