import {Component, ChangeDetectionStrategy} from '@angular/core';

@Component({
  standalone: true,
  selector: 'app-explanation',
  templateUrl: './explanation.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./explanation.component.css']
})
export class ExplanationComponent {
}
