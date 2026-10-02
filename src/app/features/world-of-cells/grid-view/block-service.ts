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

/** An inclusive rectangle of block coordinates. */
export interface BlockBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
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
  /**
   * The subscription is always one rectangle, so the backend is told its two corners
   * and works out which keys to add and drop itself. The message stays the same size
   * however many blocks the rectangle holds.
   */
  private activeBounds: BlockBounds | undefined;
  private publishedBounds: BlockBounds | undefined;

  private noEditKey: string | undefined;
  /**
   * Decompression and the Life step run in a pool of workers, one per spare core.
   * A block is always routed to the same worker (see workerIndex), so each worker
   * holds the FULL baseline for its own keys and per-key ordering stays strict
   * without any coordination between workers.
   */
  private workers: Worker[] = [];
  private readonly maxWorkers = 8;
  /** Batches dispatched but not yet fully answered, oldest first. */
  private pendingBatches: PendingBatch[] = [];
  private lastBatchId = 0;
  private poolFactor = 1;
  /** Several workers can hit a resend error in one tick; ask the backend only once. */
  private resendTimer: ReturnType<typeof setTimeout> | null = null;
  private blockSize = 0;
  public clientId = '';
  private readonly subscriptionFull?: Subscription;
  private subscription?: Subscription;

  private readonly publishWindowMs = 250;
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

  /**
   * Splits a batch by owning worker and posts each worker only its own blocks.
   * The batch is tracked so its results can be committed as one tick once every
   * worker involved has replied; see onWorkerResults.
   */
  private dispatchToWorkers(type: 'init' | 'payload' | 'rescale', blocks: Block[]): void {
    const perWorker: Block[][] = this.workers.map(() => []);
    for (const block of blocks) {
      perWorker[this.workerIndex(block.x, block.y)].push(block);
    }

    const batchId = ++this.lastBatchId;
    const batch: PendingBatch = {id: batchId, pending: 0, results: []};

    perWorker.forEach((data, i) => {
      // init and rescale must reach every worker, even with nothing to decode.
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

  /**
   * Zoom-driven: bitmaps are built at blockSize / factor with density shading. Workers
   * rebuild what they hold, and the rebuild commits as one batch like any tick.
   */
  setPoolFactor(factor: number): void {
    if (factor === this.poolFactor) return;
    this.poolFactor = factor;
    if (this.workers.length > 0) {
      this.dispatchToWorkers('rescale', []);
    }
  }

  private workerIndex(x: number, y: number): number {
    // Two large primes spread neighbouring blocks over different workers, so a
    // viewport of adjacent blocks does not pile onto one of them.
    const hash = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
    return hash % this.workers.length;
  }

  /**
   * Buffers a worker's share of a batch. Nothing is shown until every worker in that
   * batch has replied, so all blocks of a tick appear in the same frame. Batches are
   * committed strictly in dispatch order, so a slow worker on an earlier tick can
   * never be overwritten by a faster later one and then land on top of it.
   */
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

    let hasError = false;

    for (const {bitmap, error, x, y} of results) {
      const key = getKey(x, y);

      if (error) {
        hasError = true;
        continue;
      }

      if (this.noEditKey !== key) {
        // Release the texture we are replacing now instead of waiting for GC; a tick
        // at far zoom swaps hundreds of them.
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
      if (!bounds) return; // nothing subscribed yet, so nothing to resend
      this.stompClient.publish({
        destination: '/block-request',
        body: JSON.stringify(this.toRequest(bounds)),
      });
    }, 0);
  }

  /** visibleKeys must be exactly the keys inside bounds. */
  updateVisible(visibleKeys: Set<string>, bounds: BlockBounds): void {
    for (const [key, bitmap] of this.blockData) {
      if (!visibleKeys.has(key)) {
        bitmap?.close();
        this.blockData.delete(key);
      }
    }

    this.activeBlocks = new Set(visibleKeys);
    this.activeBounds = bounds;
    this.schedulePublish();
  }

  /**
   * Leading-edge coalescing: the first change goes out immediately, then further
   * changes inside the window are batched into one trailing publish. A pan's first
   * new block no longer waits the whole window, while continuous panning still
   * sends at most one message per window.
   */
  private schedulePublish(): void {
    if (this.publishTimer !== null) return;
    if (!this.hasDrift()) return;

    this.publishBounds();

    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      if (this.hasDrift()) this.schedulePublish();
    }, this.publishWindowMs);
  }

  private hasDrift(): boolean {
    const active = this.activeBounds;
    const published = this.publishedBounds;
    if (!active) return false;
    if (!published) return true;
    return active.minX !== published.minX || active.minY !== published.minY
      || active.maxX !== published.maxX || active.maxY !== published.maxY;
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
    this.generation++;
  }
}
