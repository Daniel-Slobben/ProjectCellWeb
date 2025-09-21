import {AfterViewInit, Component, ElementRef, OnDestroy, ViewChild,} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {firstValueFrom} from 'rxjs';
import {HttpClient} from '@angular/common/http';
import {BlockService} from './block-service';

@Component({
  selector: 'grid-view',
  standalone: true,
  templateUrl: './grid-view.component.html',
  imports: [FormsModule]
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
  private lastOffsetX = 0;
  private lastOffsetY = 0;
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
    canvas.removeEventListener('mousedown', this.onDragStart);
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

    // Always clear and redraw for now to debug
    this.ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

    console.log(`Rendering blocks from (${startBlockX},${startBlockY}) to (${endBlockX},${endBlockY})`);
    console.log(`Viewport: offset(${this.cellOffsetX.toFixed(1)}, ${this.cellOffsetY.toFixed(1)}) cellSize:${this.cellSize.toFixed(1)}`);

    let blocksDrawn = 0;

    // Collect visible blocks
    for (let blockY = startBlockY; blockY <= endBlockY; blockY++) {
      for (let blockX = startBlockX; blockX <= endBlockX; blockX++) {
        const key = this.getKey(blockX, blockY);
        currentVisibleBlocks.add(key);

        // Subscribe to block if not already subscribed
        if (this.blockService.getSubscription(key) == undefined) {
          this.blockService.addBlock(key);
        }

        // Always draw for debugging
        const blockData = this.blockService.getBlock(key);
        console.log(`Drawing block ${key}, has data:`, blockData !== undefined);

        this.drawBlockWithImageData(blockX, blockY);
        blocksDrawn++;
      }
    }

    console.log(`Drew ${blocksDrawn} blocks`);

    // Update block service with visible blocks
    this.blockService.updateVisible(currentVisibleBlocks);

    // Clear dirty blocks and update last visible set
    this.lastVisibleBlocks = currentVisibleBlocks;
  }

  private drawBlockWithImageData(blockX: number, blockY: number) {
    const data = this.blockService.getBlock(this.getKey(blockX, blockY));
    if (!data) return;

    const baseX = blockX * this.blockSize;
    const baseY = blockY * this.blockSize;

    const blockCanvasX = (baseX - this.cellOffsetX) * this.cellSize;
    const blockCanvasY = (baseY - this.cellOffsetY) * this.cellSize;
    const blockPixelSize = this.blockSize * this.cellSize;

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

    // Put image at 1:1 resolution, then scale drawImage
    const offscreen = document.createElement('canvas');
    offscreen.width = this.blockSize;
    offscreen.height = this.blockSize;
    const offCtx = offscreen.getContext('2d')!;
    offCtx.putImageData(imageData, 0, 0);

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(offscreen, blockCanvasX, blockCanvasY, blockPixelSize, blockPixelSize);

    // Optional debug border
    this.ctx.strokeStyle = 'rgba(255, 0, 0, 0.6)';
    this.ctx.strokeRect(blockCanvasX, blockCanvasY, blockPixelSize, blockPixelSize);
  }

  // Event handlers with arrow functions for proper 'this' binding
  private onDragStart = (e: MouseEvent) => {
    this.isDragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.canvasRef.nativeElement.style.cursor = 'grabbing';
  };

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
    canvas.addEventListener('mousedown', this.onDragStart);
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
}
