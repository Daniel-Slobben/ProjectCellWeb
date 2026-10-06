import {Injectable, OnDestroy} from '@angular/core';
import {IMessage, RxStomp} from '@stomp/rx-stomp';
import {ClientUpdateRequest} from '../../../requests/outgoing/ClientUpdateRequest';
import {Subject, Subscription} from 'rxjs';
import {getKey} from './utils.component';
import {Block} from '../../../requests/incoming/Block';

interface WorkerResult {
  bitmap?: ImageBitmap;
  error?: boolean;
  x: number;
  y: number;
}

interface PendingBatch {
  id: number;
  /** Workers that still owe a reply for this batch. */
  pending: number;
  results: WorkerResult[];
}

@Injectable({providedIn: 'root'})
export class BlockService implements OnDestroy {
  private readonly stompClient: RxStomp;
  private readonly blockData = new Map<string, ImageBitmap | undefined>();
  private generation = 0;

  public activeBlocks = new Set<string>();
  private publishedBlocks = new Set<string>();

  private noEditKey: string | undefined;
  private workers: Worker[] = [];
  private readonly maxWorkers = 8;
  private pendingBatches: PendingBatch[] = [];
  private lastBatchId = 0;
  private blockSize = 0;
  public clientId = '';
  private readonly subscriptionFull?: Subscription;
  private subscription?: Subscription;

  private readonly publishWindowMs = 150;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly healthCheckIntervalMs = 8000;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  public lastServerContact = new Date();

  private readonly sessionDeadSubject = new Subject<void>();
  public readonly sessionDead$ = this.sessionDeadSubject.asObservable();

  constructor() {
    this.stompClient = new RxStomp();
    this.configureWebSocket();
  }

  ngOnDestroy(): void {
    this.teardownSession();
    this.subscriptionFull?.unsubscribe();
    this.sessionDeadSubject.complete();
    void this.stompClient.deactivate();
  }

  public getGeneration(): number {
    return this.generation;
  }

  private configureWebSocket(): void {
    this.stompClient.configure({
      brokerURL: BlockService.brokerUrl('/ws'),
      connectHeaders: {},
      reconnectDelay: 500,
    });
    this.stompClient.activate();
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

    this.subscription = this.stompClient
      .watch('/topic/' + this.clientId)
      .subscribe((message: IMessage) => {
        const body = JSON.parse(message.body);

        if (body?.type === 'HEALTH_ACK') {
          this.lastServerContact = new Date();
          return;
        }

        if (body?.type === 'SESSION_DEAD') {
          this.sessionDeadSubject.next();
          return;
        }

        this.lastServerContact = new Date();
        this.dispatchToWorkers('payload', body);
      });

    this.healthCheckInterval = setInterval(() => {
      this.stompClient.publish({
        destination: '/health-check',
        body: JSON.stringify(this.clientId)
      })
    }, this.healthCheckIntervalMs)
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

  private dispatchToWorkers(type: 'init' | 'payload', blocks: Block[]): void {
    const perWorker: Block[][] = this.workers.map(() => []);
    for (const block of blocks) {
      let worker = Math.abs(block.x * 1000003 + block.y) % this.workers.length;
      perWorker[worker].push(block);
    }

    const batchId = ++this.lastBatchId;
    const batch: PendingBatch = {id: batchId, pending: 0, results: []};

    perWorker.forEach((data, i) => {
      // init must reach every worker so it learns blockSize, even with nothing to decode.
      if (type === 'payload' && data.length === 0) return;
      batch.pending++;
      this.workers[i].postMessage({type, batchId, payload: {blockSize: this.blockSize, data}});
    });

    if (batch.pending > 0) {
      this.pendingBatches.push(batch);
    }
  }

  private onWorkerResults(batchId: number, results: WorkerResult[]): void {
    const batch = this.pendingBatches.find((b) => b.id === batchId);
    if (!batch) return; // from a session that has since been torn down

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
        this.blockData.set(key, bitmap);
      } else {
        bitmap?.close();
      }
    }
    if (errorBlock.length > 0) {
      this.stompClient.publish({
        destination: '/client-update',
        body: JSON.stringify(new ClientUpdateRequest(this.clientId, [], errorBlock)),
      });
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

    this.stompClient.publish({
      destination: '/client-update',
      body: JSON.stringify(new ClientUpdateRequest(this.clientId, toRemove, toAdd)),
    });
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
    this.subscription?.unsubscribe();
    this.subscription = undefined;

    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    for (const batch of this.pendingBatches) {
      for (const result of batch.results) result.bitmap?.close();
    }
    this.pendingBatches = [];

    this.blockData.clear();
    this.publishedBlocks.clear();
    this.noEditKey = undefined;
    this.generation++;
  }
}
