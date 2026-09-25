import {Component, ChangeDetectionStrategy} from '@angular/core';

/**
 * Reload arrows drawn on a 15x15 pixel grid, to match the blocky bar font.
 * Sizes to 1em and takes the surrounding text colour.
 */
@Component({
  selector: 'reload-icon',
  standalone: true,
  template: `
    <svg viewBox="0 0 15 15" shape-rendering="crispEdges" aria-hidden="true">
      <rect x="5" y="0" width="5" height="1"/>
      <rect x="3" y="1" width="9" height="1"/>
      <rect x="2" y="2" width="4" height="1"/>
      <rect x="9" y="2" width="4" height="1"/>
      <rect x="1" y="3" width="3" height="1"/>
      <rect x="8" y="3" width="7" height="1"/>
      <rect x="1" y="4" width="2" height="1"/>
      <rect x="9" y="4" width="5" height="1"/>
      <rect x="0" y="5" width="2" height="1"/>
      <rect x="10" y="5" width="3" height="1"/>
      <rect x="0" y="6" width="2" height="1"/>
      <rect x="11" y="6" width="1" height="1"/>
      <rect x="0" y="7" width="2" height="1"/>
      <rect x="13" y="7" width="2" height="1"/>
      <rect x="3" y="8" width="1" height="1"/>
      <rect x="13" y="8" width="2" height="1"/>
      <rect x="2" y="9" width="3" height="1"/>
      <rect x="13" y="9" width="2" height="1"/>
      <rect x="1" y="10" width="5" height="1"/>
      <rect x="12" y="10" width="2" height="1"/>
      <rect x="0" y="11" width="7" height="1"/>
      <rect x="11" y="11" width="3" height="1"/>
      <rect x="2" y="12" width="4" height="1"/>
      <rect x="9" y="12" width="4" height="1"/>
      <rect x="3" y="13" width="9" height="1"/>
      <rect x="5" y="14" width="5" height="1"/>
    </svg>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    svg {
      height: 1em;
      width: 1em;
      fill: currentColor;
      vertical-align: -0.1em;
    }
  `]
})
export class ReloadIconComponent {
}
