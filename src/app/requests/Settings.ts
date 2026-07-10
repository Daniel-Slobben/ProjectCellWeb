import {ChaosHit} from './ChaosHit';

export interface Settings {
  readonly blockSize: number;
  readonly clientId: string;
  readonly chaosHit: ChaosHit;
}
