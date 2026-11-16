export interface View {
  cellOffsetX: number;
  cellOffsetY: number;
  cellSize: number;
}

/** The part of the world the canvas shows, and the mouse, touch and keyboard input that moves it. */
export class Viewport {
  cellSize = 2.5;
  private readonly minCellSize: number = 0.1
  private readonly maxCellSize: number = 30;
  width = window.innerWidth;
  height = window.innerHeight - 30;

  cellOffsetX = 0;
  cellOffsetY = 0;
  // Goes up on every change to the view, so the grid is drawn again.
  version = 0;

  // Drag state
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;

  // Touch states (for mobile panning and zooming
  private isPinching = false;
  private lastTouchDistance = 0;

  // By position rather than character, so WASD stays in place on other keyboard layouts.
  private readonly keyDirections: Record<string, [number, number]> = {
    KeyW: [0, -1], KeyA: [-1, 0], KeyS: [0, 1], KeyD: [1, 0],
    ArrowUp: [0, -1], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowRight: [1, 0],
  };
  // Screen pixels, so held keys move as fast at every zoom.
  private readonly keyPanPxPerMs = 1;
  private readonly keysDown = new Set<string>();
  private lastKeyMoveAt = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly step: (step: -1 | 1) => void) {
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

    // Keyboard
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  // The canvas listeners go with the canvas.
  destroy() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  get view(): View {
    return {cellOffsetX: this.cellOffsetX, cellOffsetY: this.cellOffsetY, cellSize: this.cellSize};
  }

  set view(view: View) {
    ({cellOffsetX: this.cellOffsetX, cellOffsetY: this.cellOffsetY, cellSize: this.cellSize} = view);
    this.version++;
  }

  centerOn(worldX: number, worldY: number) {
    this.cellOffsetX = worldX - (this.width / this.cellSize) / 2;
    this.cellOffsetY = worldY - (this.height / this.cellSize) / 2;
    this.version++;
  }

  // Keeps the cell in the middle of the view where it is.
  resize(width: number, height: number) {
    this.cellOffsetX += (this.width - width) / this.cellSize / 2;
    this.cellOffsetY += (this.height - height) / this.cellSize / 2;
    this.width = width;
    this.height = height;
    this.version++;
  }

  // Called every frame.
  moveByKeys() {
    const now = performance.now();
    // Capped, so the first frame after a pause doesn't jump.
    const ms = Math.min(now - this.lastKeyMoveAt, 100);
    this.lastKeyMoveAt = now;

    let x = 0, y = 0;
    for (const code of this.keysDown) {
      const [dx, dy] = this.keyDirections[code];
      x += dx;
      y += dy;
    }
    if (x !== 0 || y !== 0) {
      this.pan(-x * this.keyPanPxPerMs * ms, -y * this.keyPanPxPerMs * ms);
    }
  }

  private pan(dx: number, dy: number) {
    this.cellOffsetX -= dx / this.cellSize;
    this.cellOffsetY -= dy / this.cellSize;
    this.version++;
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
    this.canvas.style.cursor = 'grabbing';
  }

  private readonly onDragEnd = () => {
    this.isDragging = false;
    this.canvas.style.cursor = 'grab';
  };

  private readonly onDragMove = (e: MouseEvent) => {
    if (!this.isDragging) return;

    this.pan(e.clientX - this.dragStartX, e.clientY - this.dragStartY);
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
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
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = clientX - rect.left;
      const mouseY = clientY - rect.top;

      // Calculate world coordinates of mouse
      const worldX = this.cellOffsetX + mouseX / this.cellSize;
      const worldY = this.cellOffsetY + mouseY / this.cellSize;

      this.cellSize = newCellSize;

      // Adjust offset to keep the mouse position stable
      this.cellOffsetX = worldX - mouseX / this.cellSize;
      this.cellOffsetY = worldY - mouseY / this.cellSize;
      this.version++;
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
      this.pan(touch.clientX - this.dragStartX, touch.clientY - this.dragStartY);
      this.dragStartX = touch.clientX;
      this.dragStartY = touch.clientY;
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

  private readonly onKeyDown = (e: KeyboardEvent) => {
    // Leave browser shortcuts and the settings sliders alone.
    if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement) return;

    if (e.code in this.keyDirections) {
      // Arrows would otherwise scroll the page.
      e.preventDefault();
      this.keysDown.add(e.code);
    } else if (!e.repeat && (e.key === ',' || e.key === '<')) {
      this.step(-1);
    } else if (!e.repeat && (e.key === '.' || e.key === '>')) {
      this.step(1);
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keysDown.delete(e.code);
  };

  // Keys released while another window has focus never send a keyup here.
  private readonly onBlur = () => {
    this.keysDown.clear();
  };
}
