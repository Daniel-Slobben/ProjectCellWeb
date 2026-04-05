import {Injectable} from '@angular/core';

@Injectable({providedIn: 'root'})
export class Utils {
  public getKey(blockX: number, blockY: number): string {
    return `${blockX}/${blockY}`;
  }
}
