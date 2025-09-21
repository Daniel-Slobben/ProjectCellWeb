import {Component} from '@angular/core';
import {GridViewComponent} from './features/grid-view/grid-view.component';

@Component({
  standalone: true,
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.css'],
  imports: [GridViewComponent],
})
export class AppComponent {
  protected title = 'Cell!';
}
