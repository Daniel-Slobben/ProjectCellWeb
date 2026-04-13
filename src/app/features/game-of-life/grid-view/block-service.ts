import {Injectable, OnDestroy} from '@angular/core';
import {IMessage, RxStomp} from '@stomp/rx-stomp';
import {HttpClient} from '@angular/common/http'
import SockJS from 'sockjs-client';
import {UpdateBlocks} from '../../../requests/UpdateBlocks';
import {Block} from '../../../requests/Block';
import {Subscription} from 'rxjs';
import {getKey} from './utils.component';

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

  constructor(private httpClient: HttpClient) {
    this.stompClient = new RxStomp();
    this.configureWebSocket();
  }

  ngOnDestroy() {
    console.log('Destroying block service');
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
    this.worker.terminate();
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
        if (this.noEditKey != getKey(x, y)) {
          this.blockData.set(getKey(x, y), imageData);
        }
      }
      this.generation++;
    }

    const topic = "/topic/" + this.clientId;
    console.log(topic);

    this.subscription = this.stompClient.watch(topic).subscribe((message: IMessage) => {
      this.worker.postMessage({type: 'update', payload: {data: JSON.parse(message.body), imageData: this.blockData}});
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
          this.worker.postMessage({type: 'update', payload: {data: blocks, imageData: this.blockData}});
        })
    }
  }

  getBlock(key: string): ImageData | undefined {
    return this.blockData.get(key);
  }

  setEdit(x: number, y: number, b: boolean) {
    if (b) {
      this.setNoEditKeyTrue(getKey(x, y));
    } else {
      this.noEditKey = undefined;
    }

  }

  setNoEditKeyTrue(key: string) {
    this.noEditKey = key;
  }
}
