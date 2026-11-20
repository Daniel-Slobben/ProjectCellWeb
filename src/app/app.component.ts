import {Component, computed, inject, signal} from '@angular/core';
import {WorldOfCellsComponent} from './features/world-of-cells/world-of-cells.component';
import {SettingsComponent} from './features/settings/settings.component';
import {GearIconComponent} from './shared/icons/gear-icon.component';
import {ViewCenter} from './shared/view-center';
import {DisplaySettings} from './shared/display-settings';

const compact = new Intl.NumberFormat('en', {notation: 'compact'});

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
  private readonly maxScalePixels = matchMedia('(hover: hover)').matches ? 160 : 64;
  // The longest ruler of 1, 2 or 5 times a power of ten cells that fits its slot, cut into whole cells when it is
  // only a few, else into 4 or 5 parts.
  protected readonly scale = computed(() => {
    const cellSize = this.viewCenter.cellSize(), maxPixels = this.maxScalePixels;
    const power = 10 ** Math.floor(Math.log10(maxPixels / cellSize));
    const cells = [10, 5, 2, 1].map((d) => d * power).find((c) => c * cellSize <= maxPixels) ?? 1;
    const segments = cells < 10 ? cells : String(cells)[0] === '2' ? 4 : 5;
    return {pixels: Math.round(cells * cellSize), segments, label: `${compact.format(cells)} cells`,
      title: `${cells.toLocaleString('en')} cells`};
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
