import {Component} from '@angular/core';

/**
 * Gear drawn on a 15x15 pixel grid, to match the blocky bar font.
 * Sizes to 1.4em and takes the surrounding text colour.
 */
@Component({
  selector: 'gear-icon',
  standalone: true,
  template: `
    <svg viewBox="0 0 15 15" shape-rendering="crispEdges" aria-hidden="true">
      <rect x="6" y="0" width="3" height="1"/>
      <rect x="2" y="1" width="2" height="1"/>
      <rect x="6" y="1" width="3" height="1"/>
      <rect x="11" y="1" width="2" height="1"/>
      <rect x="2" y="2" width="11" height="1"/>
      <rect x="3" y="3" width="9" height="1"/>
      <rect x="2" y="4" width="11" height="1"/>
      <rect x="2" y="5" width="4" height="1"/>
      <rect x="9" y="5" width="4" height="1"/>
      <rect x="0" y="6" width="5" height="3"/>
      <rect x="10" y="6" width="5" height="3"/>
      <rect x="2" y="9" width="4" height="1"/>
      <rect x="9" y="9" width="4" height="1"/>
      <rect x="2" y="10" width="11" height="1"/>
      <rect x="3" y="11" width="9" height="1"/>
      <rect x="2" y="12" width="11" height="1"/>
      <rect x="2" y="13" width="2" height="1"/>
      <rect x="6" y="13" width="3" height="1"/>
      <rect x="11" y="13" width="2" height="1"/>
      <rect x="6" y="14" width="3" height="1"/>
    </svg>
  `,
  styles: [`
    svg {
      height: 1.4em;
      width: 1.4em;
      fill: currentColor;
      vertical-align: -0.3em;
    }
  `]
})
export class GearIconComponent {
}
