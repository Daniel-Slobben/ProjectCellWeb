import {Injectable, OnDestroy} from '@angular/core';
import {IMessage, RxStomp} from '@stomp/rx-stomp';
import {HttpClient} from '@angular/common/http';
import SockJS from 'sockjs-client';
import {Utils} from './utils.component';
import {UpdateBlocks} from '../../../requests/UpdateBlocks';
import {Subscription} from 'rxjs';

@Injectable({providedIn: 'root'})
export class BlockService implements OnDestroy {
  private readonly stompClient: RxStomp;
  private readonly blockData = new Map<string, ImageData | undefined>();
  private readonly encodedBlockData = new Map<string, Uint8Array | undefined>();
  private generation = 0;

  private activeBlocks = new Set<string>();
  private publishedBlocks = new Set<string>();

  private noEditKey: string | undefined;
  private worker!: Worker;
  private blockSize = 0;
  private clientId = '';
  private subscriptionFull?: Subscription;
  private subscription?: Subscription;

  private readonly publishWindowMs = 150;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private httpClient: HttpClient, private utils: Utils) {
    this.stompClient = new RxStomp();
    this.configureWebSocket();
  }

  ngOnDestroy(): void {
    if (this.publishTimer !== null) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    this.subscription?.unsubscribe();
    this.subscriptionFull?.unsubscribe();
    this.worker?.terminate();
    void this.stompClient.deactivate();
  }

  public getGeneration(): number {
    return this.generation;
  }

  private configureWebSocket(): void {
    this.stompClient.configure({
      webSocketFactory: () => new SockJS('/ws'),
      connectHeaders: {},
      reconnectDelay: 100,
    });
    this.stompClient.activate();
  }

  public setup(blockSize: number, clientId: string): void {
    this.blockSize = blockSize;
    this.clientId = clientId;

    this.worker = new Worker(
      new URL('./decompress-block.worker.ts', import.meta.url),
      {type: 'module'},
    );
    this.worker.postMessage({type: 'init', payload: {blockSize: this.blockSize}});

    this.worker.onmessage = (e) => {
      this.generation++;

      const errorKeys: string[] = [];

      for (const {image, data, error, x, y} of e.data.results) {
        const key = this.utils.getKey(x, y);

        if (error) {
          errorKeys.push(key);
          continue;
        }

        if (this.noEditKey !== key) {
          this.blockData.set(key, image);
          this.encodedBlockData.set(key, data);
        }
      }
      if (errorKeys.length > 0) {
        this.stompClient.publish({
          destination: '/block-request',
          body: JSON.stringify(new UpdateBlocks(this.clientId, [], [])),
        });
      }
    };

    this.subscriptionFull = this.stompClient
      .watch('/topic/full/' + this.clientId)
      .subscribe((message: IMessage) => {
        this.worker.postMessage({
          type: 'payload',
          payload: {data: JSON.parse(message.body), instant: false},
        });
      });

    this.subscription = this.stompClient
      .watch('/topic/' + this.clientId)
      .subscribe((message: IMessage) => {
        this.worker.postMessage({
          type: 'payload',
          payload: {data: JSON.parse(message.body), instant: false, encodedBlocks: this.encodedBlockData},
        });
      });
  }

  updateVisible(visibleKeys: Set<string>): void {
    for (const key of this.activeBlocks) {
      if (!visibleKeys.has(key)) {
        this.blockData.delete(key);
      }
    }

    this.activeBlocks = new Set(visibleKeys);
    this.schedulePublish();
  }

  private schedulePublish(): void {
    if (this.publishTimer !== null) return;
    if (!this.hasDrift()) return;

    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publishDelta();
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
      body: JSON.stringify(new UpdateBlocks(this.clientId, toRemove, toAdd)),
    });
    this.publishedBlocks = new Set(this.activeBlocks);
  }

  getBlock(key: string): ImageData | undefined {
    return this.blockData.get(key);
  }

  setEdit(x: number, y: number, b: boolean): void {
    this.noEditKey = b ? this.utils.getKey(x, y) : undefined;
  }

  setNoEditKeyTrue(key: string): void {
    this.noEditKey = key;
  }
}
