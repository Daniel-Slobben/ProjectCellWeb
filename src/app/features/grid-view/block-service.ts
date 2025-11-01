import { Injectable } from '@angular/core';
import {IMessage, RxStomp} from '@stomp/rx-stomp';
import {Subscription} from 'rxjs';
import {HttpClient} from '@angular/common/http'
import SockJS from 'sockjs-client';
import {Utils} from './utils.component';

@Injectable({providedIn: 'root'})
export class BlockService {
  private stompClient: RxStomp;
  private subscriptions = new Map<string, Subscription>();
  private blockData = new Map<string, boolean[][] | undefined>();
  private noEditKey: string | undefined;

  constructor(private httpClient: HttpClient, private utils: Utils) {
    this.stompClient = new RxStomp();
    this.configureWebSocket();
  }

  private configureWebSocket() {
    this.stompClient.configure({
      webSocketFactory: () => new SockJS('http://localhost:8080/ws'),
      connectHeaders: {},
      debug: (msg) => {
        console.log(msg);
      },
      reconnectDelay: 200,
    });
    this.stompClient.activate();

    // Log connection status
    this.stompClient.connected$.subscribe(() => {
      console.log('Connected to WebSocket');
    });
  }

  public getSubscription(key: string): Subscription | undefined {
    return this.subscriptions.get(key);
  }

  public addBlock(key : string) {
    const topic = `/topic/block/${key}`;
    const subscription = this.stompClient.watch(topic).subscribe((message: IMessage) => {
      const data = JSON.parse(message.body);
      this.updateBlock(key, data);
    });
    this.subscriptions.set(key, subscription);

    // Fetch initial block with http
    this.blockData.set(key, undefined);
    this.httpClient.get<boolean[][]>(`/gen-api/block/${key}?isUpdating=true`).subscribe((data) => {
      if (this.getBlock(key) === undefined) {
        this.updateBlock(key, data)
      }
    });
  }

  updateVisible(visibleKeys: Set<string>) {
    // Its probably more efficient to only remove it after a little while
    this.subscriptions.forEach((sub, key) => {
      if (!visibleKeys.has(key)) {
        sub.unsubscribe();
        this.subscriptions.delete(key);
        this.blockData.delete(key);
        this.httpClient.get<boolean[][]>(`/gen-api/block/${key}?isUpdating=false`).subscribe((data) => {
          this.updateBlock(key, data)
        });
      }
    });
  }

  updateBlock(key: string, data: boolean[][]) {
    if (key === this.noEditKey) return;
    this.blockData.set(key, data);
  }

  getBlock(key: string): boolean[][] | undefined {
    return this.blockData.get(key);
  }

  setBlock(key: string, data: boolean[][]) {
    this.blockData.set(key, data);
  }

  setEdit(x: number, y: number, b: boolean) {
    if (b) {
      this.noEditKey = this.utils.getKey(x, y);
    }
    else {
      this.noEditKey = undefined;
    }
  }
}
