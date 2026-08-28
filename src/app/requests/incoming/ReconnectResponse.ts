import {ChaosHit} from './ChaosHit';

export interface ReconnectResponse {
  readonly clientId: string;
  readonly chaosHit: ChaosHit | undefined;
}
