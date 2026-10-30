import {Component} from '@angular/core';

/**
 * Right-pointing arrow drawn on a 15x15 pixel grid, to match the blocky bar font.
 * Add class "left" to point it left. Sizes to 1.4em and takes the surrounding text colour.
 */
@Component({
  selector: 'arrow-icon',
  standalone: true,
  template: `
    <svg viewBox="0 0 15 15" shape-rendering="crispEdges" aria-hidden="true">
      <rect x="6" y="3" width="1" height="1"/>
      <rect x="6" y="4" width="3" height="1"/>
      <rect x="6" y="5" width="5" height="1"/>
      <rect x="0" y="6" width="13" height="1"/>
      <rect x="0" y="7" width="15" height="1"/>
      <rect x="0" y="8" width="13" height="1"/>
      <rect x="6" y="9" width="5" height="1"/>
      <rect x="6" y="10" width="3" height="1"/>
      <rect x="6" y="11" width="1" height="1"/>
    </svg>
  `,
  styles: [`
    svg {
      height: 1.4em;
      width: 1.4em;
      fill: currentColor;
      vertical-align: -0.3em;
    }

    :host(.left) svg {
      transform: scaleX(-1);
    }
  `]
})
export class ArrowIconComponent {
}
