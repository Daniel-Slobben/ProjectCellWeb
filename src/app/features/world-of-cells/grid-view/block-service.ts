import {Injectable, OnDestroy} from '@angular/core';
import {IMessage, RxStomp} from '@stomp/rx-stomp';
import {ClientUpdateRequest} from '../../../requests/outgoing/ClientUpdateRequest';
import {Subject, Subscription} from 'rxjs';
import {getKey} from './utils.component';
import {Block} from '../../../requests/incoming/Block';

@Injectable({providedIn: 'root'})
export class BlockService implements OnDestroy {
  private readonly stompClient: RxStomp;
  private readonly blockData = new Map<string, ImageBitmap | undefined>();
  private generation = 0;

  public activeBlocks = new Set<string>();
  private publishedBlocks = new Set<string>();

  private noEditKey: string | undefined;
  /**
   * Decompression and the Life step run in a pool of workers, one per spare core.
   * A block is always routed to the same worker (see workerIndex), so each worker
   * holds the FULL baseline for its own keys and per-key ordering stays strict
   * without any coordination between workers.
   */
  private workers: Worker[] = [];
  private readonly maxWorkers = 8;
  /** Several workers can hit a resend error in one tick; ask the backend only once. */
  private resendTimer: ReturnType<typeof setTimeout> | null = null;
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
      worker.onmessage = (e) => this.onWorkerResults(e.data.results);
      this.workers.push(worker);
    }

    this.dispatchToWorkers('init', blocks);
  }

  /** Splits a batch by owning worker and posts each worker only its own blocks. */
  private dispatchToWorkers(type: 'init' | 'payload', blocks: Block[]): void {
    const perWorker: Block[][] = this.workers.map(() => []);
    for (const block of blocks) {
      perWorker[this.workerIndex(block.x, block.y)].push(block);
    }

    perWorker.forEach((data, i) => {
      // init must reach every worker so it learns blockSize, even with nothing to decode.
      if (type === 'payload' && data.length === 0) return;
      this.workers[i].postMessage({type, payload: {blockSize: this.blockSize, data}});
    });
  }

  private workerIndex(x: number, y: number): number {
    // Two large primes spread neighbouring blocks over different workers, so a
    // viewport of adjacent blocks does not pile onto one of them.
    const hash = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
    return hash % this.workers.length;
  }

  private onWorkerResults(results: { bitmap?: ImageBitmap; error?: boolean; x: number; y: number }[]): void {
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
      this.stompClient.publish({
        destination: '/block-request',
        body: JSON.stringify(new ClientUpdateRequest(this.clientId, [], [])),
      });
    }, 0);
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

  /**
   * Leading-edge coalescing: the first change goes out immediately, then further
   * changes inside the window are batched into one trailing publish. A pan's first
   * new block no longer waits the whole window, while continuous panning still
   * sends at most one message per window.
   */
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

    if (this.resendTimer !== null) {
      clearTimeout(this.resendTimer);
      this.resendTimer = null;
    }
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];

    this.blockData.clear();
    this.publishedBlocks.clear();
    this.noEditKey = undefined;
    this.generation++;
  }
}
