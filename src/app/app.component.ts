import {Component} from '@angular/core';
import {MenuComponent} from './features/menu/menu.component';
import {GameOfLifeComponent} from './features/game-of-life/game-of-life.component';

@Component({
  standalone: true,
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.css'],
  imports: [MenuComponent, GameOfLifeComponent],
})
export class AppComponent {
  menus = [
    { name: 'Game of Life', url: 'grid'},
    { name: 'Explanation', url: 'explanation'},
    { name: 'About me', url: 'about-me'}
  ];
}
