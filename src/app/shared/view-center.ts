import {Injectable, signal} from '@angular/core';

/** The world cell at the centre of the grid view and the zoom, shown in the top bar. */
@Injectable({providedIn: 'root'})
export class ViewCenter {
  readonly x = signal(0);
  readonly y = signal(0);
  // CSS pixels per cell.
  readonly cellSize = signal(2.5);
}
