import {Injectable, OnDestroy} from '@angular/core';
import {BlockRange, ClientUpdateRequest} from '../../../requests/outgoing/ClientUpdateRequest';
import {Subject} from 'rxjs';
import {getKey, workerIndex} from './utils.component';
import type {SocketCommand, SocketEvent} from './stomp.worker';

type BlockPosition = {x: number, y: number};

/** How the workers draw a block. */
export interface Rendering {
  poolFactor: number;
  alive: string;
  dead: string;
  gamma: number;
}

interface WorkerResult {
  bitmap?: ImageBitmap;
  error?: boolean;
  border?: boolean;
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
  private generation = 0;

  public activeBlocks = new Set<string>();
  // The server is told the range of blocks in view, and works out which blocks that adds or removes.
  private view: BlockRange | null = null;
  private publishedView: BlockRange | null = null;
  // The blocks the workers hold cells for.
  private publishedBlocks = new Set<string>();
  // Blocks whose cells went wrong, to get their full block again.
  private readonly resend = new Set<string>();
  // Zoomed far out the client watches sectors: it gets the sectors of the blocks in view every 10 s, instead of cells.
  // Zoomed back in, a block shows its sectors until its cells come.
  public sectors = false;
  private publishedSectors = false;

  private workers: Worker[] = [];
  private readonly workerCount = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  private pendingBatches: PendingBatch[] = [];
  private lastBatchId = 0;
  private rendering: Rendering = {poolFactor: 1, alive: '#000000', dead: '#ffffff', gamma: 0.6};
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
    this.dispatchToWorkers('show', positions(this.activeBlocks));
  }

  setRendering(rendering: Rendering, visible: BlockPosition[]): void {
    const {poolFactor, alive, dead, gamma} = this.rendering;
    if (rendering.poolFactor === poolFactor && rendering.alive === alive && rendering.dead === dead && rendering.gamma === gamma) return;
    this.rendering = rendering;
    this.dispatchToWorkers('rescale', visible.filter(({x, y}) => this.blockData.has(getKey(x, y))));
  }

  private dispatchToWorkers(type: 'init' | 'rescale' | 'forget' | 'show' | 'hide', blocks: BlockPosition[]): void {
    // Before the first connection there are no workers, and nothing for them to forget.
    if (this.workers.length === 0) return;
    const perWorker: BlockPosition[][] = this.workers.map(() => []);
    for (const block of blocks) {
      perWorker[workerIndex(block.x, block.y, this.workers.length)].push(block);
    }

    this.postBatch(perWorker.map((data) => ({type, data})));
  }

  private postBatch(messages: ({type: string, data?: BlockPosition[], frame?: ArrayBuffer} | null)[]): void {
    const batchId = ++this.lastBatchId;
    const batch: PendingBatch = {id: batchId, pending: 0, results: []};

    messages.forEach((message, i) => {
      if (!message) return;
      batch.pending++;
      const {type, data, frame} = message;
      this.workers[i].postMessage(
        {type, batchId, payload: {blockSize: this.blockSize, ...this.rendering, data, frame}},
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
      const fresh = new Set(immediate.filter((r) => r.bitmap).map(({x, y}) => getKey(x, y)));
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

    for (const {bitmap, error, x, y} of results) {
      const key = getKey(x, y);

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
    this.dropDelayed((key) => !visibleKeys.has(key));

    // Workers draw the sectors of the blocks in view that have no cells.
    const shown = [...visibleKeys].filter((key) => !this.activeBlocks.has(key));
    const hidden = [...this.activeBlocks].filter((key) => !visibleKeys.has(key));
    if (shown.length > 0) this.dispatchToWorkers('show', positions(shown));
    if (hidden.length > 0) this.dispatchToWorkers('hide', positions(hidden));

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
    // Watching sectors, the workers hold no cells.
    const wanted = this.sectors ? new Set<string>() : this.activeBlocks;
    const toRemove = [...this.publishedBlocks].filter((key) => !wanted.has(key));

    const resend = [...this.resend].filter((key) => wanted.has(key));
    // Back from sectors the server sends the cells of the blocks in view; their sectors show until then.
    this.publishToSocket('/client-update', JSON.stringify(new ClientUpdateRequest(this.view, this.sectors, resend)));
    this.publishedView = this.view;
    this.publishedBlocks = new Set(wanted);
    this.publishedSectors = this.sectors;
    this.resend.clear();

    // Workers drop the cells of removed blocks, so one that comes back starts over from its full block.
    if (toRemove.length > 0) this.dispatchToWorkers('forget', positions(toRemove));
  }

  getBlock(key: string): ImageBitmap | undefined {
    return this.blockData.get(key);
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

    this.publishedView = null;
    this.publishedBlocks.clear();
    this.resend.clear();
    this.publishedSectors = false;
    this.generation++;
  }
}

function positions(keys: Iterable<string>): BlockPosition[] {
  return [...keys].map((key) => {
    const [x, y] = key.split('/').map(Number);
    return {x, y};
  });
}
