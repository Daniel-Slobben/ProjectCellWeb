export class Block {
  cells: boolean[][];
  generation: number;
  ghostBlock: boolean;
  x: number;
  y: number;

  constructor(cells: boolean[][], generation: number, ghostBlock: boolean, x: number, y: number) {
    this.cells = cells;
    this.generation = generation;
    this.ghostBlock = ghostBlock;
    this.x = x;
    this.y = y;
  }
}
