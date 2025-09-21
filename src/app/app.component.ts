import {Component} from '@angular/core';
import {GridViewComponent} from './features/grid-view/grid-view.component';
import {TeleportComponent} from './features/teleport/teleport.component';

@Component({
  standalone: true,
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.css'],
  imports: [GridViewComponent, TeleportComponent],
})
export class AppComponent {
  protected title = 'Cell!';
}
