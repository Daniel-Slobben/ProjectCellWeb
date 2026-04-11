import {Injectable, OnDestroy} from '@angular/core';
import {IMessage, RxStomp} from '@stomp/rx-stomp';
import {HttpClient} from '@angular/common/http'
import SockJS from 'sockjs-client';
import {Utils} from './utils.component';
import {UpdateBlocks} from '../../../requests/UpdateBlocks';
import {Block} from '../../../requests/Block';
import {Subscription} from 'rxjs';
import {decompressBlock} from 'lz4js';

@Injectable({providedIn: 'root'})
export class BlockService implements OnDestroy{
  private readonly stompClient: RxStomp;
  private readonly blockData = new Map<string, ImageData | undefined>();

  public blockSize: number = 0;
  public clientId: string = "";
  private generation: number = 0;
  private blocksToRemove: string[] = [];
  private activeBlocks: string[] = [];
  private noEditKey: string | undefined;

  public ctx!: CanvasRenderingContext2D;

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
          this.blockData.set(key, this.getImageData(cells))
      }
    })
    this.generation++;
  }

  public setGhostBlock(key: string, body: boolean[][]) {
    this.blockData.set(key, this.getImageData(body));
    this.setNoEditKeyTrue(key);
  }

  private getImageData(data: boolean[][]): ImageData  {
    // Create a tiny block image (one pixel per cell)
    const imageData = this.ctx.createImageData(this.blockSize, this.blockSize);

    const pixels = imageData.data;

    for (let y = 0; y < this.blockSize; y++) {
      const yCol = y * this.blockSize;
      for (let x = 0; x < this.blockSize; x++) {
        const cell = data?.[x]?.[y];
        const color = cell ? 0: 255; // black or white
        const index = (yCol + x) * 4;
        pixels[index] = color;     // R
        pixels[index + 1] = color; // G
        pixels[index + 2] = color; // B
        pixels[index + 3] = 255;   // A
      }
    }
    return imageData;
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

  getBlock(key: string): ImageData | undefined {
    return this.blockData.get(key);
  }

  setBlock(key: string, data: boolean[][]) {
    this.blockData.set(key, this.getImageData(data));
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
