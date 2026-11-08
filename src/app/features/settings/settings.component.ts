import {Component, inject} from '@angular/core';
import {DisplaySettings, THEMES} from '../../shared/display-settings';

@Component({
  standalone: true,
  selector: 'app-settings',
  templateUrl: './settings.component.html',
  styleUrls: ['./settings.component.css']
})
export class SettingsComponent {
  protected readonly settings = inject(DisplaySettings);
  protected readonly themes = THEMES;
}
