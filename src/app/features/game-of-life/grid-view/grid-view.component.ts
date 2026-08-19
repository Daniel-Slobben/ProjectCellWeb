import {AfterViewInit, Component, ElementRef, OnDestroy, ViewChild,} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {HttpClient} from '@angular/common/http';
import {BlockService} from './block-service';
import {Utils} from './utils.component';
import {Settings} from '../../../requests/Settings';
import {ChaosHit} from '../../../requests/ChaosHit';

@Component({
  selector: 'grid-view',
  standalone: true,
  templateUrl: './grid-view.component.html',
  styleUrls: ['./grid-view.component.css'],
  imports: [FormsModule]
})
export class GridViewComponent implements AfterViewInit, OnDestroy {
  @ViewChild('gridCanvas', {static: true}) canvasRef!: ElementRef<HTMLCanvasElement>;

  protected blockSize: number = 500;
  private cellSize = 4;
  private readonly minCellSize: number = 1;
  private readonly maxCellSize: number = 20;
  private readonly canvasWidth = window.screen.width;
  private readonly canvasHeight = window.innerHeight - 30;

  protected cellOffsetX = 0;
  protected cellOffsetY = 0;
  private ctx!: CanvasRenderingContext2D;

  private drawnGeneration = 0;
  private drawnCellOffsetX = 0;
  private drawnCellOffsetY = 0;

  // Drag state
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;

  // Touch states (for mobile panning and zooming
  private isPinching = false;
  private lastTouchDistance = 0;
  private lastTouchMidX = 0;
  private lastTouchMidY = 0;

  protected drawBorders: boolean = false;

  private animationFrameId?: number;
  private lastVisibleBlocks = new Set<string>();

  public selectedBlock: { x: number; y: number } | null = null;

  private currentChaosHit!: ChaosHit;

  constructor(private readonly httpClient: HttpClient, private readonly blockService: BlockService, private readonly utils: Utils) {
  }

  ngAfterViewInit() {
    if (!this.canvasRef?.nativeElement) {
      console.error('Canvas element not found. Make sure template has <canvas #gridCanvas></canvas>');
      return;
    }

    const ratio = Math.ceil(window.devicePixelRatio);
    this.ctx = this.canvasRef.nativeElement.getContext('2d')!;

    this.ctx.canvas.width = this.canvasWidth * ratio;
    this.ctx.canvas.height = this.canvasHeight * ratio;
    this.ctx.canvas.style.width = `${this.canvasWidth}px`;
    this.ctx.canvas.style.height = `${this.canvasHeight}px`;
    this.ctx.canvas.getContext('2d')!.setTransform(ratio, 0, 0, ratio, 0, 0);

    // Set canvas rendering optimizations
    this.ctx.imageSmoothingEnabled = false;

    this.httpClient.get<Settings>('/gen-api/settings').subscribe((settings) => {
      this.blockSize = settings.blockSize;
      this.blockService.setup(settings.blockSize, settings.clientId)

      this.centerOn(settings.chaosHit.worldX, settings.chaosHit.worldY);
      this.currentChaosHit = settings.chaosHit;
    });

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
    if (this.drawnGeneration == this.blockService.getGeneration() &&
      this.drawnCellOffsetX == this.cellOffsetX &&
      this.drawnCellOffsetY == this.cellOffsetY) {
      return;
    }
    this.ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    this.drawnGeneration = this.blockService.getGeneration();
    this.drawnCellOffsetX = this.cellOffsetX;
    this.drawnCellOffsetY = this.cellOffsetY;

    const startBlockX = Math.floor(this.cellOffsetX / this.blockSize);
    const startBlockY = Math.floor(this.cellOffsetY / this.blockSize);
    const endBlockX = Math.floor((this.cellOffsetX + this.canvasWidth / this.cellSize) / this.blockSize);
    const endBlockY = Math.floor((this.cellOffsetY + this.canvasHeight / this.cellSize) / this.blockSize);
    const currentVisibleBlocks = new Set<string>();

    for (let blockX = startBlockX - 1; blockX <= endBlockX + 1; blockX++) {
      for (let blockY = startBlockY - 1; blockY <= endBlockY + 1; blockY++) {
        const key = this.utils.getKey(blockX, blockY);
        currentVisibleBlocks.add(key)
        if (blockX >= startBlockX && blockX <= endBlockX && blockY >= startBlockY && blockY <= endBlockY) {
          this.drawBlockWithImageData(blockX, blockY);
        }
      }
    }
    this.blockService.updateVisible(currentVisibleBlocks);

    if (this.selectedBlock != undefined) {
      const offscreen = document.createElement('canvas');
      offscreen.width = this.blockSize;
      offscreen.height = this.blockSize;
    }

    this.lastVisibleBlocks = currentVisibleBlocks;
  }

  private drawBlockWithImageData(blockX: number, blockY: number) {
    const offscreen = document.createElement('canvas');
    offscreen.width = this.blockSize;
    offscreen.height = this.blockSize;

    let imageData = this.blockService.getBlock(this.utils.getKey(blockX, blockY));
    if (!imageData) {
      return;
    }

    const offCtx = offscreen.getContext('2d')!;
    offCtx.putImageData(imageData, 0, 0);
    const baseX = blockX * this.blockSize;
    const baseY = blockY * this.blockSize;

    const blockCanvasX = (baseX - this.cellOffsetX) * this.cellSize;
    const blockCanvasY = (baseY - this.cellOffsetY) * this.cellSize;
    const blockPixelSize = this.blockSize * this.cellSize;

    this.ctx.imageSmoothingEnabled = false;

    this.ctx.drawImage(offscreen, blockCanvasX, blockCanvasY, blockPixelSize, blockPixelSize);

    if (this.drawBorders) {
      console.log("drawing borders");
      this.ctx.lineWidth = 1;
      this.ctx.strokeStyle = 'rgba(128, 128, 128, 255)';

      this.ctx.strokeRect(blockCanvasX, blockCanvasY, blockPixelSize, blockPixelSize);
    }

  }

  private readonly onClick = (e: MouseEvent) => {
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

  private readonly onDragEnd = () => {
    this.isDragging = false;
    this.canvasRef.nativeElement.style.cursor = 'grab';
  };

  private readonly onDragMove = (e: MouseEvent) => {
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

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 0.85 : 1.15;

    this.zoomAt(e.clientX, e.clientY, zoomFactor);
  };

  private zoomAt(clientX: number, clientY: number, zoomFactor: number) {
    const newCellSize = this.cellSize * zoomFactor;

    // Limit zoom range
    if (newCellSize >= this.minCellSize && newCellSize <= this.maxCellSize) {
      // Zoom towards the mouse position
      const rect = this.canvasRef.nativeElement.getBoundingClientRect();
      const mouseX = clientX - rect.left;
      const mouseY = clientY - rect.top;

      // Calculate world coordinates of mouse
      const worldX = this.cellOffsetX + mouseX / this.cellSize;
      const worldY = this.cellOffsetY + mouseY / this.cellSize;

      this.cellSize = newCellSize;

      // Adjust offset to keep the mouse position stable
      this.cellOffsetX = worldX - mouseX / this.cellSize;
      this.cellOffsetY = worldY - mouseY / this.cellSize;
    }
  }
  private getTouchDistance(touches: TouchList): number {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  private getTouchMidpoint(touches: TouchList): { x: number; y: number } {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  private readonly onTouchStart = (e: TouchEvent) => {
    e.preventDefault();

    if (e.touches.length === 1) {
      this.isDragging = true;
      this.isPinching = false;
      this.dragStartX = e.touches[0].clientX;
      this.dragStartY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      this.isDragging = false;
      this.isPinching = true;
      this.lastTouchDistance = this.getTouchDistance(e.touches);
      const mid = this.getTouchMidpoint(e.touches);
      this.lastTouchMidX = mid.x;
      this.lastTouchMidY = mid.y;
    }
  };

  private readonly onTouchMove = (e: TouchEvent) => {
    e.preventDefault();

    if (this.isPinching && e.touches.length === 2) {
      const newDistance = this.getTouchDistance(e.touches);
      const mid = this.getTouchMidpoint(e.touches);

      const zoomFactor = newDistance / this.lastTouchDistance;
      this.zoomAt(mid.x, mid.y, zoomFactor);

      this.lastTouchDistance = newDistance;
      this.lastTouchMidX = mid.x;
      this.lastTouchMidY = mid.y;
    } else if (this.isDragging && e.touches.length === 1) {
      const touch = e.touches[0];
      const dx = touch.clientX - this.dragStartX;
      const dy = touch.clientY - this.dragStartY;
      this.dragStartX = touch.clientX;
      this.dragStartY = touch.clientY;

      const movedX = dx / this.cellSize;
      const movedY = dy / this.cellSize;
      this.cellOffsetX -= movedX;
      this.cellOffsetY -= movedY;
    }
  };

  private readonly onTouchEnd = (e: TouchEvent) => {
    e.preventDefault();

    if (e.touches.length === 0) {
      this.isDragging = false;
      this.isPinching = false;
    } else if (e.touches.length === 1) {

      // Went from pinch to single-touch drag — reset drag start to avoid a jump
      this.isPinching = false;
      this.isDragging = true;
      this.dragStartX = e.touches[0].clientX;
      this.dragStartY = e.touches[0].clientY;
    }
  };

  private setupCanvasEvents() {
    const canvas = this.canvasRef.nativeElement;
    canvas.style.cursor = 'grab';

    // Drag & Pan for Mouse
    canvas.addEventListener('mousedown', this.onClick);
    canvas.addEventListener('mouseup', this.onDragEnd);
    canvas.addEventListener('mouseleave', this.onDragEnd);
    canvas.addEventListener('mousemove', this.onDragMove);

    // Drag & Pan for Touch
    canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
    canvas.addEventListener('touchend', this.onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', this.onTouchEnd, { passive: false });

    // Zoom
    canvas.addEventListener('wheel', this.onWheel, {passive: false});
  }



  public centerOn(worldX: number, worldY: number) {
    this.cellOffsetX = worldX - (this.canvasWidth / this.cellSize) / 2;
    this.cellOffsetY = worldY - (this.canvasHeight / this.cellSize) / 2;
  }

  public get currentZoom(): number {
    return this.cellSize;
  }

  public get currentOffset(): { x: number, y: number } {
    return {x: this.cellOffsetX, y: this.cellOffsetY};
  }

  public get visibleBlockCount(): number {
    return this.lastVisibleBlocks.size;
  }

  protected toggleBlockBorders() {
    this.drawBorders = !this.drawBorders;
  }

  protected nextChaosHit(goNextHit: boolean) {
    console.log("getting next chaoshit");
    this.httpClient.get<ChaosHit>(`/gen-api/next-chaos-hit/${this.currentChaosHit.id}/${goNextHit}`).subscribe((chaosHit) => {
      this.centerOn(chaosHit.worldX, chaosHit.worldY);
      this.currentChaosHit = chaosHit;
    });
  }

  protected readonly Math = Math;
}

