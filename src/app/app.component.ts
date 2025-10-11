import {Component} from '@angular/core';
import {GridViewComponent} from './features/grid-view/grid-view.component';
import {RunnerInfoComponent} from './features/runner-info/runner-info.component';

@Component({
  standalone: true,
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.css'],
  imports: [GridViewComponent, RunnerInfoComponent],
})
export class AppComponent {
  protected title = 'Cell!';
}
