export class Block {
  x: number;
  y: number;
  encodedCells: string;

  constructor(x: number, y: number, encodedCells: string) {
    this.x = x;
    this.y = y;
    this.encodedCells = encodedCells;
  }
}
