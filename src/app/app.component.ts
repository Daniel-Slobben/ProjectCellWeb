import {Component} from '@angular/core';
import {GridViewComponent} from './features/grid-view/grid-view.component';
import {MenuComponent} from './features/menu/menu.component';

@Component({
  standalone: true,
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.css'],
  imports: [GridViewComponent, MenuComponent],
})
export class AppComponent {
  menus = [
    { name: 'Game of Life', url: 'grid'},
    { name: 'Explanation', url: 'explanation'},
    { name: 'About me', url: 'about-me'}
  ];
}
