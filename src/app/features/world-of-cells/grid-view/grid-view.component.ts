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
import {Coordinates} from '../../../requests/incoming/Coordinates';
import {finalize, retry, Subscription, timeout} from 'rxjs';
import {ViewCenter} from '../../../shared/view-center';
import {ArrowIconComponent} from '../../../shared/icons/arrow-icon.component';
import {DisplaySettings} from '../../../shared/display-settings';
import {View, Viewport} from './viewport';

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
  private viewport!: Viewport;

  // Visited views; Previous and Next step through them and fetch a new viewport past either end.
  private readonly views: View[] = [];
  private viewIndex = 0;
  private recentViewports: Coordinates[] = [];
  private ctx!: CanvasRenderingContext2D;

  private drawnGeneration = 0;
  private drawnVersion = 0;

  private animationFrameId?: number;

  private readonly requestTimeoutMs = 5000;
  // Retries wait this long, so clients don't keep hammering a server that is struggling.
  private readonly retryDelayMs = 4000;
  // A hidden page lets go of its socket, so coming back always starts on a fresh one.
  private readonly disconnectAfterHiddenMs = 10_000;
  // After this long away the world has moved on: show something new.
  private readonly newViewportAfterHiddenMs = 6 * 60 * 60 * 1000;
  private hiddenAt?: number;
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private noBlocksSubscription?: Subscription;

  constructor(private readonly httpClient: HttpClient, private readonly blockService: BlockService,
              private readonly viewCenter: ViewCenter, protected readonly settings: DisplaySettings) {
  }

  ngAfterViewInit() {
    if (!this.canvasRef?.nativeElement) {
      console.error('Canvas element not found. Make sure template has <canvas #gridCanvas></canvas>');
      return;
    }

    this.ctx = this.canvasRef.nativeElement.getContext('2d')!;
    this.viewport = new Viewport(this.canvasRef.nativeElement, (step) => this.stepView(step));
    this.resizeCanvas();
    window.addEventListener('resize', this.resizeCanvas);

    this.loadSettings();

    this.startRenderLoop();

    document.addEventListener('visibilitychange', this.onVisibilityChange);
    if (document.hidden) this.onVisibilityChange();
    this.noBlocksSubscription = this.blockService.noBlocks$.subscribe(() => this.jumpToInterestingViewport());
  }

  private loadSettings(): void {
    this.httpClient.get<Settings>('/gen-api/settings')
      .pipe(timeout(this.requestTimeoutMs), retry({delay: this.retryDelayMs}))
      .subscribe((settings) => {
        this.blockSize = settings.blockSize;
        this.blockService.tickMs = settings.targetSpeed;
        this.goToViewport(settings.viewport);
        this.blockService.setBlockSize(settings.blockSize);
        // A hidden page connects once it is visible.
        if (!document.hidden) this.blockService.connect();
      });
  }

  protected stepView(step: -1 | 1): void {
    const target = this.viewIndex + step;
    if (target >= 0 && target < this.views.length) {
      this.saveView();
      this.viewIndex = target;
      this.viewport.view = this.views[target];
      return;
    }

    this.httpClient.post<Coordinates>('/gen-api/viewport', this.recentViewports).subscribe((viewport) => {
      this.saveView();
      this.goToViewport(viewport);
      if (step === 1) {
        this.views.push(this.viewport.view);
        this.viewIndex = this.views.length - 1;
      } else {
        this.views.unshift(this.viewport.view);
        this.viewIndex = 0;
      }
    });
  }

  private goToViewport(viewport: Coordinates): void {
    this.recentViewports = [...this.recentViewports, viewport].slice(-5);
    this.viewport.centerOn(viewport.x, viewport.y);
  }

  // Keeps pans and zooms made since arriving at the current view.
  private saveView(): void {
    this.views[this.viewIndex] = this.viewport.view;
  }

  private readonly onVisibilityChange = () => {
    clearTimeout(this.disconnectTimer);
    if (document.visibilityState === 'hidden') {
      this.hiddenAt ??= Date.now();
      this.disconnectTimer = setTimeout(() => this.blockService.disconnect(), this.disconnectAfterHiddenMs);
      return;
    }
    if (this.hiddenAt === undefined) return;
    const hiddenFor = Date.now() - this.hiddenAt;
    this.hiddenAt = undefined;
    if (hiddenFor > this.disconnectAfterHiddenMs) {
      // A phone in standby may not have run the timer, and its socket may have died without closing.
      this.blockService.disconnect();
    }
    if (hiddenFor > this.newViewportAfterHiddenMs) {
      // Connect once there, or the old view's blocks are requested first.
      this.jumpToInterestingViewport(() => this.blockService.connect());
    } else {
      this.blockService.connect();
    }
  };

  private jumpToInterestingViewport(then = () => {}): void {
    this.httpClient.post<Coordinates>('/gen-api/viewport', this.recentViewports)
      .pipe(timeout(this.requestTimeoutMs), finalize(then))
      .subscribe({next: (viewport) => this.goToViewport(viewport), error: () => {}});
  }

  ngOnDestroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    clearTimeout(this.disconnectTimer);
    this.viewport.destroy();
    this.noBlocksSubscription?.unsubscribe();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('resize', this.resizeCanvas);
  }

  private readonly resizeCanvas = () => {
    const width = window.innerWidth;
    const height = window.innerHeight - 30;
    this.viewport.resize(width, height);

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
      this.viewport.moveByKeys();
      this.updateVisibleBlocks();
      this.animationFrameId = requestAnimationFrame(render);
    };
    render();
  }

  private updateVisibleBlocks() {
    if (this.drawnGeneration == this.blockService.getGeneration() && this.drawnVersion == this.viewport.version) {
      return;
    }
    const {cellOffsetX, cellOffsetY, cellSize, width, height} = this.viewport;
    this.ctx.clearRect(0, 0, width, height);

    const requestBottomX = Math.floor(cellOffsetX % this.blockSize) < this.blockSize / 2 ? 1 : 0;
    const requestTopX = Math.floor(cellOffsetX % this.blockSize) < this.blockSize / 2 ? 1 : 0;
    const requestBottomY = Math.floor(cellOffsetY % this.blockSize) < this.blockSize / 2 ? 1 : 0;
    const requestTopY = Math.floor(cellOffsetY % this.blockSize) < this.blockSize / 2 ? 1 : 0;

    this.drawnGeneration = this.blockService.getGeneration();
    this.drawnVersion = this.viewport.version;

    const centerCellX = Math.floor(cellOffsetX + (width / cellSize) / 2);
    const centerCellY = Math.floor(cellOffsetY + (height / cellSize) / 2);

    this.viewCenter.x.set(centerCellX);
    this.viewCenter.y.set(centerCellY);

    const startBlockX = Math.floor(cellOffsetX / this.blockSize);
    const startBlockY = Math.floor(cellOffsetY / this.blockSize);
    const endBlockX = Math.floor((cellOffsetX + width / cellSize) / this.blockSize);
    const endBlockY = Math.floor((cellOffsetY + height / cellSize) / this.blockSize);

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
  }

  private drawBlockWithImageData(blockX: number, blockY: number) {
    let imageData = this.blockService.getBlock(getKey(blockX, blockY));
    if (!imageData) {
      return;
    }
    const {cellOffsetX, cellOffsetY, cellSize} = this.viewport;

    const baseX = blockX * this.blockSize;
    const baseY = blockY * this.blockSize;

    const blockCanvasX = (baseX - cellOffsetX) * cellSize;
    const blockCanvasY = (baseY - cellOffsetY) * cellSize;
    const blockPixelSize = this.blockSize * cellSize;

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
    return this.viewport.cellSize * Math.ceil(window.devicePixelRatio);
  }

  private poolFactorForZoom(): number {
    const devicePixelsPerCell = this.devicePixelsPerCell();
    if (devicePixelsPerCell >= 1) {
      return 1;
    }
    // Never shrink a bitmap: each pooled pixel covers 1–2 device pixels, so fine patterns average to grey instead of moiré.
    return Math.pow(2, Math.ceil(Math.log2(1 / devicePixelsPerCell)));
  }
}
