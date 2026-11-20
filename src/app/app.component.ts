import {Component, computed, inject, signal} from '@angular/core';
import {WorldOfCellsComponent} from './features/world-of-cells/world-of-cells.component';
import {SettingsComponent} from './features/settings/settings.component';
import {GearIconComponent} from './shared/icons/gear-icon.component';
import {ViewCenter} from './shared/view-center';
import {DisplaySettings} from './shared/display-settings';

const compact = new Intl.NumberFormat('en', {notation: 'compact', maximumSignificantDigits: 2});

@Component({
  standalone: true,
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.css'],
  imports: [WorldOfCellsComponent, SettingsComponent, GearIconComponent],
})
export class AppComponent {
  protected readonly settingsOpen = signal(false);
  protected readonly viewCenter = inject(ViewCenter);
  protected readonly settings = inject(DisplaySettings);
  protected readonly coordinatesEm = computed(() =>
    4 + 0.75 * (String(this.viewCenter.x()).length + String(this.viewCenter.y()).length));
  // The ruler's --slot in the CSS: wider with a mouse, on a desktop screen.
  private readonly scalePixels = matchMedia('(hover: hover)').matches ? 160 : 64;
  // The cells across the ruler at the current zoom.
  protected readonly scale = computed(() => {
    const cells = this.scalePixels / this.viewCenter.cellSize();
    return {label: `${compact.format(cells)} cells`, title: `${Math.round(cells).toLocaleString('en')} cells`};
  });

  protected onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      this.settingsOpen.set(false);
    } else if ((e.key === 'o' || e.key === 'O') && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey
        && !(e.target instanceof HTMLInputElement)) {
      this.settingsOpen.update((open) => !open);
    }
  }
}
