import {Component, signal, ChangeDetectionStrategy} from '@angular/core';
import {WorldOfCellsComponent} from './features/world-of-cells/world-of-cells.component';
import {ExplanationComponent} from './features/explanation/explanation.component';

type View = 'world' | 'explanation';

@Component({
  standalone: true,
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.css'],
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [WorldOfCellsComponent, ExplanationComponent],
})
export class AppComponent {
  readonly view = signal<View>('world');

  show(v: View) {
    this.view.set(v);
  }
}
