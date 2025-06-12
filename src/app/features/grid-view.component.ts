import {AfterViewInit, Component, ElementRef, inject, NgZone, OnDestroy, ViewChild,} from '@angular/core';
import {firstValueFrom, Subscription} from 'rxjs';
import {FormsModule} from '@angular/forms';
import {IMessage, RxStomp} from '@stomp/rx-stomp';
import {HttpClient} from '@angular/common/http';
import SockJS from 'sockjs-client';

@Component({
  selector: 'grid-view', standalone: true, templateUrl: './grid-view.component.html', imports: [FormsModule]
})

export class GridViewComponent implements AfterViewInit, OnDestroy {
  @ViewChild('gridCanvas', {static: true}) canvasRef!: ElementRef<HTMLCanvasElement>;
  private stompClient: RxStomp;

  blockSize: number = 0;
  cellSize = 10;

  canvasWidth = 1600;
  canvasHeight = 800;

  cellOffsetX = 0;
  cellOffsetY = 0;

  private ctx!: CanvasRenderingContext2D;

  // Data structures
  private blockData = new Map<string, any[][]>();
  private subscriptions = new Map<string, Subscription>();

  private redrawQueue = new Set<string>();
  private redrawScheduled = false;

  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private lastPanTime = 0;
  private panThrottle = 20; // ms

  public teleportX = 0;
  public teleportY = 0;

  constructor(private httpClient: HttpClient) {
    this.stompClient = new RxStomp();
    this.configureWebSocket();
  }

  async ngAfterViewInit() {
    this.ctx = this.canvasRef.nativeElement.getContext('2d')!;
    this.canvasRef.nativeElement.width = this.canvasWidth;
    this.canvasRef.nativeElement.height = this.canvasHeight;

    this.blockSize = await firstValueFrom(this.httpClient.get<number>('/gen-api/blocksize'));
    this.setupCanvasEvents();
    this.updateVisibleBlocks();
  }

  ngOnDestroy() {
    // Unsubscribe all block subscriptions
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions.clear();
  }

//  private scheduleRedraw(blockX: number, blockY: number) {
//    const key = `${blockX},${blockY}`;
//    this.redrawQueue.add(key);
//
//    if (!this.redrawScheduled) {
//      this.redrawScheduled = true;
//      requestAnimationFrame(() => {
//        this.redrawQueue.forEach((key) => {
//          const [x, y] = key.split(',').map(Number);
//          this.drawSingleBlock(x, y);
//        });
//        this.redrawQueue.clear();
//        this.redrawScheduled = false;
//      });
//    }
//  }

  private drawSingleBlock(blockX: number, blockY: number) {
    const key = `${blockX},${blockY}`;
    const data = this.blockData.get(key);

    const baseX = blockX * this.blockSize;
    const baseY = blockY * this.blockSize;

    requestAnimationFrame(() => {
      for (let y = 0; y < this.blockSize; y++) {
        for (let x = 0; x < this.blockSize; x++) {
          let cell;
          if (data == undefined) {
            cell = undefined;
          } else {
            cell = data[x]?.[y];
          }
          const worldX = baseX + x;
          const worldY = baseY + y;

          const canvasX = (worldX - this.cellOffsetX) * this.cellSize;
          const canvasY = (worldY - this.cellOffsetY) * this.cellSize;

          if (canvasX >= 0 && canvasX < this.canvasWidth && canvasY >= 0 && canvasY < this.canvasHeight) {
            this.ctx.fillStyle = cell === null || cell === undefined ? 'white' : 'black';
            this.ctx.fillRect(canvasX, canvasY, this.cellSize, this.cellSize);
            this.ctx.strokeStyle = '#ccc';
            this.ctx.strokeRect(canvasX, canvasY, this.cellSize, this.cellSize);
          }
        }
      }

      // Draw block border
      const blockCanvasX = (baseX - this.cellOffsetX) * this.cellSize;
      const blockCanvasY = (baseY - this.cellOffsetY) * this.cellSize;
      const blockPixelSize = this.blockSize * this.cellSize;

      this.ctx.strokeStyle = 'rgba(255, 0, 0, 0.6)';
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(blockCanvasX, blockCanvasY, blockPixelSize, blockPixelSize);
      this.ctx.lineWidth = 1;
    });
  }

  private updateVisibleBlocks() {
    const startBlockX = Math.floor(this.cellOffsetX / this.blockSize);
    const startBlockY = Math.floor(this.cellOffsetY / this.blockSize);
    const endBlockX = Math.floor((this.cellOffsetX + this.canvasWidth / this.cellSize) / this.blockSize);
    const endBlockY = Math.floor((this.cellOffsetY + this.canvasHeight / this.cellSize) / this.blockSize);

    const visibleKeys = new Set<string>();

    for (let blockY = startBlockY; blockY <= endBlockY; blockY++) {
      for (let blockX = startBlockX; blockX <= endBlockX; blockX++) {
        const key = `${blockX},${blockY}`;
        const topic = `/topic/block/${blockX}/${blockY}`;
        visibleKeys.add(key);

        if (!this.subscriptions.has(key)) {
          // Fetch initial block state via REST
          this.httpClient.get<any[][]>(`/state/${blockX}/${blockY}`).subscribe((data: any[][]) => {
            this.blockData.set(key, data);
          }, (err: any) => {
            console.error('Failed to load block state:', err);
          });

          // Subscribe for live updates
          const subscription = this.stompClient.watch(topic).subscribe((message: IMessage) => {
            const data = JSON.parse(message.body);
            this.blockData.set(key, data);
            this.drawSingleBlock(blockX, blockY);
          });
          this.subscriptions.set(key, subscription);
        }
      }
    }

    // Unsubscribe from blocks no longer visible
    this.subscriptions.forEach((sub, key) => {
      if (!visibleKeys.has(key)) {
        sub.unsubscribe();
        this.subscriptions.delete(key);
        this.blockData.delete(key);
      }
    });

    visibleKeys.forEach((key) => {
      const [x, y] = key.split(',').map(Number);
      this.drawSingleBlock(x, y);
    });
  }

  private setupCanvasEvents() {
    const canvas = this.canvasRef.nativeElement;

    // Drag & Pan
    canvas.addEventListener('mousedown', this.onDragStart);
    canvas.addEventListener('mouseup', this.onDragEnd);
    canvas.addEventListener('mouseleave', this.onDragEnd);
    canvas.addEventListener('mousemove', this.onDragMove);

    // Click to toggle
    canvas.addEventListener('click', this.onCanvasClick);
  }

  // Use arrow functions so 'this' binds correctly
  private onDragStart = (e: MouseEvent) => {
    this.isDragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
  };

  private onDragEnd = () => {
    this.isDragging = false;
  };

  private onDragMove = (e: MouseEvent) => {
    if (!this.isDragging) return;

    const now = Date.now();
    if (now - this.lastPanTime < this.panThrottle) return;

    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;

    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;

    const movedX = Math.round(dx / this.cellSize);
    const movedY = Math.round(dy / this.cellSize);

    if (movedX !== 0 || movedY !== 0) {
      this.cellOffsetX -= movedX;
      this.cellOffsetY -= movedY;
      this.updateVisibleBlocks();
      this.lastPanTime = now;
    }
  };

  private onCanvasClick = (e: MouseEvent) => {
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();

    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    const worldX = Math.floor(canvasX / this.cellSize) + this.cellOffsetX;
    const worldY = Math.floor(canvasY / this.cellSize) + this.cellOffsetY;

    // Call toggle in service
    // TODO: ...
  };

  // ========== TELEPORT HANDLER ==========

  public teleport() {
    // Sanitize inputs
    const x = Math.max(0, Math.floor(this.teleportX));
    const y = Math.max(0, Math.floor(this.teleportY));

    this.cellOffsetX = x;
    this.cellOffsetY = y;

    this.updateVisibleBlocks();
  }

  private configureWebSocket() {
    this.stompClient.configure({
      webSocketFactory: () => new SockJS('http://localhost:8080/ws'),
      connectHeaders: {},
      debug: (msg) => {
        console.log(msg);
      },
      reconnectDelay: 200,
    });
    this.stompClient.activate();

    // Log connection status
    this.stompClient.connected$.subscribe(() => {
      console.log('Connected to WebSocket');
    });
  }
}
