import {Injectable, OnDestroy} from '@angular/core';
import {IMessage, RxStomp} from '@stomp/rx-stomp';
import {HttpClient} from '@angular/common/http'
import SockJS from 'sockjs-client';
import {Utils} from './utils.component';
import {UpdateBlocks} from '../../requests/UpdateBlocks';
import {v4 as uuidv4} from 'uuid';
import {Block} from '../../requests/Block';
import {Subscription} from 'rxjs';

@Injectable({providedIn: 'root'})
export class BlockService implements OnDestroy{
  private readonly stompClient: RxStomp;
  private readonly clientId: string;
  private readonly blockData = new Map<string, boolean[][] | undefined>();

  private blockSize: number = 0;
  private blocksToRemove: string[] = [];
  private activeBlocks: string[] = [];
  private noEditKey: string | undefined;

  private subscription?: Subscription;

  constructor(private httpClient: HttpClient, private utils: Utils) {
    this.stompClient = new RxStomp();
    this.clientId = uuidv4();
    this.configureWebSocket();
  }

  ngOnDestroy() {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
  }

  public setBlockSize(blockSize: number) {
    this.blockSize = blockSize;
  }

  private configureWebSocket() {

    this.stompClient.configure({
      webSocketFactory: () => new SockJS('/gen-api/ws'), connectHeaders: {}, reconnectDelay: 100,
    });
    this.stompClient.activate();

    this.subscription = this.stompClient.connected$.subscribe(() => {
      console.log('Connected to WebSocket');
    });

    const topic = "/topic/" + this.clientId;
    console.log(topic);

    this.stompClient.watch(topic).subscribe((message: IMessage) => {
      this.receiveBlockList(JSON.parse(message.body));
    });
  }

  private receiveBlockList(blocks : Block[]) {
    blocks.forEach(block => {
      const key: string = this.utils.getKey(block.x, block.y);
      if (this.noEditKey != key) {
        let cells = this.javaBitSetBase64ToBoolean2D(block.encodedCells, this.blockSize, this.blockSize);
        this.blockData.set(key, cells)
      }
    })
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
      this.httpClient.post<Block[]>('/gen-api/client-update', JSON.stringify(new UpdateBlocks(this.clientId, this.blocksToRemove, newActiveBlocks)), {headers: {'Content-Type': 'application/json'}})
        .subscribe((blocks: Block[]) => {
          this.receiveBlockList(blocks);
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


  javaBitSetBase64ToBoolean2D(base64: string, rows: number, cols: number): boolean[][] {

    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const getBit = (bitIndex: number): boolean => {
      const byteIndex = bitIndex >>> 3;
      const bitOffset = bitIndex & 7;

      return ((bytes[byteIndex] >> bitOffset) & 1) === 1;
    };

    const result: boolean[][] = [];
    for (let row = 0; row < rows; row++) {
      result[row] = [];
      for (let col = 0; col < cols; col++) {
        result[row][col] = getBit(row * cols + col);
      }
    }

    return result;
  }
}
