import {Component, ChangeDetectionStrategy} from '@angular/core';
import {GridViewComponent} from './grid-view/grid-view.component';

@Component({
  selector: 'app-world-of-cells', templateUrl: './world-of-cells.component.html',
  imports: [
    GridViewComponent
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./world-of-cells.component.css']
})
export class WorldOfCellsComponent {

}
