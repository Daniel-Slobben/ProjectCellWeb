import {Component} from '@angular/core';
import {GameOfLifeComponent} from './features/game-of-life/game-of-life.component';
import {Router} from '@angular/router';

@Component({
  standalone: true,
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.css'],
  imports: [GameOfLifeComponent],
})
export class AppComponent {
  readonly gameOfLife: string = 'game-of-life';
  readonly explanation: string = 'explanation';

  selectedMenu: string = this.gameOfLife;

  constructor(readonly router: Router) {
  }

  changeMenu(url: any) {
    this.selectedMenu = url;
    this.router.navigate(url);
  }
}
