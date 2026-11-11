import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild
} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {BlockService} from './block-service';
import { getKey } from './utils.component';
import {Settings} from '../../../requests/incoming/Settings';
import {ReconnectRequest} from '../../../requests/outgoing/ReconnectRequest';
import {ReconnectResponse} from '../../../requests/incoming/ReconnectResponse';
import {Coordinates} from '../../../requests/incoming/Coordinates';
import {Subscription} from 'rxjs';
import {ViewCenter} from '../../../shared/view-center';
import {ArrowIconComponent} from '../../../shared/icons/arrow-icon.component';
import {DisplaySettings} from '../../../shared/display-settings';

interface View {
  cellOffsetX: number;
  cellOffsetY: number;
  cellSize: number;
}

@Component({
  selector: 'grid-view',
  standalone: true,
  templateUrl: './grid-view.component.html',
  styleUrls: ['./grid-view.component.css'],
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [ArrowIconComponent]
})
export class GridViewComponent implements AfterViewInit, OnDestroy {
  @ViewChild('gridCanvas', {static: true}) canvasRef!: ElementRef<HTMLCanvasElement>;

  protected blockSize: number = 500;
  private cellSize = 2.5;
  private readonly minCellSize: number = 0.1
  private readonly maxCellSize: number = 30;
  private canvasWidth = window.innerWidth;
  private canvasHeight = window.innerHeight - 30;

  protected cellOffsetX = 0;
  protected cellOffsetY = 0;

  // Visited views; Previous and Next step through them and fetch a new viewport past either end.
  private readonly views: View[] = [];
  private viewIndex = 0;
  private recentViewports: Coordinates[] = [];
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

  private animationFrameId?: number;

  public selectedBlock: { x: number; y: number } | null = null;

  // Ticks come every 500 ms, so a short silence means the socket is gone, even if it never closed.
  private readonly reconnectThresholdMs = 4000;
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;
  private sessionDeadSubscription?: Subscription;
  private reconnectInFlight = false;

  constructor(private readonly httpClient: HttpClient, private readonly blockService: BlockService,
              private readonly viewCenter: ViewCenter, protected readonly settings: DisplaySettings) {
  }

  ngAfterViewInit() {
    if (!this.canvasRef?.nativeElement) {
      console.error('Canvas element not found. Make sure template has <canvas #gridCanvas></canvas>');
      return;
    }

    this.ctx = this.canvasRef.nativeElement.getContext('2d')!;
    this.resizeCanvas();
    window.addEventListener('resize', this.resizeCanvas);

    this.loadSettings();

    this.setupCanvasEvents();
    this.startRenderLoop();

    this.watchdogInterval = setInterval(() => this.reconnectIfSilentFor(this.reconnectThresholdMs), 250);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.sessionDeadSubscription = this.blockService.sessionDead$.subscribe(() => {
      this.reconnect();
    });
  }

  private loadSettings(): void {
    this.httpClient.get<Settings>('/gen-api/settings').subscribe((settings) => {
      this.blockSize = settings.blockSize;
      this.blockService.tickMs = settings.targetSpeed;
      this.blockService.setup(settings.blockSize, settings.clientId);
      this.goToViewport(settings.viewport);
    });
  }

  protected stepView(step: -1 | 1): void {
    const target = this.viewIndex + step;
    if (target >= 0 && target < this.views.length) {
      this.saveView();
      this.viewIndex = target;
      ({cellOffsetX: this.cellOffsetX, cellOffsetY: this.cellOffsetY, cellSize: this.cellSize} = this.views[target]);
      return;
    }

    this.httpClient.post<Coordinates>('/gen-api/viewport', this.recentViewports).subscribe((viewport) => {
      this.saveView();
      this.goToViewport(viewport);
      if (step === 1) {
        this.views.push(this.currentView());
        this.viewIndex = this.views.length - 1;
      } else {
        this.views.unshift(this.currentView());
        this.viewIndex = 0;
      }
    });
  }

  private goToViewport(viewport: Coordinates): void {
    this.recentViewports = [...this.recentViewports, viewport].slice(-5);
    this.centerOn(viewport.x, viewport.y);
  }

  // Keeps pans and zooms made since arriving at the current view.
  private saveView(): void {
    this.views[this.viewIndex] = this.currentView();
  }

  private currentView(): View {
    return {cellOffsetX: this.cellOffsetX, cellOffsetY: this.cellOffsetY, cellSize: this.cellSize};
  }

  // A phone waking from standby often holds a socket that died without closing, so don't wait for the watchdog.
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      this.reconnectIfSilentFor(this.reconnectThresholdMs);
    }
  };

  private reconnectIfSilentFor(ms: number): void {
    if (this.blockService.lastServerContact.getTime() < Date.now() - ms) {
      this.reconnect();
    }
  }

  private reconnect(): void {
    if (this.reconnectInFlight) return;
    this.reconnectInFlight = true;

    const reconnectRequest = new ReconnectRequest(Array.from(this.blockService.activeBlocks));
    this.httpClient.post<ReconnectResponse>("/gen-api/reconnect", reconnectRequest).subscribe({
      next: (reconnectResponse) => {
        this.blockService.renewSocket();
        this.blockService.setup(this.blockSize, reconnectResponse.clientId);
        this.blockService.lastServerContact = new Date();
        if (reconnectResponse.viewport) {
          this.goToViewport(reconnectResponse.viewport);
        }
        this.reconnectInFlight = false;
      }, error: () => {
        // Wait a whole threshold before trying again, so clients don't keep hammering a server that is struggling.
        this.blockService.lastServerContact = new Date();
        this.reconnectInFlight = false;
      }
    });
  }

  ngOnDestroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    if (this.watchdogInterval !== null) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
    this.sessionDeadSubscription?.unsubscribe();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('resize', this.resizeCanvas);
  }

  // Fills the window, keeping the cell in the middle of the view where it is.
  private readonly resizeCanvas = () => {
    const width = window.innerWidth;
    const height = window.innerHeight - 30;
    this.cellOffsetX += (this.canvasWidth - width) / this.cellSize / 2;
    this.cellOffsetY += (this.canvasHeight - height) / this.cellSize / 2;
    this.canvasWidth = width;
    this.canvasHeight = height;

    const ratio = Math.ceil(window.devicePixelRatio);
    const canvas = this.ctx.canvas;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    // Resizing resets the context and clears the canvas.
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.ctx.imageSmoothingQuality = 'high';
    this.drawnGeneration = -1;
  };

  private startRenderLoop() {
    const render = () => {
      this.updateVisibleBlocks();
      this.animationFrameId = requestAnimationFrame(render);
    };
    render();
  }

  private updateVisibleBlocks() {
    if (this.drawnGeneration == this.blockService.getGeneration() && this.drawnCellOffsetX == this.cellOffsetX && this.drawnCellOffsetY == this.cellOffsetY) {
      return;
    }
    this.ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

    const requestBottomX = Math.floor(this.cellOffsetX % this.blockSize) < this.blockSize / 2 ? 1 : 0;
    const requestTopX = Math.floor(this.cellOffsetX % this.blockSize) < this.blockSize / 2 ? 1 : 0;
    const requestBottomY = Math.floor(this.cellOffsetY % this.blockSize) < this.blockSize / 2 ? 1 : 0;
    const requestTopY = Math.floor(this.cellOffsetY % this.blockSize) < this.blockSize / 2 ? 1 : 0;

    this.drawnGeneration = this.blockService.getGeneration();
    this.drawnCellOffsetX = this.cellOffsetX;
    this.drawnCellOffsetY = this.cellOffsetY;

    const centerCellX = Math.floor(this.cellOffsetX + (this.canvasWidth / this.cellSize) / 2);
    const centerCellY = Math.floor(this.cellOffsetY + (this.canvasHeight / this.cellSize) / 2);

    this.viewCenter.x.set(centerCellX);
    this.viewCenter.y.set(centerCellY);

    const startBlockX = Math.floor(this.cellOffsetX / this.blockSize);
    const startBlockY = Math.floor(this.cellOffsetY / this.blockSize);
    const endBlockX = Math.floor((this.cellOffsetX + this.canvasWidth / this.cellSize) / this.blockSize);
    const endBlockY = Math.floor((this.cellOffsetY + this.canvasHeight / this.cellSize) / this.blockSize);

    const currentVisibleBlocks = new Set<string>();
    const drawnBlocks: {x: number, y: number}[] = [];

    // One ring of blocks around the visible area, so small pans and zooms find them loaded.
    for (let blockX = startBlockX - requestBottomX; blockX <= endBlockX + requestTopX; blockX++) {
      for (let blockY = startBlockY - requestBottomY; blockY <= endBlockY + requestTopY; blockY++) {
        const key = getKey(blockX, blockY);
        currentVisibleBlocks.add(key)
        if (blockX >= startBlockX && blockX <= endBlockX && blockY >= startBlockY && blockY <= endBlockY) {
          this.drawBlockWithImageData(blockX, blockY);
          drawnBlocks.push({x: blockX, y: blockY});
        }
      }
    }
    this.blockService.updateVisible(currentVisibleBlocks);
    this.blockService.setRendering({
      poolFactor: this.poolFactorForZoom(), alive: this.settings.alive(), dead: this.settings.dead(), gamma: this.settings.gamma(),
    }, drawnBlocks);

    if (this.selectedBlock != undefined) {
      const offscreen = document.createElement('canvas');
      offscreen.width = this.blockSize;
      offscreen.height = this.blockSize;
    }
  }

  private drawBlockWithImageData(blockX: number, blockY: number) {
    let imageData = this.blockService.getBlock(getKey(blockX, blockY));
    if (!imageData) {
      return;
    }

    const baseX = blockX * this.blockSize;
    const baseY = blockY * this.blockSize;

    const blockCanvasX = (baseX - this.cellOffsetX) * this.cellSize;
    const blockCanvasY = (baseY - this.cellOffsetY) * this.cellSize;
    const blockPixelSize = this.blockSize * this.cellSize;

    // Between 1 and 2 device pixels per cell, nearest-neighbour makes cells 1 or 2 pixels wide, which
    // turns fine patterns into bands. Below 1 the bitmap is pooled to 1-2 pixels per pooled cell.
    this.ctx.imageSmoothingEnabled = this.settings.smoothing() && this.devicePixelsPerCell() < 2;
    // Edges on whole device pixels: a pixel shared by two blocks would be blended twice and show as a light line.
    const ratio = Math.ceil(window.devicePixelRatio);
    const snap = (v: number) => Math.round(v * ratio) / ratio;
    const left = snap(blockCanvasX), top = snap(blockCanvasY);
    this.ctx.drawImage(imageData, left, top, snap(blockCanvasX + blockPixelSize) - left, snap(blockCanvasY + blockPixelSize) - top);

    if (this.settings.borders()) {
      this.ctx.lineWidth = 1;
      // The alive colour at half opacity: the old grey on the Classic theme.
      this.ctx.strokeStyle = this.settings.alive() + '80';

      this.ctx.strokeRect(blockCanvasX, blockCanvasY, blockPixelSize, blockPixelSize);
    }
  }

  // In physical pixels, matching the ratio the canvas is scaled by.
  private devicePixelsPerCell(): number {
    return this.cellSize * Math.ceil(window.devicePixelRatio);
  }

  private poolFactorForZoom(): number {
    const devicePixelsPerCell = this.devicePixelsPerCell();
    if (devicePixelsPerCell >= 1) {
      return 1;
    }
    // Never shrink a bitmap: each pooled pixel covers 1–2 device pixels, so fine patterns average to grey instead of moiré.
    return Math.pow(2, Math.ceil(Math.log2(1 / devicePixelsPerCell)));
  }

  private readonly onClick = (e: MouseEvent) => {
    if (e.detail === 1) {
      this.startDragging(e);
    }
  };

  private startDragging(e: MouseEvent) {
    this.isDragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.canvasRef.nativeElement.style.cursor = 'grabbing';
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
    const zoomFactor = e.deltaY > 0 ? 0.95 : 1.05;

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
      x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2,
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
      this.isPinching = false;
      this.isDragging = true;
      this.dragStartX = e.touches[0].clientX;
      this.dragStartY = e.touches[0].clientY;
    }
  };

  private setupCanvasEvents() {
    const canvas = this.canvasRef.nativeElement;
    canvas.style.cursor = 'grab';

    // Mouse
    canvas.addEventListener('mousedown', this.onClick);
    canvas.addEventListener('mouseup', this.onDragEnd);
    canvas.addEventListener('mouseleave', this.onDragEnd);
    canvas.addEventListener('mousemove', this.onDragMove);
    canvas.addEventListener('wheel', this.onWheel, {passive: false});

    // Touch
    canvas.addEventListener('touchstart', this.onTouchStart, {passive: false});
    canvas.addEventListener('touchmove', this.onTouchMove, {passive: false});
    canvas.addEventListener('touchend', this.onTouchEnd, {passive: false});
    canvas.addEventListener('touchcancel', this.onTouchEnd, {passive: false});
  }

  public centerOn(worldX: number, worldY: number) {
    this.cellOffsetX = worldX - (this.canvasWidth / this.cellSize) / 2;
    this.cellOffsetY = worldY - (this.canvasHeight / this.cellSize) / 2;
  }
}
