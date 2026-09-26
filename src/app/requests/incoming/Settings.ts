import {ChaosHit} from './ChaosHit';
import {Block} from './Block';

export interface Settings {
  readonly blockSize: number;
  readonly clientId: string;
  readonly chaosHit: ChaosHit;
  readonly blocks: Block[];
}
