export class Block {
  encodedCells: string;
  generation: number;
  ghostBlock: boolean;
  x: number;
  y: number;

  constructor(encodedCells: string, generation: number, ghostBlock: boolean, x: number, y: number) {
    this.encodedCells = encodedCells;
    this.generation = generation;
    this.ghostBlock = ghostBlock;
    this.x = x;
    this.y = y;

  }

}
