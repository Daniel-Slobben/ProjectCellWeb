import {Component, computed, inject, signal} from '@angular/core';
import {WorldOfCellsComponent} from './features/world-of-cells/world-of-cells.component';
import {ExplanationComponent} from './features/explanation/explanation.component';
import {ViewCenter} from './shared/view-center';

type View = 'world' | 'explanation';

@Component({
  standalone: true,
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.css'],
  imports: [WorldOfCellsComponent, ExplanationComponent],
})
export class AppComponent {
  readonly view = signal<View>('world');
  protected readonly viewCenter = inject(ViewCenter);
  protected readonly coordinatesEm = computed(() =>
    4 + 0.75 * (String(this.viewCenter.x()).length + String(this.viewCenter.y()).length));

  show(v: View) {
    this.view.set(v);
  }
}
