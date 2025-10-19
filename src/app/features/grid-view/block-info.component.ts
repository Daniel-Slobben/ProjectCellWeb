import {Component, Input} from '@angular/core'
import {FormsModule} from '@angular/forms';
import {HttpClient} from '@angular/common/http';

@Component({
  selector: 'block-info',
  standalone: true,
  imports: [
    FormsModule
  ],
  template: `
    <div class="p-4 border rounded bg-white shadow">
      <h3 class="text-lg font-bold mb-2">Block Info</h3>
      <p>X: {{ x }} Y: {{ y }}</p>
      <input
        type="range"
        min="1"
        max="20"
        [(ngModel)]="sliderValue"
        (input)="updateSlider()"
        class="w-full"
      />      <input type="number" [(ngModel)]="amountLiveness"/>
      <button (click)="setRandom()">setRandom</button>
    </div>
  `
})
export class BlockInfoComponent {
  @Input() x!: number;
  @Input() y!: number;
  @Input() sliderValue!: number;
  @Input() blockSize!: number;
  @Input() amountLiveness: number = 5;

  constructor(private httpClient: HttpClient) {}

  setRandom() {
    const matrix: boolean[][] = Array.from({ length: this.blockSize}, () => Array(this.blockSize).fill(false));
    for (let x = 0;  x < this.blockSize ; x++) {
      for (let y = 0; y < this.blockSize; y++) {
        matrix[x][y] = (0 == Math.floor(Math.random() * (this.amountLiveness)));
      }
    }
    console.log(matrix);
    this.httpClient.put(`/gen-api/block/${this.x}/${this.y}/set-block`, matrix).subscribe((data) => {});
  }

  updateSlider() {
    this.amountLiveness = 21 - this.sliderValue;
  }
}
