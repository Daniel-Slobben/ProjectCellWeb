export class Block {
  x: number;
  y: number;
  generation: number;
  encodedCells: string;

  constructor(x: number, y: number, generation: number, encodedCells: string) {
    this.x = x;
    this.y = y;
    this.generation = generation;
    this.encodedCells = encodedCells;
  }
}
