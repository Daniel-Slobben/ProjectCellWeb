import {Injectable} from '@angular/core';
import {IMessage, RxStomp} from '@stomp/rx-stomp';
import {HttpClient} from '@angular/common/http'
import SockJS from 'sockjs-client';
import {Utils} from './utils.component';
import {UpdateBlocks} from '../../requests/UpdateBlocks';
import {v4 as uuidv4} from 'uuid';
import {Block} from '../../requests/Block';

@Injectable({providedIn: 'root'})
export class BlockService {
  private stompClient: RxStomp;
  private clientId: string;
  private blocksToRemove: string[] = [];
  private activeBlocks: string[] = [];
  private blockData = new Map<string, boolean[][] | undefined>();
  private noEditKey: string | undefined;

  constructor(private httpClient: HttpClient, private utils: Utils) {
    this.stompClient = new RxStomp();
    this.clientId = uuidv4();
    this.configureWebSocket();
  }

  private configureWebSocket() {

    this.stompClient.configure({
      webSocketFactory: () => new SockJS('http://localhost:8080/ws'), connectHeaders: {}, reconnectDelay: 100,

    });
    this.stompClient.activate();

    this.stompClient.connected$.subscribe(() => {
      console.log('Connected to WebSocket');
    });
    const topic = "/topic/" + this.clientId;
    console.log(topic);
    const subscription = this.stompClient.watch(topic).subscribe((message: IMessage) => {
      const data : Block[] = JSON.parse(message.body);
      data.forEach(block => {
        const key : string = this.utils.getKey(block.x, block.y);
        if (this.noEditKey != key) {
          this.blockData.set(key, block.cells)
        }
      })
    });
  }

  public setGhostBlock(key: string, body: boolean[][]) {
    this.blockData.set(key, body);
    this.setEditWithKey(key, true);
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
      this.stompClient.publish({
        destination: '/update-requested-blocks',
        body: JSON.stringify(new UpdateBlocks(this.clientId, this.blocksToRemove, newActiveBlocks))
      })
    }
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
