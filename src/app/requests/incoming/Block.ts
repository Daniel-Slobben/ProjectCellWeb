export class Block {
  x: number;
  y: number;
  generation: number;
  encodedCells: string;
  type: string;

  constructor(x: number, y: number, generation: number, encodedCells: string, type: string) {
    this.x = x;
    this.y = y;
    this.generation = generation;
    this.encodedCells = encodedCells;
    this.type = type;
  }
}
