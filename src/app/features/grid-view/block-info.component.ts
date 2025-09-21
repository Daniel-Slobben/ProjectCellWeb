import { Component, Input} from '@angular/core'

@Component({
  selector: 'block-info',
  standalone: true,
  template: `
    <div class="p-4 border rounded bg-white shadow">
      <h3 class="text-lg font-bold mb-2">Block Info</h3>
      <p>X: {{x}}</p>
      <p>Y: {{y}}</p>
    </div>
  `
})
export class BlockInfoComponent {
  @Input() x!: number;
  @Input() y!: number;
}
