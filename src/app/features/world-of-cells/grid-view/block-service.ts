import {Injectable, OnDestroy} from '@angular/core';
import {ClientUpdateRequest} from '../../../requests/outgoing/ClientUpdateRequest';
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
  private publishedBlocks = new Set<string>();

  private noEditKey: string | undefined;
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

  public start(blockSize: number): void {
    this.blockSize = blockSize;
    this.connect();
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

  setRendering(rendering: Rendering, visible: BlockPosition[]): void {
    const {poolFactor, alive, dead, gamma} = this.rendering;
    if (rendering.poolFactor === poolFactor && rendering.alive === alive && rendering.dead === dead && rendering.gamma === gamma) return;
    this.rendering = rendering;
    this.dispatchToWorkers('rescale', visible.filter(({x, y}) => this.blockData.has(getKey(x, y))));
  }

  private dispatchToWorkers(type: 'init' | 'rescale' | 'forget', blocks: BlockPosition[]): void {
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

    const errorBlock: string[] = [];

    for (const {bitmap, error, x, y} of results) {
      const key = getKey(x, y);

      if (error) {
        errorBlock.push(key);
        continue;
      }

      if (this.noEditKey !== key) {
        this.blockData.get(key)?.close();
        this.blockData.set(key, bitmap);
      } else {
        bitmap?.close();
      }
    }
    if (errorBlock.length > 0) {
      this.publishToSocket('/client-update', JSON.stringify(new ClientUpdateRequest([], errorBlock)));
    }
  }

  updateVisible(visibleKeys: Set<string>): void {
    for (const [key, bitmap] of this.blockData) {
      if (!visibleKeys.has(key)) {
        bitmap?.close();
        this.blockData.delete(key);
      }
    }
    this.dropDelayed((key) => !visibleKeys.has(key));

    this.activeBlocks = new Set(visibleKeys);
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
    if (this.activeBlocks.size !== this.publishedBlocks.size) return true;
    for (const key of this.activeBlocks) {
      if (!this.publishedBlocks.has(key)) return true;
    }
    return false;
  }

  private publishDelta(): void {
    const toRemove: string[] = [];
    for (const key of this.publishedBlocks) {
      if (!this.activeBlocks.has(key)) toRemove.push(key);
    }

    const toAdd: string[] = [];
    for (const key of this.activeBlocks) {
      if (!this.publishedBlocks.has(key)) toAdd.push(key);
    }

    if (toRemove.length === 0 && toAdd.length === 0) return;

    this.publishToSocket('/client-update', JSON.stringify(new ClientUpdateRequest(toRemove, toAdd)));
    this.publishedBlocks = new Set(this.activeBlocks);

    // Workers drop what they hold for removed blocks, so one that comes back starts over from its full block.
    if (toRemove.length > 0) {
      this.dispatchToWorkers('forget', toRemove.map((key) => {
        const [x, y] = key.split('/').map(Number);
        return {x, y};
      }));
    }
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

    this.publishedBlocks.clear();
    this.noEditKey = undefined;
    this.generation++;
  }
}
