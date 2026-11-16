import {Component, computed, inject, signal} from '@angular/core';
import {WorldOfCellsComponent} from './features/world-of-cells/world-of-cells.component';
import {SettingsComponent} from './features/settings/settings.component';
import {GearIconComponent} from './shared/icons/gear-icon.component';
import {ViewCenter} from './shared/view-center';

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
  protected readonly coordinatesEm = computed(() =>
    4 + 0.75 * (String(this.viewCenter.x()).length + String(this.viewCenter.y()).length));
}
