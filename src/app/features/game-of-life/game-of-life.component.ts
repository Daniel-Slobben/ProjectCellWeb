import {Component} from '@angular/core';
import {MenuComponent} from '../menu/menu.component';
import {GridViewComponent} from './grid-view/grid-view.component';
import {Menu} from '../menu/Menu';

@Component({
  selector: 'app-game-of-life', templateUrl: './game-of-life.component.html',
  imports: [
    MenuComponent,
    GridViewComponent
  ],
  styleUrls: ['./game-of-life.component.css']
})
export class GameOfLifeComponent {

  protected menus: Menu[] = [
    {name: 'Record', url: 'record'},
    {name: 'Show grid borders', url: ''},
    {name: 'Technical information', url: ''}
  ]

}
