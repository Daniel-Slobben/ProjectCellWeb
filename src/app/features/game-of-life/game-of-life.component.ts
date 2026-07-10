import {Component} from '@angular/core';
import {GridViewComponent} from './grid-view/grid-view.component';

@Component({
  selector: 'app-game-of-life', templateUrl: './game-of-life.component.html',
  imports: [
    GridViewComponent
  ],
  styleUrls: ['./game-of-life.component.css']
})
export class GameOfLifeComponent {

}
