import {Injectable, OnDestroy} from '@angular/core';
import {IMessage, RxStomp} from '@stomp/rx-stomp';
import {HttpClient} from '@angular/common/http'
import SockJS from 'sockjs-client';
import {Utils} from './utils.component';
import {UpdateBlocks} from '../../../requests/UpdateBlocks';
import {v4 as uuidv4} from 'uuid';
import {Block} from '../../../requests/Block';
import {Subscription} from 'rxjs';
import {decompressBlock} from 'lz4js';

@Injectable({providedIn: 'root'})
export class BlockService implements OnDestroy{
  private readonly stompClient: RxStomp;
  private readonly blockData = new Map<string, boolean[][] | undefined>();

  public blockSize: number = 0;
  public clientId: string = "";
  private generation: number = 0;
  private blocksToRemove: string[] = [];
  private activeBlocks: string[] = [];
  private noEditKey: string | undefined;

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

    this.subscription = this.stompClient.connected$.subscribe(() => {
      console.log('Connected to WebSocket');
    });

  }

  public setupWebSocket() {
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
          let cells = this.decodeLz4Block(block.encodedCells, this.blockSize);
          this.blockData.set(key, cells)
      }
    })
    this.generation++;
  }

  public setGhostBlock(key: string, body: boolean[][]) {
    this.blockData.set(key, body);
    this.setNoEditKeyTrue(key);
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
    if (b) {
      this.setNoEditKeyTrue(this.utils.getKey(x, y));
    } else {
      this.noEditKey = undefined;
    }

  }

  setNoEditKeyTrue(key: string) {
    this.noEditKey = key;
  }

  private decodeLz4Block(encodedCells: string, blockSize: number): boolean[][] {
    // Step 1: Base64 → Uint8Array
    const binaryString = atob(encodedCells);
    const compressedBytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      compressedBytes[i] = binaryString.charCodeAt(i);
    }

    // Step 2: LZ4 decompress (sync!)
    const expectedBytes = Math.ceil(blockSize * blockSize / 8);

    const output = new Uint8Array(expectedBytes);
    decompressBlock(compressedBytes, output, 0, compressedBytes.length, 0);

    // Step 3: Read bits (same as before)
    const getBit = (bitIndex: number): boolean => {
      const byteIndex = bitIndex >>> 3;
      const bitOffset = bitIndex & 7;
      return ((output[byteIndex] >> bitOffset) & 1) === 1;
    };

    const result: boolean[][] = [];
    for (let row = 0; row < blockSize; row++) {
      result[row] = [];
      for (let col = 0; col < blockSize; col++) {
        result[row][col] = getBit(row * blockSize + col);
      }
    }

    return result;
  }

}
