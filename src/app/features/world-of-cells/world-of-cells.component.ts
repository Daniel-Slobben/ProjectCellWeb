import {Component} from '@angular/core';
import {GridViewComponent} from './grid-view/grid-view.component';

@Component({
  selector: 'app-world-of-cells', templateUrl: './world-of-cells.component.html',
  imports: [
    GridViewComponent
  ],
  styleUrls: ['./world-of-cells.component.css']
})
export class WorldOfCellsComponent {

}
