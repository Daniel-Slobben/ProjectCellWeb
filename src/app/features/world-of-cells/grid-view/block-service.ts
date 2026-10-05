import {Injectable, OnDestroy} from '@angular/core';
import {IMessage, RxStomp} from '@stomp/rx-stomp';
import {ClientUpdateRequest} from '../../../requests/outgoing/ClientUpdateRequest';
import {Subject, Subscription} from 'rxjs';
import {getKey} from './utils.component';
import {Block} from '../../../requests/incoming/Block';
import {DeleteBlocksRequest} from '../../../requests/outgoing/DeleteBlocksRequest';

interface WorkerResult {
  bitmap?: ImageBitmap;
  error?: boolean;
  x: number;
  y: number;
}

export interface BlockBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PendingBatch {
  id: number;
  pending: number;
  results: WorkerResult[];
}

@Injectable({providedIn: 'root'})
export class BlockService implements OnDestroy {
  private readonly stompClient: RxStomp;
  private readonly blockData = new Map<string, ImageBitmap | undefined>();
  private generation = 0;

  public activeBlocks = new Set<string>();
  private activeBounds: BlockBounds | undefined;
  private publishedBounds: BlockBounds | undefined;

  private noEditKey: string | undefined;
  private workers: Worker[] = [];
  private readonly maxWorkers = 8;
  private pendingBatches: PendingBatch[] = [];
  private lastBatchId = 0;
  private poolFactor = 1;
  private resendTimer: ReturnType<typeof setTimeout> | null = null;
  private blockSize = 0;

  public clientId = '';
  private readonly subscriptionFull?: Subscription;
  private subscription?: Subscription;

  private blockTimeout?: ReturnType<typeof setInterval>
  public blockTimeoutMap = new Map<string, number>();

  private readonly publishWindowMs = 300;
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
    this.setupInactiveBlockDeletion();

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

  private setupInactiveBlockDeletion() {
    console.log("starting inactive block deletion");
    this.blockTimeout = setInterval(() => {
      this.activeBlocks.forEach((key) => {
        this.blockTimeoutMap.set(key, 0);
      })
      const blocksToDelete: string[] = [];
      this.blockTimeoutMap.forEach((value, key) => {
        if (value > 4) {
          blocksToDelete.push(key);
          this.blockTimeoutMap.delete(key);
          this.blockData.get(key)?.close();
          this.blockData.delete(key);
        } else {
          this.blockTimeoutMap.set(key, value + 1);
        }
      })

      if (blocksToDelete.length !== 0) {
        const deleteBlockRequest = new DeleteBlocksRequest(this.clientId, blocksToDelete);
        this.stompClient.publish({
          destination: '/inactive-blocks',
          body: JSON.stringify(deleteBlockRequest)
        });
      }

    }, 5000);
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

  private dispatchToWorkers(type: 'init' | 'payload' | 'rescale', blocks: Block[]): void {
    const perWorker: Block[][] = this.workers.map(() => []);
    for (const block of blocks) {
      let worker = Math.abs(block.x + block.y) % this.workers.length;
      perWorker[worker].push(block);
    }

    const batchId = ++this.lastBatchId;
    const batch: PendingBatch = {id: batchId, pending: 0, results: []};

    perWorker.forEach((data, i) => {
      if (type === 'payload' && data.length === 0) return;
      batch.pending++;
      this.workers[i].postMessage({
        type,
        batchId,
        payload: {blockSize: this.blockSize, poolFactor: this.poolFactor, data},
      });
    });

    if (batch.pending > 0) {
      this.pendingBatches.push(batch);
    }
  }

  setPoolFactor(factor: number): void {
    if (factor === this.poolFactor) return;
    this.poolFactor = factor;
    if (this.workers.length > 0) {
      this.dispatchToWorkers('rescale', []);
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

    let hasError = false;

    for (const {bitmap, error, x, y} of results) {
      const key = getKey(x, y);

      if (error) {
        hasError = true;
        continue;
      }

      if (this.noEditKey !== key) {
        this.blockData.get(key)?.close();
        this.blockData.set(key, bitmap);
      } else {
        bitmap?.close();
      }
    }
    if (hasError) {
      this.scheduleFullResend();
    }
  }

  private scheduleFullResend(): void {
    if (this.resendTimer !== null) return;
    this.resendTimer = setTimeout(() => {
      this.resendTimer = null;
      const bounds = this.publishedBounds;
      if (!bounds) return;

      this.stompClient.publish({
        destination: '/block-request',
        body: JSON.stringify(this.toRequest(bounds)),
      });
    }, 0);
  }

  updateVisible(visibleKeys: Set<string>, bounds: BlockBounds): void {
    this.activeBlocks = new Set(visibleKeys);
    this.activeBounds = bounds;
    this.schedulePublish();
  }

  private schedulePublish(): void {
    if (this.publishTimer !== null) return;
    if (!this.hasPositiveDrift()) return;

    this.publishBounds();

    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      if (this.hasPositiveDrift()) this.schedulePublish();
    }, this.publishWindowMs);
  }

  private hasPositiveDrift(): boolean {
    const active = this.activeBounds;
    const published = this.publishedBounds;
    if (!active) return false;
    if (!published) return true;
    return active.minX < published.minX || active.minY < published.minY
      || active.maxX > published.maxX || active.maxY > published.maxY;
  }

  private publishBounds(): void {
    const bounds = this.activeBounds;
    if (!bounds) return;

    this.stompClient.publish({
      destination: '/client-update',
      body: JSON.stringify(this.toRequest(bounds)),
    });
    this.publishedBounds = bounds;
  }

  private toRequest(bounds: BlockBounds): ClientUpdateRequest {
    return new ClientUpdateRequest(
      this.clientId,
      getKey(bounds.minX, bounds.minY),
      getKey(bounds.maxX, bounds.maxY),
    );
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

    if (this.resendTimer !== null) {
      clearTimeout(this.resendTimer);
      this.resendTimer = null;
    }
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    for (const batch of this.pendingBatches) {
      for (const result of batch.results) result.bitmap?.close();
    }
    this.pendingBatches = [];

    this.blockData.clear();
    this.activeBounds = undefined;
    this.publishedBounds = undefined;
    this.noEditKey = undefined;
    this.blockTimeout = undefined;
    this.generation++;
  }
}
