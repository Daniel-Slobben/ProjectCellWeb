import {Injectable, OnDestroy} from '@angular/core';
import {IMessage, RxStomp} from '@stomp/rx-stomp';
import {HttpClient} from '@angular/common/http'
import SockJS from 'sockjs-client';
import {Utils} from './utils.component';
import {UpdateBlocks} from '../../../requests/UpdateBlocks';
import {Block} from '../../../requests/Block';
import {Subscription} from 'rxjs';

@Injectable({providedIn: 'root'})
export class BlockService implements OnDestroy {
  private readonly stompClient: RxStomp;
  private readonly blockData = new Map<string, ImageData | undefined>();

  private generation: number = 0;
  private blocksToRemove: string[] = [];
  private activeBlocks: string[] = [];
  private noEditKey: string | undefined;
  private worker!: Worker;

  private blockSize: number = 0;
  private clientId: string = "";

  private subscription?: Subscription;

  constructor(private httpClient: HttpClient, private utils: Utils) {
    this.stompClient = new RxStomp();
    this.configureWebSocket();
  }

  ngOnDestroy() {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
  }

  public getGeneration(): number {
    return this.generation;
  }

  private configureWebSocket() {

    this.stompClient.configure({
      webSocketFactory: () => new SockJS('/ws'), connectHeaders: {}, reconnectDelay: 100,
    });
    this.stompClient.activate();
  }

  public setup(blockSize: number, clientId: string) {
    this.blockSize = blockSize;
    this.clientId = clientId;

    this.worker = new Worker(new URL('/decompress-block.worker.ts', import.meta.url), {type: 'module'});

    this.worker.postMessage({type: 'init', payload: {blockSize: this.blockSize}});
    this.worker.onmessage = (e) => {
      for (const { imageData, x, y } of e.data) {
        if (this.noEditKey != this.utils.getKey(x, y)) {
          this.blockData.set(this.utils.getKey(x, y), imageData);
        }
      }
      this.generation++;
    }

    const topic = "/topic/" + this.clientId;
    console.log(topic);

    this.subscription = this.stompClient.watch(topic).subscribe((message: IMessage) => {
      this.worker.postMessage({type: 'payload', payload: {data: JSON.parse(message.body), instant: false}});
    });
  }

  updateVisible(visibleKeys: Set<string>) {
    const originalActiveBlocks = Object.assign([], this.activeBlocks);
    this.blocksToRemove = [];
    this.activeBlocks.forEach((key) => {
      if (!visibleKeys.has(key)) {
        this.blockData.delete(key);
        this.blocksToRemove.push(key);
      }
    });
    this.activeBlocks = [];
    visibleKeys.forEach((key) => {
      this.activeBlocks.push(key);
    })
    const newActiveBlocks = this.activeBlocks.filter(key => !originalActiveBlocks.includes(key)).map(key => key);

    if (this.blocksToRemove.length > 0 || newActiveBlocks.length > 0) {
      this.httpClient.post<Block[]>('/gen-api/client-update', JSON.stringify(new UpdateBlocks(this.clientId, this.blocksToRemove, newActiveBlocks)), {headers: {'Content-Type': 'application/json'}})
        .subscribe((blocks: Block[]) => {
          this.worker.postMessage({type: 'payload', payload: {data: blocks, instant: true}});
        })
    }
  }

  getBlock(key: string): ImageData | undefined {
    return this.blockData.get(key);
  }

  setEdit(x: number, y: number, b: boolean) {
    if (b) {
      this.setNoEditKeyTrue(this.utils.getKey(x, y));
    } else {
      this.noEditKey = undefined;
    }

  }

  setNoEditKeyTrue(key: string) {
    this.noEditKey = key;
  }
}
