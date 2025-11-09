import {Injectable} from '@angular/core';
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
      webSocketFactory: () => new SockJS('http://localhost:8080/ws'), connectHeaders: {}, reconnectDelay: 100,

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

  public addBlock(key: string) {
    console.log("subbing to " + key);
    // Fetch initial block with http
    this.httpClient.get<boolean[][]>(`/gen-api/block/${key}?isUpdating=true`).subscribe((data) => {
      if (this.getBlock(key) === undefined) {
        this.updateBlock(key, data)
      }
    });

    const topic = `/topic/block/${key}`;
    const subscription = this.stompClient.watch(topic).subscribe((message: IMessage) => {
      const data = JSON.parse(message.body);
      this.updateBlock(key, data);
    });
    this.subscriptions.set(key, subscription);
    this.setEditWithKey(key, false)
  }

  public setGhostBlock(key: string, body: boolean[][]) {
    this.blockData.set(key, body);
    this.setEditWithKey(key, true);
  }

  updateVisible(visibleKeys: Set<string>) {

    this.subscriptions.forEach((sub, key) => {
      if (!visibleKeys.has(key)) {
        console.log("deleteing" + key);
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
    this.setEditWithKey(this.utils.getKey(x, y), b);
  }

  setEditWithKey(key: string, b: boolean) {
    if (b) {
      this.noEditKey = key;
    } else {
      this.noEditKey = undefined;
    }
  }


}
