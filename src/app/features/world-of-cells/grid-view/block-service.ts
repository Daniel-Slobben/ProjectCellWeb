import {Injectable, OnDestroy} from '@angular/core';
import {BlockRange, ClientUpdateRequest} from '../../../requests/outgoing/ClientUpdateRequest';
import {Subject} from 'rxjs';
import {getKey, tileBlocks, workerIndex} from './utils.component';
import type {SocketCommand, SocketEvent} from './stomp.worker';

type BlockPosition = {x: number, y: number};

/** How the workers draw a block. */
export interface Rendering {
  poolFactor: number;
  sectorPoolFactor: number;
  alive: string;
  dead: string;
  gamma: number;
}

/** The sectors of tileBlocks x tileBlocks blocks. present[y * tileBlocks + x] is 1 for the blocks that have sectors. */
export interface Tile {
  bitmap: ImageBitmap;
  present: Uint8Array;
}

interface WorkerResult {
  bitmap?: ImageBitmap;
  error?: boolean;
  border?: boolean;
  // x and y are then a tile's.
  tile?: boolean;
  present?: Uint8Array;
  x: number;
  y: number;
}

interface PendingBatch {
  id: number;
  pending: number;
  results: WorkerResult[];
}

@Injectable({providedIn: 'root'})
export class BlockService implements OnDestroy {
  private readonly socket: Worker;
  private readonly blockData = new Map<string, ImageBitmap | undefined>();
  private readonly tiles = new Map<string, Tile>();
  private generation = 0;

  public activeBlocks = new Set<string>();
  // The server is told the range of blocks in view, and works out which blocks that adds or removes.
  private view: BlockRange | null = null;
  private publishedView: BlockRange | null = null;
  // Blocks whose cells went wrong, to get their full block again.
  private readonly resend = new Set<string>();
  // Zoomed far out the client watches sectors: it gets the sectors of the blocks in view instead of cells, less often the
  // more blocks are in view.
  // Zoomed back in, a block shows its sectors until its cells come.
  public sectors = false;
  private publishedSectors = false;

  private workers: Worker[] = [];
  private readonly workerCount = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  private pendingBatches: PendingBatch[] = [];
  private lastBatchId = 0;
  private rendering: Rendering = {poolFactor: 1, sectorPoolFactor: 1, alive: '#000000', dead: '#ffffff', gamma: 0.6};
  private blockSize = 0;

  // The backend's tick rate. Border updates are held back a tick and shown one per tick, so they keep a steady rhythm.
  public tickMs = 250;
  private delayedBorders: WorkerResult[][] = [];
  private playoutTimer: ReturnType<typeof setInterval> | null = null;

  private readonly publishWindowMs = 150;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;

  // The server found none of the blocks in view when this connection started.
  private readonly noBlocksSubject = new Subject<void>();
  public readonly noBlocks$ = this.noBlocksSubject.asObservable();

  constructor() {
    this.socket = new Worker(new URL('./stomp.worker.ts', import.meta.url), {type: 'module'});
    this.socket.onmessage = (e: MessageEvent<SocketEvent>) => this.onSocketEvent(e.data);
  }

  ngOnDestroy(): void {
    this.teardownSession();
    this.noBlocksSubject.complete();
    this.socket.terminate();
  }

  public getGeneration(): number {
    return this.generation;
  }

  private static brokerUrl(path: string): string {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${window.location.host}${path}`;
  }

  public setBlockSize(blockSize: number): void {
    this.blockSize = blockSize;
  }

  // The socket reconnects by itself until disconnect() is called.
  public connect(): void {
    if (this.blockSize === 0) return;
    this.sendToSocket({type: 'activate', brokerURL: BlockService.brokerUrl('/ws'), workers: this.workerCount});
  }

  public disconnect(): void {
    this.sendToSocket({type: 'deactivate'});
  }

  private sendToSocket(command: SocketCommand): void {
    this.socket.postMessage(command);
  }

  private publishToSocket(destination: string, body: string): void {
    this.sendToSocket({type: 'publish', destination, body});
  }

  private onSocketEvent(event: SocketEvent): void {
    switch (event.type) {
      case 'connected':
        // Each connection is a new client on the server, so start over and send the whole block list.
        this.teardownSession();
        this.createWorkerPool();
        this.schedulePublish();
        break;
      case 'blocks':
        this.postBatch(event.perWorker.map((frame) => frame && {type: 'payload', frame}));
        break;
      case 'noBlocks':
        this.noBlocksSubject.next();
        break;
    }
  }

  private createWorkerPool(): void {
    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(
        new URL('./decompress-block.worker.ts', import.meta.url),
        {type: 'module'},
      );
      worker.onmessage = (e) => this.onWorkerResults(e.data.batchId, e.data.results);
      this.workers.push(worker);
    }

    this.dispatchToWorkers('init', []);
  }

  // Workers draw their tiles again by themselves when the sector pool factor or the colours change.
  setRendering(rendering: Rendering, visible: BlockPosition[]): void {
    const {poolFactor, sectorPoolFactor, alive, dead, gamma} = this.rendering;
    if (rendering.poolFactor === poolFactor && rendering.sectorPoolFactor === sectorPoolFactor && rendering.alive === alive
      && rendering.dead === dead && rendering.gamma === gamma) return;
    this.rendering = rendering;
    this.dispatchToWorkers('rescale', visible.filter(({x, y}) => this.blockData.has(getKey(x, y))));
  }

  private dispatchToWorkers(type: 'init' | 'rescale', blocks: BlockPosition[]): void {
    // Before the first connection there are no workers.
    if (this.workers.length === 0) return;
    const perWorker: BlockPosition[][] = this.workers.map(() => []);
    for (const block of blocks) {
      perWorker[workerIndex(block.x, block.y, this.workers.length)].push(block);
    }

    this.postBatch(perWorker.map((data) => ({type, data})));
  }

  private postBatch(messages: ({type: string, data?: BlockPosition[], frame?: ArrayBuffer, view?: BlockRange, sectors?: boolean} | null)[]): void {
    const batchId = ++this.lastBatchId;
    const batch: PendingBatch = {id: batchId, pending: 0, results: []};

    messages.forEach((message, i) => {
      if (!message) return;
      batch.pending++;
      const {type, data, frame, view, sectors} = message;
      this.workers[i].postMessage(
        {type, batchId, payload: {blockSize: this.blockSize, ...this.rendering, data, frame, view, sectors}},
        frame ? [frame] : [],
      );
    });

    if (batch.pending > 0) {
      this.pendingBatches.push(batch);
    }
  }

  private onWorkerResults(batchId: number, results: WorkerResult[]): void {
    const batch = this.pendingBatches.find((b) => b.id === batchId);
    if (!batch) return;

    batch.results.push(...results);
    batch.pending--;

    while (this.pendingBatches.length > 0 && this.pendingBatches[0].pending === 0) {
      this.commitBatch(this.pendingBatches.shift()!.results);
    }
  }

  private commitBatch(results: WorkerResult[]): void {
    const borders = results.filter((r) => r.border);
    const immediate = results.filter((r) => !r.border);

    if (immediate.length > 0) {
      // Also a block that lost its cells: a border still held back would bring them back.
      const fresh = new Set(immediate.filter((r) => !r.tile && !r.error).map(({x, y}) => getKey(x, y)));
      this.dropDelayed((key) => fresh.has(key));
      this.applyResults(immediate);
    }

    if (borders.length > 0) {
      this.delayedBorders.push(borders);
      this.playoutTimer ??= setInterval(() => this.releaseBorders(), this.tickMs);
    }
  }

  private releaseBorders(): void {
    if (this.delayedBorders.length === 0) {
      // Fell behind; the next border starts a fresh one-tick delay.
      clearInterval(this.playoutTimer!);
      this.playoutTimer = null;
      return;
    }
    // Two in one tick are spread over the next ticks; any more and we catch up, so the delay stays short.
    while (this.delayedBorders.length > 2) {
      this.applyResults(this.delayedBorders.shift()!);
    }
    this.applyResults(this.delayedBorders.shift()!);
  }

  private dropDelayed(drop: (key: string) => boolean): void {
    this.delayedBorders = this.delayedBorders.map((batch) => batch.filter((r) => {
      if (!drop(getKey(r.x, r.y))) return true;
      r.bitmap?.close();
      return false;
    }));
  }

  private applyResults(results: WorkerResult[]): void {
    this.generation++;

    for (const {bitmap, error, tile, present, x, y} of results) {
      const key = getKey(x, y);

      if (tile) {
        this.tiles.get(key)?.bitmap.close();
        if (bitmap) this.tiles.set(key, {bitmap, present: present!});
        else this.tiles.delete(key);
        continue;
      }

      if (error) {
        this.resend.add(key);
        continue;
      }

      this.blockData.get(key)?.close();
      this.blockData.set(key, bitmap);
    }
    if (this.resend.size > 0) this.schedulePublish();
  }

  setSectors(sectors: boolean): void {
    if (sectors === this.sectors) return;
    this.sectors = sectors;
    this.schedulePublish();
  }

  updateVisible(view: BlockRange, visibleKeys: Set<string>): void {
    for (const [key, bitmap] of this.blockData) {
      if (!visibleKeys.has(key)) {
        bitmap?.close();
        this.blockData.delete(key);
      }
    }
    for (const [key, tile] of this.tiles) {
      const [x, y] = key.split('/').map(Number);
      const left = x * tileBlocks, top = y * tileBlocks;
      if (left > view.maxX || left + tileBlocks <= view.minX || top > view.maxY || top + tileBlocks <= view.minY) {
        tile.bitmap.close();
        this.tiles.delete(key);
      }
    }
    this.dropDelayed((key) => !visibleKeys.has(key));

    this.activeBlocks = new Set(visibleKeys);
    this.view = view;
    this.schedulePublish();
  }

  private schedulePublish(): void {
    if (this.publishTimer !== null) return;
    if (!this.hasDrift()) return;

    this.publishDelta();

    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      if (this.hasDrift()) this.schedulePublish();
    }, this.publishWindowMs);
  }

  private hasDrift(): boolean {
    const view = this.view, published = this.publishedView;
    if (!view) return false;
    return this.sectors !== this.publishedSectors || this.resend.size > 0 || !published
      || view.minX !== published.minX || view.maxX !== published.maxX || view.minY !== published.minY || view.maxY !== published.maxY;
  }

  private publishDelta(): void {
    if (!this.view) return;
    const resend = this.sectors ? [] : [...this.resend].filter((key) => this.activeBlocks.has(key));
    // Back from sectors the server sends the cells of the blocks in view; their sectors show until then.
    this.publishToSocket('/client-update', JSON.stringify(new ClientUpdateRequest(this.view, this.sectors, resend)));
    this.publishedView = this.view;
    this.publishedSectors = this.sectors;
    this.resend.clear();
    // Workers drop the cells of blocks that left the view, so one that comes back starts over from its full block.
    const view = this.view, sectors = this.sectors;
    this.postBatch(this.workers.map(() => ({type: 'view', view, sectors})));
  }

  getBlock(key: string): ImageBitmap | undefined {
    return this.blockData.get(key);
  }

  getTile(tileX: number, tileY: number): Tile | undefined {
    return this.tiles.get(getKey(tileX, tileY));
  }

  private teardownSession(): void {
    if (this.publishTimer !== null) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }

    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    for (const batch of this.pendingBatches) {
      for (const result of batch.results) result.bitmap?.close();
    }
    this.pendingBatches = [];
    if (this.playoutTimer !== null) {
      clearInterval(this.playoutTimer);
      this.playoutTimer = null;
    }
    this.dropDelayed(() => true);
    this.delayedBorders = [];

    // The server sends nothing for blocks that were pruned meanwhile, so their old picture would stay.
    for (const bitmap of this.blockData.values()) bitmap?.close();
    this.blockData.clear();
    for (const tile of this.tiles.values()) tile.bitmap.close();
    this.tiles.clear();

    this.publishedView = null;
    this.resend.clear();
    this.publishedSectors = false;
    this.generation++;
  }
}
