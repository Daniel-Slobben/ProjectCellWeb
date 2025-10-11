import {AfterViewInit, Component, ElementRef, OnDestroy, ViewChild,} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {firstValueFrom} from 'rxjs';
import {HttpClient} from '@angular/common/http';
import {BlockService} from './block-service';
import {BlockInfoComponent} from './block-info.component';
import {NgIf} from '@angular/common';

@Component({
  selector: 'grid-view',
  standalone: true,
  templateUrl: './grid-view.component.html',
  imports: [FormsModule, BlockInfoComponent, NgIf]
})
export class GridViewComponent implements AfterViewInit, OnDestroy {

  @ViewChild('gridCanvas', {static: true}) canvasRef!: ElementRef<HTMLCanvasElement>;

  private blockSize: number = 10;
  private cellSize = 8.7;
  private minCellSize: number = 5;
  private maxCellSize: number = 20;
  private canvasWidth = 1200;
  private canvasHeight = 600;

  private cellOffsetX = 0;
  private cellOffsetY = 0;
  private ctx!: CanvasRenderingContext2D;

  // Drag state
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;

  // Performance optimization properties
  private animationFrameId?: number;
  private lastVisibleBlocks = new Set<string>();

  constructor(private httpClient: HttpClient, private blockService: BlockService) {
  }

  async ngAfterViewInit() {
    // Add null check for canvasRef
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

    for (let blockY = startBlockY; blockY <= endBlockY; blockY++) {
      for (let blockX = startBlockX; blockX <= endBlockX; blockX++) {
        const key = this.getKey(blockX, blockY);
        currentVisibleBlocks.add(key);

        if (this.blockService.getSubscription(key) == undefined) {
          this.blockService.addBlock(key);
        }
        const blockData = this.blockService.getBlock(key);
        console.log(`Drawing block ${key}, has data:`, blockData !== undefined);

        this.drawBlockWithImageData(blockX, blockY);
      }
    }
    this.blockService.updateVisible(currentVisibleBlocks);
    this.lastVisibleBlocks = currentVisibleBlocks;
  }

  private drawBlockWithImageData(blockX: number, blockY: number) {
    const data = this.blockService.getBlock(this.getKey(blockX, blockY));
    if (!data) return;

    const baseX = blockX * this.blockSize;
    const baseY = blockY * this.blockSize;

    // TODO selected block rode border maken, alle andere niet
    const blockCanvasX = (baseX - this.cellOffsetX) * this.cellSize;
    const blockCanvasY = (baseY - this.cellOffsetY) * this.cellSize;
    const blockPixelSize = this.blockSize * this.cellSize;

    // Create a tiny block image (one pixel per cell)
    const imageData = this.ctx.createImageData(this.blockSize, this.blockSize);
    const pixels = imageData.data;

    const dataDecoded = data.map(this.base64ToBytes);
    for (let x = 0; x < this.blockSize; x++) {
      for (let y = 0; y < this.blockSize; y++) {
        const color = this.byteToRgb(dataDecoded[x][y]);
        const index = (x * this.blockSize + y) * 4;
        pixels[index] = color[0];     // R
        pixels[index + 1] = color[1]; // G
        pixels[index + 2] = color[2]; // B
        pixels[index + 3] = 255;   // A
      }
    }

    // Put image at 1:1 resolution, then scale drawImage
    const offscreen = document.createElement('canvas');
    offscreen.width = this.blockSize;
    offscreen.height = this.blockSize;
    const offCtx = offscreen.getContext('2d')!;
    offCtx.putImageData(imageData, 0, 0);

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(offscreen, blockCanvasX, blockCanvasY, blockPixelSize, blockPixelSize);

    // Optional debug border
    this.ctx.strokeStyle = 'rgba(128, 128, 128, 255)';
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

    // Fake API call for now
    console.log(`Fetching info for block ${blockX}, ${blockY}`);
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

  // Public methods for external control
  public getKey(blockX: number, blockY: number): string {
    return `${blockX}/${blockY}`;
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

  public selectedBlock: {x: number; y: number} | null = null;

  /**
   * Map a byte (0–255) to an RGB color spanning the full hue spectrum.
   */
  /**
   * Convert 8-bit RGB332 color value to full 24-bit RGB tuple.
   * @param value - number from 0–255
   * @returns [r, g, b] each in range 0–255
   */
  public byteToRgb(value: number): [number, number, number] {
    if (value < 0 || value > 255) {
      throw new Error('Value must be between 0 and 255');
    }

    const rBits = (value >> 5) & 0b111;
    const gBits = (value >> 2) & 0b111;
    const bBits = value & 0b11;

    const r = Math.round((rBits / 7) * 255);
    const g = Math.round((gBits / 7) * 255);
    const b = Math.round((bBits / 3) * 255);

    return [r, g, b];
  }

  public base64ToBytes(base64: string): Uint8Array {
    return Uint8Array.from(base64);
  }
}

