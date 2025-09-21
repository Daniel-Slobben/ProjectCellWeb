import {Component} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {GridViewComponent} from '../grid-view/grid-view.component';

@Component({
  selector: 'teleport', standalone: true, templateUrl: './teleport.component.html', imports: [FormsModule]
})

export class TeleportComponent {
  public teleportX = 0;
  public teleportY = 0;

  public teleport() {
    // Sanitize inputs
    const x = Math.max(0, Math.floor(this.teleportX));
    const y = Math.max(0, Math.floor(this.teleportY));

  }

}
