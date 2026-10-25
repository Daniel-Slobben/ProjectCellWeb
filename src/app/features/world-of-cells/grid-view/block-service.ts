import {Injectable, OnDestroy} from '@angular/core';
import {ClientUpdateRequest} from '../../../requests/outgoing/ClientUpdateRequest';
import {Subject} from 'rxjs';
import {getKey, workerIndex} from './utils.component';
import {Block} from '../../../requests/incoming/Block';
import type {SocketCommand, SocketEvent} from './stomp.worker';

interface WorkerResult {
  bitmap?: ImageBitmap;
  error?: boolean;
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
  private readonly maxWorkers = 8;
  private pendingBatches: PendingBatch[] = [];
  private lastBatchId = 0;
  private poolFactor = 1;
  private blockSize = 0;
  public clientId = '';

  private readonly publishWindowMs = 150;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly healthCheckIntervalMs = 8000;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  public lastServerContact = new Date();

  private readonly sessionDeadSubject = new Subject<void>();
  public readonly sessionDead$ = this.sessionDeadSubject.asObservable();

  constructor() {
    this.socket = new Worker(new URL('./stomp.worker.ts', import.meta.url), {type: 'module'});
    this.socket.onmessage = (e: MessageEvent<SocketEvent>) => this.onSocketEvent(e.data);
    this.sendToSocket({type: 'activate', brokerURL: BlockService.brokerUrl('/ws')});
  }

  ngOnDestroy(): void {
    this.teardownSession();
    this.sessionDeadSubject.complete();
    this.sendToSocket({type: 'deactivate'});
  }

  public getGeneration(): number {
    return this.generation;
  }

  private static brokerUrl(path: string): string {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${window.location.host}${path}`;
  }

  public setup(blockSize: number, clientId: string, blocks: Block[]): void {
    this.teardownSession();

    this.blockSize = blockSize;
    this.clientId = clientId;

    this.createWorkerPool(blocks);
    this.sendToSocket({type: 'subscribe', clientId, workers: this.workers.length});

    this.healthCheckInterval = setInterval(() => {
      this.publishToSocket('/health-check', JSON.stringify(this.clientId));
    }, this.healthCheckIntervalMs)
  }

  private sendToSocket(command: SocketCommand): void {
    this.socket.postMessage(command);
  }

  private publishToSocket(destination: string, body: string): void {
    this.sendToSocket({type: 'publish', destination, body});
  }

  private onSocketEvent(event: SocketEvent): void {
    if (event.clientId !== this.clientId) return;

    // this.lastServerContact = new Date();
    switch (event.type) {
      case 'sessionDead':
        this.sessionDeadSubject.next();
        break;
      case 'blocks':
        this.postBatch(event.perWorker.map((frame) => frame && {type: 'payload', frame}));
        break;
    }
  }

  private createWorkerPool(blocks: Block[]): void {
    const cores = navigator.hardwareConcurrency || 4;
    const count = Math.max(1, Math.min(this.maxWorkers, cores - 1));

    for (let i = 0; i < count; i++) {
      const worker = new Worker(
        new URL('./decompress-block.worker.ts', import.meta.url),
        {type: 'module'},
      );
      worker.onmessage = (e) => this.onWorkerResults(e.data.batchId, e.data.results);
      this.workers.push(worker);
    }

    this.dispatchToWorkers('init', blocks);
  }

  setPoolFactor(factor: number, visible: Pick<Block, 'x' | 'y'>[]): void {
    if (factor === this.poolFactor) return;
    this.poolFactor = factor;
    this.dispatchToWorkers('rescale', visible.filter(({x, y}) => this.blockData.has(getKey(x, y))));
  }

  private dispatchToWorkers(type: 'init' | 'rescale', blocks: Pick<Block, 'x' | 'y'>[]): void {
    const perWorker: Pick<Block, 'x' | 'y'>[][] = this.workers.map(() => []);
    for (const block of blocks) {
      perWorker[workerIndex(block.x, block.y, this.workers.length)].push(block);
    }

    this.postBatch(perWorker.map((data) => ({type, data})));
  }

  private postBatch(messages: ({type: string, data?: Pick<Block, 'x' | 'y'>[], frame?: ArrayBuffer} | null)[]): void {
    const batchId = ++this.lastBatchId;
    const batch: PendingBatch = {id: batchId, pending: 0, results: []};

    messages.forEach((message, i) => {
      if (!message) return;
      batch.pending++;
      const {type, data, frame} = message;
      this.workers[i].postMessage(
        {type, batchId, payload: {blockSize: this.blockSize, poolFactor: this.poolFactor, data, frame}},
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
      this.publishToSocket('/client-update', JSON.stringify(new ClientUpdateRequest(this.clientId, [], errorBlock)));
    }
  }

  updateVisible(visibleKeys: Set<string>): void {
    for (const [key, bitmap] of this.blockData) {
      if (!visibleKeys.has(key)) {
        bitmap?.close();
        this.blockData.delete(key);
      }
    }

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

    this.publishToSocket('/client-update', JSON.stringify(new ClientUpdateRequest(this.clientId, toRemove, toAdd)));
    this.publishedBlocks = new Set(this.activeBlocks);
  }

  getBlock(key: string): ImageBitmap | undefined {
    return this.blockData.get(key);
  }

  private teardownSession(): void {
    if (this.publishTimer !== null) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    if (this.healthCheckInterval !== null) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.sendToSocket({type: 'unsubscribe'});

    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    for (const batch of this.pendingBatches) {
      for (const result of batch.results) result.bitmap?.close();
    }
    this.pendingBatches = [];

    for (const bitmap of this.blockData.values()) bitmap?.close();
    this.blockData.clear();
    this.publishedBlocks.clear();
    this.noEditKey = undefined;
    this.generation++;
  }
}
