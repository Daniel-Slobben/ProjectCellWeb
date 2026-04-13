import { Component, Input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { BlockService } from '../grid-view/block-service';
import {getKey} from '../grid-view/utils.component';

@Component({
  selector: 'block-info',
  templateUrl: './selected-block.component.html',
  styleUrls: ['./selected-block.component.css'],
  standalone: true,
  imports: [FormsModule],
})
export class SelectedBlockComponent {
  @Input() x!: number;
  @Input() y!: number;
  @Input() sliderValue!: number;
  @Input() blockSize!: number;
  @Input() amountLiveness: number = 5;

  constructor(
    private readonly httpClient: HttpClient,
    private readonly blockService: BlockService,
  ) {}

  setEditTrue(): void {
    this.blockService.setEdit(this.x, this.y, true);
  }

  setEditFalse(): void {
    this.blockService.setEdit(this.x, this.y, false);
  }

  setRandom(): void {
    const matrix: boolean[][] = Array.from({ length: this.blockSize }, () =>
      new Array(this.blockSize).fill(false)
    );

    for (let x = 0; x < this.blockSize; x++) {
      for (let y = 0; y < this.blockSize; y++) {
        matrix[x][y] = 0 === Math.floor(Math.random() * this.amountLiveness);
      }
    }

  }

  pushToServer(): void {
    const matrix = this.blockService.getBlock(getKey(this.x, this.y));

    if (matrix === undefined) {
      console.warn('Block not found when pushing to server!');
    } else {
      console.log('Pushing block update to server!');
      this.httpClient.put(`/gen-api/block/${this.x}/${this.y}/set-block`, matrix).subscribe();
      this.blockService.setEdit(this.x, this.y, false);
    }
  }
}
