import {AfterViewInit, Component, ElementRef, OnDestroy, ViewChild,} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {firstValueFrom} from 'rxjs';
import {HttpClient} from '@angular/common/http';
import {BlockService} from './block-service';
import {SelectedBlockComponent} from '../selected-block/selected-block.component';
import {NgIf} from '@angular/common';
import {Utils} from './utils.component';
import {RunnerInfoComponent} from '../runner-info/runner-info.component';
import {Application} from 'pixi.js';

@Component({
  selector: 'grid-view',
  standalone: true,
  templateUrl: './grid-view.component.html',
  styleUrls: ['./grid-view.component.css'],
  imports: [FormsModule, SelectedBlockComponent, NgIf, RunnerInfoComponent]
})
export class GridViewComponent implements AfterViewInit, OnDestroy {

  @ViewChild('gridCanvas', {static: true}) canvasRef!: ElementRef<HTMLCanvasElement>;

  protected blockSize: number = 10;
  private cellSize = 8.7;
  private minCellSize: number = 2;
  private maxCellSize: number = 20;
  private canvasWidth = window.screen.width - 400;
  private canvasHeight = window.innerHeight - 30;


  private cellOffsetX = 0;
  private cellOffsetY = 0;
  private ctx!: CanvasRenderingContext2D;

  // Drag state
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;

  private animationFrameId?: number;
  private lastVisibleBlocks = new Set<string>();

  public selectedBlock: {x: number; y: number} | null = null;
  public editSelectedBlock: boolean = false;

  constructor(private httpClient: HttpClient, private blockService: BlockService, private utils: Utils) {
  }

  async ngAfterViewInit() {
    const app = new Application();
    if (!this.canvasRef?.nativeElement) {
      console.error('Canvas element not found. Make sure template has <canvas #gridCanvas></canvas>');
      return;
    }

    this.ctx = this.canvasRef.nativeElement.getContext('2d')!;
    if (!this.ctx) {
      console.error('Could not get 2D context from canvas');
      return;
    }

    this.canvasRef.nativeElement.width = this.canvasWidth;
    this.canvasRef.nativeElement.height = this.canvasHeight;

    // Set canvas rendering optimizations
    this.ctx.imageSmoothingEnabled = false; // Crisp pixel rendering

    try {
      this.blockSize = await firstValueFrom(this.httpClient.get<number>('/gen-api/blocksize'));
    } catch (error) {
      console.warn('Failed to fetch block size, using default:', this.blockSize);
    }

    this.setupCanvasEvents();
    this.startRenderLoop();
  }

  ngOnDestroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    // Clean up event listeners
    const canvas = this.canvasRef.nativeElement;
    canvas.removeEventListener('mousedown', this.onClick);
    canvas.removeEventListener('mouseup', this.onDragEnd);
    canvas.removeEventListener('mouseleave', this.onDragEnd);
    canvas.removeEventListener('mousemove', this.onDragMove);
    canvas.removeEventListener('wheel', this.onWheel);
  }

  private startRenderLoop() {
    const render = () => {
      this.updateVisibleBlocks();
      this.animationFrameId = requestAnimationFrame(render);
    };
    render();
  }

  private updateVisibleBlocks() {
    const startBlockX = Math.floor(this.cellOffsetX / this.blockSize);
    const startBlockY = Math.floor(this.cellOffsetY / this.blockSize);
    const endBlockX = Math.floor((this.cellOffsetX + this.canvasWidth / this.cellSize) / this.blockSize);
    const endBlockY = Math.floor((this.cellOffsetY + this.canvasHeight / this.cellSize) / this.blockSize);
    const currentVisibleBlocks = new Set<string>();

    this.ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

    for (let blockX = startBlockX; blockX <= endBlockX; blockX++) {
      for (let blockY = startBlockY; blockY <= endBlockY; blockY++) {
        const key = this.utils.getKey(blockX, blockY);
        currentVisibleBlocks.add(key);
        this.drawBlockWithImageData(blockX, blockY);
      }
    }
    this.blockService.updateVisible(currentVisibleBlocks);

    if (this.selectedBlock != undefined) {
      const offscreen = document.createElement('canvas');
      offscreen.width = this.blockSize;
      offscreen.height = this.blockSize;
      this.drawRectangleBorder(this.selectedBlock.x, this.selectedBlock.y, offscreen, "SELECTED");
    }

    this.lastVisibleBlocks = currentVisibleBlocks;
  }

  private drawBlockWithImageData(blockX: number, blockY: number) {
    // Put image at 1:1 resolution, then scale drawImage
    const offscreen = document.createElement('canvas');
    offscreen.width = this.blockSize;
    offscreen.height = this.blockSize;

    let data = this.blockService.getBlock(this.utils.getKey(blockX, blockY));
    if (!data) {
      this.drawRectangleBorder(blockX, blockY, offscreen, "NORMAL");
      return;
    }


    // Create a tiny block image (one pixel per cell)
    const imageData = this.ctx.createImageData(this.blockSize, this.blockSize);
    const pixels = imageData.data;

    for (let y = 0; y < this.blockSize; y++) {
      for (let x = 0; x < this.blockSize; x++) {
        const cell = data?.[x]?.[y];
        const color = cell ? 0 : 255; // black or white
        const index = (y * this.blockSize + x) * 4;
        pixels[index] = color;     // R
        pixels[index + 1] = color; // G
        pixels[index + 2] = color; // B
        pixels[index + 3] = 255;   // A
      }
    }

    const offCtx = offscreen.getContext('2d')!;
    offCtx.putImageData(imageData, 0, 0);
    this.drawRectangleBorder(blockX, blockY, offscreen, "NORMAL");
  }

  private drawRectangleBorder(blockX: number, blockY: number, offscreen: HTMLCanvasElement, color: string) {
    const baseX = blockX * this.blockSize;
    const baseY = blockY * this.blockSize;

    const blockCanvasX = (baseX - this.cellOffsetX) * this.cellSize;
    const blockCanvasY = (baseY - this.cellOffsetY) * this.cellSize;
    const blockPixelSize = this.blockSize * this.cellSize;

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(offscreen, blockCanvasX, blockCanvasY, blockPixelSize, blockPixelSize);
    if (color == "NORMAL") {
      this.ctx.lineWidth = 1;
      this.ctx.strokeStyle = 'rgba(128, 128, 128, 255)';
    } else {
      this.ctx.lineWidth = 3;
      this.ctx.strokeStyle = 'rgba(210, 0, 109, 1)';
    }
    this.ctx.strokeRect(blockCanvasX, blockCanvasY, blockPixelSize, blockPixelSize);
  }

  private onClick= (e: MouseEvent) => {
    // Single Click
    if (e.detail === 1) {
      this.startDragging(e);
    }
    // Double Click
    if (e.detail === 2) {
      this.selectBlock(e);
    }
  };

  private startDragging(e: MouseEvent) {
    this.isDragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.canvasRef.nativeElement.style.cursor = 'grabbing';
  }

  private selectBlock(e: MouseEvent) {
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Convert mouse position to world cell coordinates
    const worldX = this.cellOffsetX + mouseX / this.cellSize;
    const worldY = this.cellOffsetY + mouseY / this.cellSize;

    // Convert world cell coords to block coords
    const blockX = Math.floor(worldX / this.blockSize);
    const blockY = Math.floor(worldY / this.blockSize);

    this.selectedBlock = {x: blockX, y: blockY};

    // this.httpClient.get(`/gen-api/blockinfo/${blockX}/${blockY}`).subscribe(...);
  }

  private onDragEnd = () => {
    this.isDragging = false;
    this.canvasRef.nativeElement.style.cursor = 'grab';
  };

  private onDragMove = (e: MouseEvent) => {
    if (!this.isDragging) return;

    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;

    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;

    // Convert pixel movement to cell movement
    const movedX = dx / this.cellSize;
    const movedY = dy / this.cellSize;

    this.cellOffsetX -= movedX;
    this.cellOffsetY -= movedY;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();

    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newCellSize = this.cellSize * zoomFactor;

    // Limit zoom range
    if (newCellSize >= this.minCellSize && newCellSize <= this.maxCellSize) {
      // Zoom towards mouse position
      const rect = this.canvasRef.nativeElement.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Calculate world coordinates of mouse
      const worldX = this.cellOffsetX + mouseX / this.cellSize;
      const worldY = this.cellOffsetY + mouseY / this.cellSize;

      this.cellSize = newCellSize;

      // Adjust offset to keep mouse position stable
      this.cellOffsetX = worldX - mouseX / this.cellSize;
      this.cellOffsetY = worldY - mouseY / this.cellSize;
    }
  };

  private setupCanvasEvents() {
    const canvas = this.canvasRef.nativeElement;
    canvas.style.cursor = 'grab';

    // Drag & Pan
    canvas.addEventListener('mousedown', this.onClick);
    canvas.addEventListener('mouseup', this.onDragEnd);
    canvas.addEventListener('mouseleave', this.onDragEnd);
    canvas.addEventListener('mousemove', this.onDragMove);

    // Zoom
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  public zoomToFit() {
    // Calculate appropriate zoom level to fit content
    // This would need to be implemented based on your data bounds
    this.cellSize = 8.7;
    this.cellOffsetX = 0;
    this.cellOffsetY = 0;
  }

  public centerOn(worldX: number, worldY: number) {
    this.cellOffsetX = worldX - (this.canvasWidth / this.cellSize) / 2;
    this.cellOffsetY = worldY - (this.canvasHeight / this.cellSize) / 2;
  }

  // Getters for debugging/info
  public get currentZoom(): number {
    return this.cellSize;
  }

  public get currentOffset(): {x: number, y: number} {
    return {x: this.cellOffsetX, y: this.cellOffsetY};
  }

  public get visibleBlockCount(): number {
    return this.lastVisibleBlocks.size;
  }

}

